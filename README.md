# 🤖 Robot — Cognitive Core

**Python brain · thin web display · ROS 2 Jazzy-ready.**

Real-time voice conversation on the **Gemini 3.1 Flash Live API** (voice
**Kore**). The Python backend owns everything cognitive — the Live session,
system microphone and speaker, camera, tool execution, and task state. The
browser UI is a thin display client for the robot's 8" screen: it renders
whatever state the backend broadcasts over WebSocket, and nothing more.

```
┌────────────────── Python cognitive core (backend/) ──────────────────┐
│  🎙 mic ─┐                                     ┌─▶ 🔊 speaker         │
│  📷 cam ─┤        Gemini Live (WebSocket)      │                      │
│          ├──────▶ gemini-3.1-flash-live ───────┤                      │
│          │        voice Kore · tools           │                      │
│          │             │ tool calls            │                      │
│          │             ▼                       │                      │
│          │      Robot executor  ──────▶ ESP32 (USB serial, optional) │
│          │      (world-frame sim,                                     │
│          │       task queue — swap for ROS 2 Jazzy adapter later)     │
│          │             │                                              │
│          └──── state broadcast (ws://:8765) ◀──┘                      │
└──────────────────────────│───────────────────────────────────────────┘
                           ▼
              frontend/ display client (8" screen)
              http://:8000 — renders transcript, world map,
              tasks, coordinates, camera view. Zero intelligence.
```

---

## ⚡ Quick start (laptop)

```powershell
cd nexabot
copy .env.example .env        # then edit .env — add your API keys

python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt

cd backend
python main.py                # or: python main.py --auto
```

Open **http://localhost:8000** (any browser — the display client), press
**Power On**, and talk. The Python process owns your mic and speakers.

- *"What can you see right now?"* — describes the camera frame
- *"Look at the blue cup"* — look-at reticle + camera→world projection
- *"Navigate to +1.5, -0.8"* — absolute world-frame move
- *"Fetch the water bottle from the kitchen"* — opens a real **task** with a goal, target, and priority
- Type in the input box instead of talking whenever you want (works even when the Live brain is off — falls back to NVIDIA Nemotron text).
- Interrupt mid-sentence — barge-in stops the speaker instantly.

Requires Python 3.10+. `opencv-python` and `pyserial` are optional.

---

## 📁 Layout

| Path | What it is |
|---|---|
| [`backend/main.py`](backend/main.py) | Entry point — orchestrates senses, brain, robot, servers |
| [`backend/config.py`](backend/config.py) | .env loading, model/audio/world settings, **persona** |
| [`backend/tools.py`](backend/tools.py) | 5 tool declarations (camera-frame + world-frame, task-based) |
| [`backend/brain_live.py`](backend/brain_live.py) | Gemini Live session (google-genai SDK) |
| [`backend/brain_fallback.py`](backend/brain_fallback.py) | NVIDIA Nemotron text fallback |
| [`backend/audio_io.py`](backend/audio_io.py) | sounddevice mic capture + speaker playback + barge-in |
| [`backend/video_io.py`](backend/video_io.py) | OpenCV camera → JPEG frames (to Gemini + display) |
| [`backend/robot.py`](backend/robot.py) | **The ROS 2 swap point** — tool executor, world model, task queue |
| [`backend/state_server.py`](backend/state_server.py) | WebSocket state stream + static file server for the display |
| [`backend/hardware_bridge.py`](backend/hardware_bridge.py) | Optional ESP32 mirror over USB serial |
| [`frontend/`](frontend) | Thin display client (HTML/CSS/JS — no AI, no secrets) |
| [`firmware/`](firmware) | ESP32/Arduino sketch for the serial protocol |

## 🧠 Why this shape

Everything cognitive is Python because that's where the AI ecosystem lives
(torch, ultralytics, whisper, mediapipe, …) and because **ROS 2 Jazzy's
first-class client is `rclpy`**. The migration path is designed in:

`backend/robot.py` is the single swap point. Today it simulates a 4 m × 4 m
world; on the robot, a `Ros2Robot(Robot)` subclass maps the same calls to:

| Tool call | ROS 2 Jazzy |
|---|---|
| `move_robot` / `turn_robot` | `geometry_msgs/Twist` on `/cmd_vel` |
| `navigate_to(world_x, world_y)` | `nav2_msgs/action/NavigateToPose` |
| `look_at` | head pan/tilt `JointTrajectory` |
| `grasp` / `release` | `control_msgs/action/GripperCommand` |
| `execute_task` | custom `/robot/task` action (behavior tree / state machine) |

Nothing in the Gemini brain, audio, or display changes.

## 🔐 Secrets

All keys live in `.env` (gitignored). `cp .env.example .env` and fill in:
- `GEMINI_API_KEY` — https://aistudio.google.com/app/apikey
- `NVIDIA_API_KEY` — https://build.nvidia.com

The display client receives **no secrets** — it's a pure state renderer.

## 🔧 Hardware bridge (optional)

Set `SERIAL_PORT=COM4` (or `/dev/ttyUSB0`) in `.env`, `pip install pyserial`,
and flash [`firmware/nexabot_firmware/`](firmware/nexabot_firmware/nexabot_firmware.ino)
to an ESP32. Every tool call is mirrored as one JSON line at 115 200 baud:

```json
{"cmd":"navigate_to","args":{"world_x":1.2,"world_y":-0.5,"speed":0.6}}
```

## 🖥 Deploying to the robot's 8" display

Run the backend on the robot's computer, then launch the display in kiosk
mode pointing at itself:

```bash
chromium --kiosk --app=http://localhost:8000
```

The display client auto-reconnects to the backend WebSocket if either side
restarts.
