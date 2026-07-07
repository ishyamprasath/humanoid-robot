# 🤖 Robot — Cognitive Core

**Browser-native · Gemini 3.1 Flash Live · zero backend.**

Real-time voice + vision conversation on the **Gemini Live API** (voice
**Kore**), running entirely in the browser. The camera is the robot's eyes
(native ~30 fps on screen, throttled frames to the model), the mic is its
ears (16 kHz PCM via AudioWorklet, hardware echo-cancelled so you can barge
in mid-sentence), and WebAudio is its voice. Tool calls drive a world-frame
robot simulator — the swap point for real hardware later.

```
┌───────────────────── browser (frontend/) ─────────────────────┐
│  🎙 mic (AudioWorklet, AEC) ─┐            ┌─▶ 🔊 WebAudio 24k  │
│  📷 getUserMedia camera ─────┤            │    (barge-in)      │
│     (native fps on screen)   ▼            │                    │
│              Gemini Live WebSocket ───────┤                    │
│              gemini-3.1-flash-live        │                    │
│                     │ tool calls          │                    │
│                     ▼                     │                    │
│              Robot executor (world sim, task queue,            │
│              world map + HUD — swap for ROS 2 later)           │
└────────────────────────────────────────────────────────────────┘
```

No Python, no local server hop, no JPEG-over-WebSocket — one network
connection, straight from the browser to Gemini.

---

## ⚡ Quick start

```powershell
cd nexabot/frontend
copy .env.example .env      # then edit .env — add your Gemini API key
npm install
npm run dev
```

Open **http://localhost:5173**, press **Power On**, allow mic + camera,
and talk.

- *"What can you see right now?"* — describes the live camera frame
- *"Look at the blue cup"* — look-at reticle + camera→world projection
- *"Navigate to +1.5, -0.8"* — absolute world-frame move
- *"Fetch the water bottle"* — opens a real **task** with goal + priority
- Interrupt mid-sentence — echo-cancelled full duplex, barge-in just works
- Type in the input box any time instead of talking

Requires Node 18+ and a Chromium-based browser (Chrome/Edge).

## 📁 Layout

| Path | What it is |
|---|---|
| [`frontend/src/main.js`](frontend/src/main.js) | Orchestrator — Live session, camera, UI, reconnect |
| [`frontend/src/config.js`](frontend/src/config.js) | Env loading, audio/video/world settings, **persona** |
| [`frontend/src/tools.js`](frontend/src/tools.js) | 5 tool declarations (camera-frame + world-frame, task-based) |
| [`frontend/src/audio.js`](frontend/src/audio.js) | Mic capture (16 kHz PCM16) + speaker playback + barge-in |
| [`frontend/src/pcm-worklet.js`](frontend/src/pcm-worklet.js) | Realtime-thread PCM16 converter |
| [`frontend/src/robot.js`](frontend/src/robot.js) | **The hardware swap point** — tool executor, world model, tasks |
| [`firmware/`](firmware) | ESP32/Arduino sketch for the serial protocol |

## 🔐 Secrets

Keys live in `frontend/.env` (gitignored): `VITE_GEMINI_API_KEY` from
https://aistudio.google.com/app/apikey.

⚠️ The key ships to the browser — fine for a local robot display / kiosk,
**never host this publicly with a real key**.

## 🎛 Tuning

`frontend/.env`:
- `VITE_MODEL_FRAME_FPS` (default 2) — frames/sec uploaded to Gemini.
  The on-screen feed is native fps regardless; vision tokens are the main
  latency/cost lever, so keep this low.
- `VITE_VOICE_NAME` (default Kore), `VITE_GEMINI_MODEL`.

## 🖥 Robot's 8" display (kiosk)

```bash
npm run build                      # frontend/dist
chromium --kiosk --app=http://localhost:5173
```

getUserMedia needs a secure context: `localhost` works out of the box; over
the LAN use HTTPS or `chromium --unsafely-treat-insecure-origin-as-secure=...`.

## 🔧 Hardware later

`frontend/src/robot.js` simulates a 4 m × 4 m world today. On the real robot,
map the same five tool calls to motors — Web Serial (ESP32 over USB works in
Chrome), or a ROS 2 bridge. Nothing in the brain, audio, or UI changes.
