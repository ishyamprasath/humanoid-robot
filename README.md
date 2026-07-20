<div align="center">
  <h1>🤖 Browser-Native Humanoid Robot</h1>
  <p><strong>A Zero-Latency, Thick-Client Cognitive Core for Robotics</strong></p>
</div>

<br />

Welcome to the future of robotics architecture! This project implements a **zero-backend, browser-native** cognitive core for a humanoid robot. 

Instead of routing camera feeds and audio streams through complex Python backend servers, **the browser IS the robot's brain**. It directly handles vision, speech, reasoning, and physical hardware control.

---

## 🌟 Key Features

* **Browser-Native Cognitive Core:** The AI runs entirely in the frontend using the `@google/genai` SDK to connect directly to the **Gemini Live API** via WebRTC.
* **Zero-Latency Senses:** 
  * **Vision:** Uses native `getUserMedia` to capture video, dynamically throttling and uploading JPEG frames directly to the multimodal AI.
  * **Hearing & Speech:** Uses native WebAudio and AudioWorklet APIs for instant conversational latency and barge-in support.
* **On-Device Memory:** Face Identification runs completely locally. Known faces and conversation memories are stored directly in the browser's `IndexedDB`.
* **Direct Hardware Integration:** The browser commands the robot's physical body (ESP32 microcontrollers) using local network HTTP requests.
* **Automated Kiosk Mode:** A single batch script builds the UI, starts a lightweight server, and automatically pops open a dual-monitor dashboard in Microsoft Edge.

---

## 🛠️ Engineering Deep Dive

The legacy Python backend has been completely archived. The robot now relies on a streamlined thick-client architecture.

### The Data Flow Loop
Because the browser manages everything, the latency loop is incredibly short:
1. **Sensory Input:** `Webcam/Mic` ➡️ `Browser APIs (getUserMedia / AudioWorklets)`.
2. **AI Processing:** Browser ➡️ `WebRTC / WebSockets` ➡️ `Gemini Live / Ultravox`.
3. **Action Generation:** AI streams back a `JSON Tool Call` (e.g., `execute_gesture("wave")`).
4. **Physical Actuation:** Browser intercepts the tool call and fires a `fetch()` request directly to the local ESP32 IP, moving the physical arm.

### Frontend Module Breakdown (`frontend/src/`)
* **`main.js`**: The core controller. Manages the WebRTC connections, handles the AI session state, and renders the telemetry dashboard.
* **`tools.js`**: Maps AI decisions to physical actions. Contains the HTTP fetch logic for robot movement and the memory triggers.
* **`relay.js`**: Acts as a state bridge, synchronizing data between the control dashboard (`control.html`) and the robot's physical face display (`face.html`).
* **`face.html` / `control.html`**: The two distinct UI windows. The face is displayed on an 8" screen on the robot itself, while the control dashboard acts as the developer HUD.

### Why use a Python Server?
Even though the AI runs in the browser, we use a tiny **FastAPI Server** (`frontend/main.py`) for three specific reasons:
1. **CORS & Static Serving:** Safely serves the Vite-built HTML/JS files to the browser.
2. **Local Logging:** A Vite plugin (`vite-plugin-robot-logger`) intercepts console logs and writes them to persistent text files in the `/logs` directory on your hard drive.
3. **API Key Security:** In production deployments, it proxies secure requests so API keys don't leak to public clients (though this project is designed for secure, local kiosk usage).

### Hardware Endpoints
The frontend is hardcoded to talk to an ESP32 microcontroller at `10.235.127.62`. When the AI decides to move, the browser triggers endpoints like:
* `GET http://10.235.127.62/gestureHi` (Waves hand)
* `GET http://10.235.127.62/gestureClap` (Claps)

*(Note: If your robot is on a different subnet, update the IP address in `tools.js`)*.

---

## 🚀 Environment Setup

### 1. Prerequisites
Ensure you have the following installed on your machine:
* **Python 3.10+**
* **Node.js 18+**
* A functioning Webcam and Microphone.
* Microsoft Edge (for automated kiosk-mode window positioning).

### 2. Configure API Keys
Copy the `.env.example` file to `.env` in the root directory. Fill in your keys:
```env
# Gemini Live API — voice + vision brain (Get one at: https://aistudio.google.com)
VITE_GEMINI_API_KEY=your_gemini_key_here
VITE_GEMINI_MODEL=gemini-3.1-flash-live-preview
VITE_VOICE_NAME=Kore

# Ultravox API (Alternative voice engine)
VITE_ULTRAVOX_API_KEY=your_ultravox_key_here

# Local Web Server Port
PORT=8000
```

### 3. Installation
Double-click `click_to_install.bat`. This one-time setup script will:
- Create a Python virtual environment (`.venv`).
- Install FastAPI and Uvicorn.
- Run `npm install` for the Vite frontend.

---

## 🕹️ Running the Robot

Double-click `start.bat` to bring the robot to life! 
1. Vite will compile the frontend assets.
2. The FastAPI server will spin up on `localhost:8000`.
3. Microsoft Edge will automatically launch two side-by-side windows:
   - **The Face Display:** Drag this to the robot's physical screen.
   - **The Control Dashboard:** Keep this on your main monitor to monitor logs, manual overrides, and camera feeds.

---

## 🔧 Troubleshooting & Customization

> [!WARNING]
> **Permissions Are Critical:** Because this is a browser-native application, **you must grant Microphone and Camera permissions** when the Edge browser opens. If you deny them, the robot will be blind and deaf.

* **Popup Blockers:** `start.bat` tries to open multiple windows. If Edge blocks the popups, allow popups for `localhost` in your browser settings.
* **Customizing the Persona:** The robot's personality is defined by a System Prompt. You can edit this directly in the frontend source code before starting the robot to change how it behaves.
* **Face Database:** The robot uses `IndexedDB` to store faces locally. If you want to wipe the robot's memory of people, simply open the Edge DevTools (F12) -> Application -> IndexedDB, and delete the database.
