"""
Face ID worker process.

Reads frames from shared memory, detects faces with InsightFace, labels them
from local face memory, and accepts small command messages such as
remember_person/forget_person from the main Gemini tool handler.
"""

from __future__ import annotations

import queue
import time
from multiprocessing import Queue

from config import (
    FACE_DET_SIZE,
    FACE_MATCH_THRESHOLD,
    FACE_MAX_DESCRIPTORS,
    FACE_MEMORY_DIR,
    MAX_ROSTER_PING_RATE,
    TRACK_GRACE_PERIOD_SEC,
)
from face_memory import FaceMemoryStore
from shared_camera import FrameReader


class FaceIDWorker:
    def __init__(self, high_freq_q: Queue, low_freq_q: Queue, command_q: Queue, result_q: Queue):
        self.high_freq_q = high_freq_q
        self.low_freq_q = low_freq_q
        self.command_q = command_q
        self.result_q = result_q
        self.running = True

        self.memory = FaceMemoryStore(FACE_MEMORY_DIR, max_descriptors=FACE_MAX_DESCRIPTORS)
        self.latest_embedding = None
        self.latest_label = None
        self.current_presence = None
        self.last_presence_ping = 0.0
        self.last_face_seen_at = 0.0

    def run(self):
        try:
            from insightface.app import FaceAnalysis
        except ImportError:
            print("insightface not installed, FaceIDWorker exiting.")
            return

        reader = FrameReader()
        app = FaceAnalysis(name="buffalo_l", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        app.prepare(ctx_id=0, det_size=(FACE_DET_SIZE, FACE_DET_SIZE))

        while self.running:
            self._drain_commands()

            frame = reader.read_latest()
            if frame is None:
                self._maybe_emit_departure()
                time.sleep(0.01)
                continue

            faces = app.get(frame)
            now = time.time()

            if faces:
                self.last_face_seen_at = now
                self._publish_faces(faces, now)
            else:
                self._publish_boxes([])
                self._maybe_emit_departure()

    def _publish_faces(self, faces, now: float) -> None:
        bboxes = []
        primary_label = None

        for face in faces:
            name, confidence = self.memory.identify(face.normed_embedding, FACE_MATCH_THRESHOLD)
            is_unknown = name is None
            label = name or "unknown"

            bboxes.append({
                "box": face.bbox.astype(int).tolist(),
                "name": label,
                "confidence": round(confidence, 3) if confidence >= 0 else None,
                "is_unknown": is_unknown,
            })

            if primary_label is None:
                primary_label = label
                self.latest_label = label
                self.latest_embedding = face.normed_embedding

        self._publish_boxes(bboxes)
        if primary_label:
            self._maybe_emit_arrival(primary_label, bboxes[0].get("is_unknown", False), now)

    def _publish_boxes(self, bboxes: list[dict]) -> None:
        try:
            while not self.high_freq_q.empty():
                self.high_freq_q.get_nowait()
            self.high_freq_q.put_nowait(bboxes)
        except queue.Full:
            pass

    def _maybe_emit_arrival(self, label: str, is_unknown: bool, now: float) -> None:
        if label == self.current_presence:
            return
        if now - self.last_presence_ping < MAX_ROSTER_PING_RATE:
            return

        event_type = "unknown_arrival" if is_unknown else "arrival"
        event = {"type": event_type, "name": label, "is_unknown": is_unknown}
        if not is_unknown:
            notes = self.memory.notes_for(label)
            if notes:
                event["notes"] = notes

        try:
            self.low_freq_q.put_nowait(event)
            self.current_presence = label
            self.last_presence_ping = now
        except queue.Full:
            pass

    def _maybe_emit_departure(self) -> None:
        if not self.current_presence:
            return
        if time.time() - self.last_face_seen_at < TRACK_GRACE_PERIOD_SEC:
            return
        try:
            self.low_freq_q.put_nowait({"type": "departure", "name": self.current_presence})
        except queue.Full:
            pass
        self.current_presence = None
        self.latest_label = None
        self.latest_embedding = None

    def _drain_commands(self) -> None:
        while True:
            try:
                cmd = self.command_q.get_nowait()
            except queue.Empty:
                return

            command_id = cmd.get("id")
            action = cmd.get("action")
            try:
                if action == "remember_person":
                    result = self._remember_person(cmd)
                elif action == "remember_fact":
                    result = self.memory.remember_fact(self.latest_label, cmd.get("fact", ""))
                elif action == "forget_person":
                    result = self.memory.forget_person(cmd.get("name", ""))
                    if result.get("status") == "success" and result.get("forgot") == self.latest_label:
                        self.latest_label = "unknown"
                else:
                    result = {"status": "error", "reason": f'unknown face command "{action}"'}
            except Exception as exc:  # noqa: BLE001
                result = {"status": "error", "reason": str(exc)}

            try:
                self.result_q.put_nowait({"id": command_id, "result": result})
            except queue.Full:
                pass

    def _remember_person(self, cmd: dict) -> dict:
        if self.latest_embedding is None:
            return {
                "status": "error",
                "reason": "no face clearly visible right now - ask them to face the camera",
            }

        result = self.memory.remember_person(cmd.get("name", ""), self.latest_embedding)
        if result.get("status") == "success":
            self.latest_label = result["remembered"]
            self.current_presence = None
            self._publish_boxes([])
        return result


def run_worker(high_freq_q: Queue, low_freq_q: Queue, command_q: Queue, result_q: Queue):
    worker = FaceIDWorker(high_freq_q, low_freq_q, command_q, result_q)
    worker.run()
