"""
Robot — cognitive core entry point.

    cd backend
    python main.py            # display controls power via the UI
    python main.py --auto     # brain powers on immediately

Python owns everything cognitive: the Gemini Live session, system mic
and speaker, camera, tool execution, task state, and the NVIDIA text
fallback. The browser on the robot's 8" display is a thin client that
renders whatever this process broadcasts over WebSocket — and later the
Robot executor is swapped for a ROS 2 Jazzy adapter with zero changes
to any of the AI code.

Vision runs in two dedicated processes: a FrameBroker that publishes the
webcam into shared memory, and a face worker that reads those frames and
emits detection boxes + a presence roster over IPC queues.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import queue
import sys
import time
import traceback
import multiprocessing as mp
import uuid

# On Windows the console defaults to cp1252, which can't encode the emoji
# used in the startup banner and logs. Force UTF-8 so prints never crash.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from shared_camera import FrameBroker
from face_worker import run_worker

from audio_io import MicCapture, SpeakerPlayer
from brain_fallback import FallbackBrain
from brain_live import GeminiLiveBrain
from config import (FACE_COMMAND_TIMEOUT_SEC, GEMINI_API_KEY, GEMINI_MODEL,
                    HTTP_PORT, VIDEO_DISPLAY_FPS, VOICE_NAME, WS_PORT)
from hardware_bridge import HardwareBridge
from robot import Robot
from state_server import StateServer
from video_io import CameraFeed


class Core:
    def __init__(
        self,
        high_q: mp.Queue | None = None,
        low_q: mp.Queue | None = None,
        face_command_q: mp.Queue | None = None,
        face_result_q: mp.Queue | None = None,
    ):
        self.server = StateServer(on_command=self.handle_command)
        self.bridge = HardwareBridge(on_log=self.log)
        self.robot = Robot(on_action=self._on_action, on_state=self._on_robot_state)
        self.fallback = FallbackBrain()
        self.high_freq_q = high_q      # face detection boxes (fast)
        self.low_freq_q = low_q        # roster arrivals/departures (slow)
        self.face_command_q = face_command_q
        self.face_result_q = face_result_q
        self._pending_face_results = {}
        self.roster_cache = set()

        self.brain: GeminiLiveBrain | None = None
        self.brain_task: asyncio.Task | None = None
        self.mic: MicCapture | None = None
        self.speaker: SpeakerPlayer | None = None

        # The display loop is the single JPEG-encoding reader of the shared
        # camera. It broadcasts frames to the display and stashes the latest
        # one so the brain can sample it for Gemini. The "Camera On" button
        # gates the preview; the broker keeps capturing regardless.
        self._camera_on = True
        self._latest_jpeg: bytes | None = None

        self._last_level_sent = 0.0
        self._loop: asyncio.AbstractEventLoop | None = None

    # ============================================================
    # Broadcast helpers
    # ============================================================
    def log(self, text: str):
        print(f"[{time.strftime('%H:%M:%S')}] {text}", flush=True)
        self.server.broadcast({"type": "log", "text": text, "ts": time.time()})

    def status(self, state: str, detail: str = ""):
        self.server.broadcast({"type": "status", "state": state, "detail": detail})

    def _on_action(self, name: str, args: dict, result: dict):
        self.bridge.send(name, args)
        self.server.broadcast({
            "type": "action", "name": name, "args": args,
            "result": result, "ts": time.time(),
        })
        ok = result.get("status") == "success"
        self.log(f"ACTION {name} {'ok' if ok else 'REJECTED: ' + str(result.get('reason'))}")

    def _on_robot_state(self, snapshot: dict):
        self.server.broadcast({"type": "robot", **snapshot})

    def _on_mic_level(self, rms: float):
        now = time.monotonic()
        if now - self._last_level_sent > 0.1:  # ~10 Hz
            self._last_level_sent = now
            self.server.broadcast({"type": "mic_level", "rms": round(rms, 4)})

    def _on_video_frame(self, jpeg: bytes):
        self.server.broadcast({
            "type": "frame",
            "jpeg_b64": base64.b64encode(jpeg).decode("ascii"),
        })

    # ============================================================
    # Display commands
    # ============================================================
    async def handle_command(self, cmd: dict):
        kind = cmd.get("type")
        if kind == "power":
            if cmd.get("on"):
                await self.power_on()
            else:
                await self.power_off()
        elif kind == "mute":
            if self.mic:
                self.mic.set_muted(bool(cmd.get("muted")))
                self.log(f"mic {'muted' if self.mic.muted else 'live'}")
        elif kind == "camera_toggle":
            self._camera_on = bool(cmd.get("enabled"))
            if not self._camera_on:
                self._latest_jpeg = None
            self.log(f"camera {'on' if self._camera_on else 'off'}")
            self.server.broadcast({"type": "camera_state", "enabled": self._camera_on})
        elif kind == "text":
            text = str(cmd.get("text") or "").strip()
            if not text:
                return
            self.server.broadcast({"type": "transcript", "role": "user", "text": text})
            self.server.broadcast({"type": "turn_complete"})
            if self.brain and self.brain_task and not self.brain_task.done():
                self.brain.send_text(text)
            else:
                asyncio.create_task(self._fallback_reply(text))

    async def _fallback_reply(self, text: str):
        try:
            reply = await self.fallback.reply(text)
        except Exception as e:  # noqa: BLE001
            reply = f"(backup core error: {e})"
        self.server.broadcast({"type": "transcript", "role": "robot", "text": reply})
        self.server.broadcast({"type": "turn_complete"})

    # ============================================================
    # Brain lifecycle
    # ============================================================
    async def power_on(self):
        if self.brain_task and not self.brain_task.done():
            return
        if not GEMINI_API_KEY:
            self.status("error", "GEMINI_API_KEY missing — copy .env.example to .env")
            self.log("GEMINI_API_KEY missing. Text fallback only.")
            return
        self.status("connecting", "waking up…")
        self.brain_task = asyncio.create_task(self._run_brain(), name="brain")

    async def power_off(self):
        if self.brain_task:
            self.brain_task.cancel()
            try:
                await self.brain_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self.brain_task = None
        self.status("offline", "asleep")
        self.log("cognitive core shut down")

    async def _run_brain(self):
        assert self._loop is not None
        mic_q: asyncio.Queue[bytes] = asyncio.Queue(maxsize=200)

        self.speaker = SpeakerPlayer(
            on_speaking=lambda s: self.server.broadcast({"type": "speaking", "active": s}),
        )
        self.mic = MicCapture(mic_q, self._loop, on_level=self._on_mic_level)

        def _handle_tool_call(name: str, args: dict):
            if name == "get_visible_people":
                return {"people": sorted(self.roster_cache)}
            if name == "remember_person":
                return self._face_command("remember_person", name=args.get("name", ""))
            if name == "remember_fact":
                return self._face_command("remember_fact", fact=args.get("fact", ""))
            if name == "forget_person":
                return self._face_command("forget_person", name=args.get("name", ""))
            return self.robot.execute(name, args)

        self.brain = GeminiLiveBrain(
            mic_queue=mic_q,
            on_audio=lambda pcm: self.speaker.enqueue(pcm),
            on_tool_call=_handle_tool_call,
            on_input_transcript=lambda t: self.server.broadcast(
                {"type": "transcript", "role": "user", "text": t}),
            on_output_transcript=lambda t: self.server.broadcast(
                {"type": "transcript", "role": "robot", "text": t}),
            on_interrupted=self._on_interrupted,
            on_turn_complete=lambda: self.server.broadcast({"type": "turn_complete"}),
            on_log=self.log,
            video_frame_provider=lambda: self._latest_jpeg,
        )
        self._queue_visible_people_context()

        try:
            self.mic.start()
            self.log("microphone hot")
            self.status("online", f"{GEMINI_MODEL} · voice {VOICE_NAME}")
            await self.brain.run()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self.status("error", str(e))
            self.log(f"brain error: {e}")
            traceback.print_exc(file=sys.stderr)
        finally:
            if self.mic:
                self.mic.stop()
                self.mic = None
            if self.speaker:
                self.speaker.stop()
                self.speaker = None
            self.brain = None

    def _queue_visible_people_context(self):
        if not self.brain or not self.roster_cache:
            return
        if "unknown" in self.roster_cache:
            self.brain.send_text(
                "[VISION] An unfamiliar person is already in view. Greet them warmly, "
                "ask for their name, and once they answer call remember_person with that "
                "name if their face is still visible."
            )
            return

        people = sorted(self.roster_cache)
        if people:
            self.brain.send_text(
                f"[VISION] Currently visible: {', '.join(people)}. Greet them by name, "
                "briefly and naturally."
            )

    def _on_interrupted(self):
        if self.speaker:
            self.speaker.interrupt()
        self.server.broadcast({"type": "interrupted"})

    def _face_command(self, action: str, **payload) -> dict:
        """Send a command to the face worker and wait briefly for its result."""
        if self.face_command_q is None or self.face_result_q is None:
            return {"status": "error", "reason": "face memory worker is not running"}

        command_id = uuid.uuid4().hex
        try:
            self.face_command_q.put_nowait({"id": command_id, "action": action, **payload})
        except queue.Full:
            return {"status": "error", "reason": "face memory worker is busy"}

        deadline = time.monotonic() + FACE_COMMAND_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if command_id in self._pending_face_results:
                return self._pending_face_results.pop(command_id)
            try:
                msg = self.face_result_q.get(timeout=0.1)
            except queue.Empty:
                continue

            result_id = msg.get("id")
            result = msg.get("result", {"status": "error", "reason": "empty face worker response"})
            if result_id == command_id:
                if action == "remember_person" and result.get("status") == "success":
                    name = result.get("remembered")
                    if name:
                        self.roster_cache.discard("unknown")
                        self.roster_cache.add(name)
                        self.server.broadcast({"type": "roster", "people": sorted(self.roster_cache)})
                return result
            self._pending_face_results[result_id] = result

        return {"status": "error", "reason": "face memory worker timed out"}

    # ============================================================
    # Vision — camera preview + face worker fan-in
    # ============================================================
    async def _video_display_loop(self):
        """Stream the shared camera to the display at VIDEO_DISPLAY_FPS.

        Runs independently of the brain, so the preview is smooth and shows
        up the moment the broker has frames — no need to Power On first.
        read_latest simply returns None until the FrameBroker's shared memory
        exists, so this reconnects on its own.
        """
        feed = CameraFeed()
        if not feed.enabled:
            return
        try:
            async for jpeg in feed.frames(VIDEO_DISPLAY_FPS):
                if not self._camera_on:
                    self._latest_jpeg = None
                    continue
                self._latest_jpeg = jpeg
                self._on_video_frame(jpeg)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self.log(f"display video loop error: {e}")
        finally:
            feed.stop()

    async def _vision_queue_listener(self):
        """Fan face-detection boxes out to the display as they arrive."""
        if not self.high_freq_q:
            return
        loop = asyncio.get_running_loop()
        while True:
            try:
                bboxes = await loop.run_in_executor(None, self.high_freq_q.get)
                if self._camera_on:
                    self.server.broadcast({"type": "vision_bboxes", "bboxes": bboxes})
            except Exception:
                await asyncio.sleep(0.1)

    async def _roster_queue_listener(self):
        """Track who is present and nudge the brain on arrivals/departures."""
        if not self.low_freq_q:
            return
        loop = asyncio.get_running_loop()
        while True:
            try:
                event = await loop.run_in_executor(None, self.low_freq_q.get)
                name = event.get("name")
                if event.get("type") == "unknown_arrival":
                    self.roster_cache.add("unknown")
                    if self.brain and self.brain_task and not self.brain_task.done():
                        self.brain.send_text(
                            "[VISION] An unfamiliar person is in view. Greet them warmly, "
                            "ask for their name, and once they answer call remember_person "
                            "with that name if their face is still visible."
                        )
                elif event.get("type") == "arrival":
                    self.roster_cache.add(name)
                    if self.brain and self.brain_task and not self.brain_task.done():
                        notes = event.get("notes") or []
                        note_text = f" Known notes: {'; '.join(notes)}." if notes else ""
                        self.brain.send_text(
                            f"[VISION] {name} has arrived.{note_text} Greet them by name, "
                            "briefly and naturally."
                        )
                elif event.get("type") == "departure":
                    self.roster_cache.discard(name)
                    if self.brain and self.brain_task and not self.brain_task.done():
                        self.brain.send_text(f"[VISION] {name} has departed.")
                self.server.broadcast({"type": "roster", "people": sorted(self.roster_cache)})
            except Exception:
                await asyncio.sleep(0.1)

    # ============================================================
    async def run(self, autostart: bool):
        self._loop = asyncio.get_running_loop()

        if self.high_freq_q:
            asyncio.create_task(self._vision_queue_listener(), name="vision_q")
        if self.low_freq_q:
            asyncio.create_task(self._roster_queue_listener(), name="roster_q")
        asyncio.create_task(self._video_display_loop(), name="video_display")

        await self.server.start()
        self.status("offline", "asleep")
        self._on_robot_state(self.robot.snapshot())
        self.server.broadcast({"type": "camera_state", "enabled": self._camera_on})
        print()
        print("  🤖 Robot Cognitive Core (Python)")
        print(f"  ➜  Display UI:   http://localhost:{HTTP_PORT}")
        print(f"  ➜  State stream: ws://localhost:{WS_PORT}")
        print(f"  ➜  Brain:        {GEMINI_MODEL} · voice {VOICE_NAME}")
        print()
        if autostart:
            await self.power_on()
        else:
            print("  Waiting for Power On from the display…")
        await asyncio.Event().wait()  # run forever


def _run_broker():
    FrameBroker().run()


def main():
    parser = argparse.ArgumentParser(description="Robot cognitive core")
    parser.add_argument("--auto", action="store_true", help="power the brain on at launch")
    args = parser.parse_args()

    mp.set_start_method('spawn', force=True)
    high_q = mp.Queue(maxsize=10)
    low_q = mp.Queue(maxsize=50)
    face_command_q = mp.Queue(maxsize=20)
    face_result_q = mp.Queue(maxsize=20)

    broker_proc = mp.Process(target=_run_broker, daemon=True)
    worker_proc = mp.Process(
        target=run_worker,
        args=(high_q, low_q, face_command_q, face_result_q),
        daemon=True,
    )

    broker_proc.start()
    worker_proc.start()

    try:
        core = Core(
            high_q=high_q,
            low_q=low_q,
            face_command_q=face_command_q,
            face_result_q=face_result_q,
        )
        asyncio.run(core.run(autostart=args.auto))
    except KeyboardInterrupt:
        print("\nshutdown. bye 👋")
    finally:
        broker_proc.terminate()
        worker_proc.terminate()


if __name__ == "__main__":
    main()
