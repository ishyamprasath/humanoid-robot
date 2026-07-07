"""
Camera feed — the robot's eyes.

Reads raw BGR frames from shared memory (populated by the FrameBroker),
encodes them to JPEG, and yields them at VIDEO_FPS. Frames go two places:
up to Gemini as vision input, and out to the display client.
"""

from __future__ import annotations

import asyncio

from config import (VIDEO_ENABLED, VIDEO_FPS, VIDEO_JPEG_QUALITY)
from shared_camera import FrameReader


class CameraFeed:
    def __init__(self):
        self.enabled = False
        self._reader = None
        self._cv2 = None
        if not VIDEO_ENABLED:
            return
        try:
            import cv2  # type: ignore
        except ImportError:
            return
            
        self._cv2 = cv2
        self._reader = FrameReader()
        self.enabled = True

    async def frames(self):
        """Async generator of raw JPEG bytes at VIDEO_FPS."""
        if not self.enabled:
            return
            
        cv2 = self._cv2
        interval = 1.0 / max(1, VIDEO_FPS)
        loop = asyncio.get_running_loop()
        
        try:
            while self.enabled and self._reader is not None:
                # read_latest checks for torn reads and reads from shared memory
                frame = await loop.run_in_executor(None, self._reader.read_latest)
                if frame is not None:
                    enc = await loop.run_in_executor(
                        None,
                        lambda: cv2.imencode(".jpg", frame,
                                             [int(cv2.IMWRITE_JPEG_QUALITY), VIDEO_JPEG_QUALITY]),
                    )
                    if enc[0]:
                        yield bytes(enc[1])
                await asyncio.sleep(interval)
        finally:
            self.stop()

    def stop(self):
        if self._reader is not None:
            self._reader.close()
            self._reader = None
        self.enabled = False
