# 🤖 NexaBot — Cognitive Core

Premium light-themed web cockpit for a 3-foot humanoid robot brain.

Real-time voice conversation via the **Gemini 3.1 Flash Live API** (voice **Kore**).
Your microphone streams up as 16 kHz PCM, the model streams warm human-sounding
audio back at 24 kHz, and every tool call it makes is executed against a live
world-frame simulator (and mirrored to real hardware over USB if plugged in).

---

## ⚡ Quick start

```powershell
cd nexabot
node server.js
```

Open **http://localhost:8000** in Chrome or Edge, press **Power On**, allow mic
and camera, and just talk:

- *"What can you see right now?"* – describes the frame
- *"Look at the blue cup on my desk"* – 👀 look-at reticle on the camera + world-frame projection
- *"Navigate to +1.5, -0.8"* – 🧭 base drives to an absolute world point
- *"Grab the mug"* – 🤏 gripper closes (refuses if depth > 1.5 m — reach limit)
- *"Fetch the water bottle from the kitchen counter"* – 📋 opens a proper **task** with an objective, target and priority
- Interrupt any time — barge-in stops playback instantly.

Requires Node 18+ (built-in `fetch`) and a Chromium browser (AudioWorklet + Web Serial).

---

## What's new in this build

- **Premium light theme** — ivory paper background, refined indigo accent, elegant micro-typography, subtle shadows. No dark mode.
- **Real world-frame coordinates** — the 4 m × 4 m room now has origin (0, 0) at its center, +x = east, +y = north. The HUD shows the robot's **world position in meters**, its **heading in degrees**, and for any tracked target both the **camera-frame** coords and the projected **world-frame** coords.
- **Tasks replace gestures** — the `execute_gesture` tool is gone. The new **`execute_task`** tool commits the robot to a real objective (`fetch`, `deliver`, `inspect`, `follow`, `greet`, `patrol`, `return_home`, `wait`) with a description, world-frame target, and priority. Tasks appear in a live queue with active/completed states.
- **`navigate_to(world_x, world_y)`** — new absolute-position tool so the brain can plan multi-step movements in true world coordinates.
- **Coordinate overlay** — the look-at reticle on the camera feed shows the raw camera coords **and** the projected depth so you can see the geometry.

---

## 📁 Files

| File | Purpose |
|---|---|
| [`server.js`](server.js) | Zero-dep Node server: static cockpit + NVIDIA proxy |
| [`public/index.html`](public/index.html) | Cockpit layout — 3-column workspace |
| [`public/css/style.css`](public/css/style.css) | Premium light theme |
| [`public/js/config.js`](public/js/config.js) | API keys, model, voice, audio rates, **system prompt** |
| [`public/js/tools.js`](public/js/tools.js) | 5 tool declarations: robot_action, move, turn, **navigate_to**, **execute_task** |
| [`public/js/gemini-live.js`](public/js/gemini-live.js) | Live WebSocket client (mic + video up, audio + tool calls + transcripts down) |
| [`public/js/audio-input.js`](public/js/audio-input.js) | Mic → 16 kHz PCM16 chunks via AudioWorklet |
| [`public/js/audio-output.js`](public/js/audio-output.js) | 24 kHz gapless playback + instant barge-in |
| [`public/js/video-input.js`](public/js/video-input.js) | Webcam preview + 1 fps JPEG frames upstream |
| [`public/js/robot-sim.js`](public/js/robot-sim.js) | World-frame simulator, task queue, coordinate projection |
| [`public/js/serial-bridge.js`](public/js/serial-bridge.js) | Web Serial mirror → real robot firmware |
| [`public/js/fallback-chat.js`](public/js/fallback-chat.js) | NVIDIA Nemotron backup brain |
| [`public/js/main.js`](public/js/main.js) | Orchestrator: senses ↔ brain ↔ simulator ↔ hardware |
| [`firmware/`](firmware) | ESP32/Arduino sketch (unchanged — receives the same JSON lines) |

## 🎛️ Configuration

Edit [`public/js/config.js`](public/js/config.js):

- `GEMINI_MODEL` — default `models/gemini-3.1-flash-live-preview`.
- `VOICE_NAME` — default `Kore`.
- `ROOM_HALF_METERS` — half-size of the room (default 2.0 → a 4 m × 4 m room).
- `SYSTEM_PROMPT` — the robot's persona and coordinate-system briefing.

## 🔧 Real hardware (optional)

1. Flash [`firmware/nexabot_firmware/nexabot_firmware.ino`](firmware/nexabot_firmware/nexabot_firmware.ino) to an ESP32 (edit its pin map + calibration first).
2. Plug it in via USB, click **Hardware** in the cockpit, and pick the COM port.
3. Every tool call now runs on-screen **and** on the real robot. Firmware acks appear in the Action Log.

Wire protocol — one JSON object per line at 115 200 baud:

```json
{"cmd":"navigate_to","args":{"world_x":1.2,"world_y":-0.5,"speed":0.6}}
{"cmd":"execute_task","args":{"task_type":"fetch","description":"bring the mug","target_coordinates":{"world_x":1.8,"world_y":0.2},"priority":"high"}}
```

## ⚠️ Notes

- Chromium browsers only (AudioWorklet + Web Serial).
- The API keys are embedded in [`config.js`](public/js/config.js) and [`server.js`](server.js) for local convenience — don't push this folder public without moving them to env vars.
- If Gemini Live can't connect, the Fallback panel opens automatically — a text chat with the same persona running on NVIDIA Nemotron.
