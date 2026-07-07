"""
Shared Memory Camera Broker

Captures frames from the camera in a dedicated process and writes them to a
double-buffered shared memory block guarded by a sequence lock. This allows
multiple consumers (e.g. Gemini cognitive core, Face ID worker) to read frames
with zero-copy and without blocking.
"""

from __future__ import annotations

import struct
import sys
import time
from multiprocessing import shared_memory
import numpy as np

from config import VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_CAPTURE_FPS

# First 8 bytes: unsigned long long sequence counter
# Next 4 bytes: width
# Next 4 bytes: height
# Rest: BGR pixels (height * width * 3)
HEADER_FMT = "=QII"
HEADER_SIZE = struct.calcsize(HEADER_FMT)

def get_shared_memory_size():
    return HEADER_SIZE + (VIDEO_WIDTH * VIDEO_HEIGHT * 3)

class FrameBroker:
    def __init__(self, name="RobotCameraSM"):
        self.name = name
        self.size = get_shared_memory_size()
        self.shm = None
        self._cap = None
        self._cv2 = None

        try:
            import cv2
            self._cv2 = cv2
        except ImportError:
            pass

    def run(self):
        if not self._cv2:
            print("OpenCV not installed, FrameBroker exiting.")
            return

        try:
            self.shm = shared_memory.SharedMemory(name=self.name, create=True, size=self.size)
        except FileExistsError:
            self.shm = shared_memory.SharedMemory(name=self.name)

        cv2 = self._cv2
        # On Windows, DirectShow grabs faster than the default MSMF backend and
        # actually honors BUFFERSIZE. Fall back to CAP_ANY elsewhere.
        backend = cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY
        cap = cv2.VideoCapture(0, backend)
        if not cap.isOpened():
            print("Camera failed to open, FrameBroker exiting.")
            return

        # MJPG before size/fps: most USB webcams are USB-bandwidth-limited to
        # ~10-15 fps in uncompressed YUY2 at 640x480, but deliver a full 30 fps
        # in MJPG. This is the single biggest win against choppy video.
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, VIDEO_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, VIDEO_HEIGHT)
        # Ask the driver for our target rate and — critically — a 1-frame
        # internal buffer. Without this OpenCV queues frames faster than we
        # publish them, so consumers read stale frames (the "buffering" lag).
        cap.set(cv2.CAP_PROP_FPS, VIDEO_CAPTURE_FPS)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        interval = 1.0 / max(1, VIDEO_CAPTURE_FPS)
        seq = 0

        try:
            while True:
                start_t = time.time()
                ret, frame = cap.read()
                if ret:
                    h, w, _ = frame.shape

                    # Seqlock writer: odd means writing
                    seq += 1
                    struct.pack_into(HEADER_FMT, self.shm.buf, 0, seq, w, h)

                    # Copy pixels
                    frame_bytes = frame.tobytes()
                    self.shm.buf[HEADER_SIZE:HEADER_SIZE + len(frame_bytes)] = frame_bytes

                    # Seqlock writer: even means finished
                    seq += 1
                    struct.pack_into(HEADER_FMT, self.shm.buf, 0, seq, w, h)

                elapsed = time.time() - start_t
                sleep_t = interval - elapsed
                if sleep_t > 0:
                    time.sleep(sleep_t)
        except KeyboardInterrupt:
            pass
        finally:
            cap.release()
            self.shm.close()
            self.shm.unlink()


class FrameReader:
    def __init__(self, name="RobotCameraSM"):
        self.name = name
        self.shm = None
        self.last_seq = 0

    def connect(self):
        if self.shm is None:
            try:
                self.shm = shared_memory.SharedMemory(name=self.name)
            except FileNotFoundError:
                return False
        return True

    def read_latest(self):
        if not self.connect():
            return None

        for _ in range(5):  # Max retries
            seq, w, h = struct.unpack_from(HEADER_FMT, self.shm.buf, 0)

            if seq % 2 != 0:
                # Writer is currently writing, wait
                time.sleep(0.001)
                continue

            if seq == self.last_seq:
                # No new frame
                return None

            frame_size = w * h * 3
            frame_bytes = bytes(self.shm.buf[HEADER_SIZE:HEADER_SIZE + frame_size])

            seq_after, _, _ = struct.unpack_from(HEADER_FMT, self.shm.buf, 0)
            if seq != seq_after:
                # Torn read, retry
                continue

            self.last_seq = seq
            frame = np.frombuffer(frame_bytes, dtype=np.uint8).reshape((h, w, 3))
            return frame

        return None

    def close(self):
        if self.shm:
            self.shm.close()
            self.shm = None
