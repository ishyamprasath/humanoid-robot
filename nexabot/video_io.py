"""
Separate OpenCV camera window plus lightweight object coordinate tracking.

The terminal remains the control surface. This module owns the camera window
and exposes the latest detected coordinates so nexabot.py can print them in
strict JSON task output.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from typing import Any

from config import (
    CAMERA_WINDOW_NAME,
    VIDEO_ENABLED,
    VIDEO_HEIGHT,
    VIDEO_WIDTH,
)


@dataclass
class Detection:
    label: str
    color: str
    pixel_x: int
    pixel_y: int
    normalized_x: float
    normalized_y: float
    estimated_z_m: float
    bbox: dict[str, int]
    area_px: float
    confidence: float
    timestamp: float

    def to_json(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "color": self.color,
            "coordinates": {
                "x": self.normalized_x,
                "y": self.normalized_y,
                "z": self.estimated_z_m,
                "pixel_x": self.pixel_x,
                "pixel_y": self.pixel_y,
                "bbox": self.bbox,
            },
            "confidence": self.confidence,
            "timestamp": round(self.timestamp, 3),
        }


class CameraWindow:
    """Runs a live camera preview in its own thread and tracks coordinates."""

    COLOR_RANGES = {
        "red": [((0, 80, 60), (10, 255, 255)), ((170, 80, 60), (180, 255, 255))],
        "orange": [((11, 80, 60), (24, 255, 255))],
        "yellow": [((25, 70, 70), (38, 255, 255))],
        "green": [((39, 50, 50), (85, 255, 255))],
        "blue": [((90, 50, 50), (130, 255, 255))],
        "purple": [((131, 45, 45), (160, 255, 255))],
        "white": [((0, 0, 190), (180, 45, 255))],
        "black": [((0, 0, 0), (180, 255, 55))],
    }

    def __init__(self, on_log=None):
        self.on_log = on_log or (lambda message: None)
        self.enabled = False
        self._running = False
        self._thread: threading.Thread | None = None
        self._cap = None
        self._cv2 = None
        self._lock = threading.Lock()
        self._detections: list[Detection] = []
        self._frame_size = {"width": VIDEO_WIDTH, "height": VIDEO_HEIGHT}

    def start(self) -> bool:
        if not VIDEO_ENABLED:
            self.on_log("camera disabled by config")
            return False
        try:
            import cv2  # type: ignore
        except ImportError:
            self.on_log("opencv-python is not installed; camera window unavailable")
            return False

        cap = cv2.VideoCapture(0, cv2.CAP_ANY)
        if not cap or not cap.isOpened():
            self.on_log("no camera found; continuing terminal-only")
            return False

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, VIDEO_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, VIDEO_HEIGHT)
        self._cv2 = cv2
        self._cap = cap
        self._running = True
        self.enabled = True
        self._thread = threading.Thread(target=self._camera_loop, daemon=True)
        self._thread.start()
        self.on_log(f'camera window opened: "{CAMERA_WINDOW_NAME}"')
        return True

    def snapshot(self, target_text: str = "") -> dict[str, Any]:
        """Return the best current detection for a terminal task."""
        target = target_text.lower()
        with self._lock:
            detections = list(self._detections)
            frame_size = dict(self._frame_size)

        if not detections:
            return {
                "visible": False,
                "reason": "no_object_detected",
                "frame": frame_size,
                "coordinates": None,
            }

        color_hint = next((c for c in self.COLOR_RANGES if c in target), None)
        if color_hint:
            matches = [d for d in detections if d.color == color_hint]
            if matches:
                return {"visible": True, "frame": frame_size, **matches[0].to_json()}
            return {
                "visible": False,
                "reason": f"{color_hint}_object_not_detected",
                "frame": frame_size,
                "coordinates": None,
            }

        best = detections[0]
        return {"visible": True, "frame": frame_size, **best.to_json()}

    def detections_json(self) -> list[dict[str, Any]]:
        with self._lock:
            return [d.to_json() for d in self._detections]

    def stop(self):
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
        if self._cv2 is not None:
            try:
                self._cv2.destroyWindow(CAMERA_WINDOW_NAME)
            except Exception:
                pass
        self.enabled = False

    def _camera_loop(self):
        assert self._cap is not None
        assert self._cv2 is not None
        cv2 = self._cv2

        while self._running:
            ok, frame = self._cap.read()
            if not ok:
                time.sleep(0.05)
                continue

            h, w = frame.shape[:2]
            detections = self._detect(frame)
            with self._lock:
                self._detections = detections
                self._frame_size = {"width": w, "height": h}

            self._draw_overlay(frame, detections)
            cv2.imshow(CAMERA_WINDOW_NAME, frame)
            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                self._running = False

        self._running = False

    def _detect(self, frame) -> list[Detection]:
        cv2 = self._cv2
        assert cv2 is not None
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        h, w = frame.shape[:2]
        frame_area = max(1, w * h)
        min_area = max(350, frame_area * 0.002)
        detections: list[Detection] = []

        for color, ranges in self.COLOR_RANGES.items():
            mask = None
            for lower, upper in ranges:
                part = cv2.inRange(hsv, lower, upper)
                mask = part if mask is None else cv2.bitwise_or(mask, part)
            if mask is None:
                continue

            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                continue

            contour = max(contours, key=cv2.contourArea)
            area = float(cv2.contourArea(contour))
            if area < min_area:
                continue

            x, y, bw, bh = cv2.boundingRect(contour)
            cx = x + bw // 2
            cy = y + bh // 2
            z = self._estimate_depth_m(area, frame_area)
            confidence = min(0.99, max(0.1, area / (frame_area * 0.25)))
            detections.append(
                Detection(
                    label=f"{color} object",
                    color=color,
                    pixel_x=int(cx),
                    pixel_y=int(cy),
                    normalized_x=round(cx / max(1, w - 1), 3),
                    normalized_y=round(cy / max(1, h - 1), 3),
                    estimated_z_m=z,
                    bbox={"x": int(x), "y": int(y), "width": int(bw), "height": int(bh)},
                    area_px=round(area, 1),
                    confidence=round(confidence, 2),
                    timestamp=time.time(),
                )
            )

        return sorted(detections, key=lambda d: d.area_px, reverse=True)

    def _estimate_depth_m(self, area: float, frame_area: int) -> float:
        area_ratio = max(0.0001, min(1.0, area / frame_area))
        near_factor = min(1.0, math.sqrt(area_ratio) * 3.0)
        return round(max(0.2, min(2.0, 2.0 - near_factor * 1.8)), 2)

    def _draw_overlay(self, frame, detections: list[Detection]):
        cv2 = self._cv2
        assert cv2 is not None
        for detection in detections[:5]:
            box = detection.bbox
            x, y, w, h = box["x"], box["y"], box["width"], box["height"]
            cv2.rectangle(frame, (x, y), (x + w, y + h), (40, 230, 40), 2)
            cv2.drawMarker(
                frame,
                (detection.pixel_x, detection.pixel_y),
                (0, 255, 255),
                markerType=cv2.MARKER_CROSS,
                markerSize=18,
                thickness=2,
            )
            label = (
                f"{detection.label} "
                f"x={detection.normalized_x:.3f} "
                f"y={detection.normalized_y:.3f} "
                f"z={detection.estimated_z_m:.2f}m"
            )
            cv2.putText(
                frame,
                label,
                (x, max(22, y - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (0, 255, 255),
                1,
                cv2.LINE_AA,
            )

        cv2.putText(
            frame,
            "NexaBot camera - press q in this window to close",
            (12, 24),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            1,
            cv2.LINE_AA,
        )
