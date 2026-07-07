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
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import sys
import time
import traceback
import multiprocessing as mp

from shared_camera import FrameBroker
from face_worker import run_worker

from audio_io import MicCapture, SpeakerPlayer
from brain_fallback import FallbackBrain
from brain_live import GeminiLiveBrain
from config import GEMINI_API_KEY, GEMINI_MODEL, HTTP_PORT, VOICE_NAME, WS_PORT
from hardware_bridge import HardwareBridge
from robot import Robot
from state_server import StateServer
from video_io import CameraFeed


class Core:
    def __init__(self, high_q: mp.Queue | None = None, low_q: mp.Queue | None = None):
        self.server = StateServer(on_command=self.handle_command)
        self.bridge = HardwareBridge(on_log=self.log)
        self.robot = Robot(on_action=self._on_action, on_state=self._on_robot_state)
        self.fallback = FallbackBrain()
        self.high_freq_q = high_q
        self.low_freq_q = low_q
        self.roster_cache = set()

        self.brain: GeminiLiveBrain | None = None
        self.brain_task: asyncio.Task | None = None
        self.mic: MicCapture | None = None
        self.speaker: SpeakerPlayer | None = None
        self.camera: CameraFeed | None = None

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
        self.camera = CameraFeed()

        def _handle_tool_call(name: str, args: dict):
            if name == "get_visible_people":
                if not self.roster_cache:
                    return {"people": []}
                return {"people": list(self.roster_cache)}
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
            on_video_frame=self._on_video_frame,
            video_source=self.camera,
        )

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
            if self.camera:
                self.camera.stop()
                self.camera = None
            self.brain = None

    def _on_interrupted(self):
        if self.speaker:
            self.speaker.interrupt()
        self.server.broadcast({"type": "interrupted"})

    # ============================================================
    async def _roster_queue_listener(self):
        if not self.low_freq_q: return
        loop = asyncio.get_running_loop()
        while True:
            try:
                event = await loop.run_in_executor(None, self.low_freq_q.get)
                name = event.get("name")
                if event.get("type") == "arrival":
                    self.roster_cache.add(name)
                    if self.brain and self.brain_task and not self.brain_task.done():
                        self.brain.send_text(f"[VISION] {name} has arrived.")
                elif event.get("type") == "departure":
                    self.roster_cache.discard(name)
                    if self.brain and self.brain_task and not self.brain_task.done():
                        self.brain.send_text(f"[VISION] {name} has departed.")
            except Exception:
                await asyncio.sleep(0.1)

    async def _vision_queue_listener(self):
        if not self.high_freq_q: return
        loop = asyncio.get_running_loop()
        while True:
            try:
                bboxes = await loop.run_in_executor(None, self.high_freq_q.get)
                self.server.broadcast({"type": "vision_bboxes", "bboxes": bboxes})
            except Exception:
                await asyncio.sleep(0.1)

    async def run(self, autostart: bool):
        self._loop = asyncio.get_running_loop()
        
        if self.high_freq_q:
            asyncio.create_task(self._vision_queue_listener(), name="vision_q")
        if self.low_freq_q:
            asyncio.create_task(self._roster_queue_listener(), name="roster_q")

        await self.server.start()
        self.status("offline", "asleep")
        self._on_robot_state(self.robot.snapshot())
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


def main():
    parser = argparse.ArgumentParser(description="Robot cognitive core")
    parser.add_argument("--auto", action="store_true", help="power the brain on at launch")
    args = parser.parse_args()
    
    mp.set_start_method('spawn', force=True)
    high_q = mp.Queue(maxsize=10)
    low_q = mp.Queue(maxsize=50)
    
    broker_proc = mp.Process(target=lambda: FrameBroker().run(), daemon=True)
    worker_proc = mp.Process(target=run_worker, args=(high_q, low_q), daemon=True)
    
    broker_proc.start()
    worker_proc.start()
    
    try:
        core = Core(high_q=high_q, low_q=low_q)
        asyncio.run(core.run(autostart=args.auto))
    except KeyboardInterrupt:
        print("\nshutdown. bye 👋")
    finally:
        broker_proc.terminate()
        worker_proc.terminate()


if __name__ == "__main__":
    main()
