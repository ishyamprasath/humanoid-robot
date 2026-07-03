"""
Camera feed — the robot's eyes.

Captures JPEG frames with OpenCV at VIDEO_FPS. Frames go two places:
up to Gemini as vision input, and out to the display client so the 8"
screen can show what the robot sees. Silently disables itself if
opencv isn't installed or no camera is present.
"""

from __future__ import annotations

import asyncio

from config import (VIDEO_ENABLED, VIDEO_FPS, VIDEO_HEIGHT,
                    VIDEO_JPEG_QUALITY, VIDEO_WIDTH)


class CameraFeed:
    def __init__(self):
        self.enabled = False
        self._cap = None
        self._cv2 = None
        if not VIDEO_ENABLED:
            return
        try:
            import cv2  # type: ignore
        except ImportError:
            return
        cap = cv2.VideoCapture(0, cv2.CAP_ANY)
        if not cap or not cap.isOpened():
            return
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, VIDEO_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, VIDEO_HEIGHT)
        self._cv2 = cv2
        self._cap = cap
        self.enabled = True

    async def frames(self):
        """Async generator of raw JPEG bytes at VIDEO_FPS."""
        if not self.enabled:
            return
        cv2 = self._cv2
        interval = 1.0 / max(1, VIDEO_FPS)
        loop = asyncio.get_running_loop()
        try:
            while self.enabled and self._cap is not None:
                # cv2 read blocks — run in executor to keep the loop live
                ok_frame = await loop.run_in_executor(None, self._cap.read)
                ok, frame = ok_frame
                if ok:
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
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None
        self.enabled = False
