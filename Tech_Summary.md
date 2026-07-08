# Humanoid Robot Cognitive Core — Detailed Summary and Documentation

This document provides an exhaustive, deeply technical, and non-simplified overview of the Robot Cognitive Core project. It serves as context for any AI or lead developer maintaining, extending, or migrating the system.

## 1. System Architecture & Philosophy

The project is built around a **"Python Brain, Thin Display Client, Physical Robot"** philosophy. The Python backend has total ownership of cognitive tasks: the LLM sessions, microphone capture, speaker playback, camera feed, face recognition, and world-state simulation. The frontend is a "dumb" HTML/JS client serving only as a visual dashboard (intended for the robot's 8-inch screen), driven entirely by WebSocket broadcasts from Python.

Crucially, the architecture is designed as a **ROS 2 Jazzy migration path**. The `Robot` class in the backend currently simulates a physical robot in a 4m x 4m room, but the abstraction is designed such that injecting a `Ros2Robot` subclass will map Gemini's tool calls directly to `/cmd_vel` topics and `Nav2` action servers without altering any of the AI or display logic.

---

## 2. Feature Breakdown & How They Work

### A. Live Voice Conversation (Gemini Flash Live API)
- **How it works:** The primary brain operates on the `gemini-3.1-flash-live-preview` model over a bidirectional WebSocket. The system streams 16kHz mono PCM microphone audio up to the model and receives 24kHz mono PCM audio down. 
- **Barge-in / Interruption:** The audio playback system uses a queue. If the user interrupts the robot, the Gemini Live API sends a `server_content.interrupted` event. The backend immediately drops all queued audio chunks and resets the speaker stream, providing instant barge-in.
- **Fallback Mode:** If the Gemini API is down, unconfigured, or the user uses the text input box while the brain is powered off, the system routes text to an **NVIDIA Nemotron-3** model (via HTTP). This fallback acts as a text-only reasoning core without live audio/video capabilities.

### B. Dual-Frame Spatial Reasoning
- **Camera Frame:** Normalized coordinates `(x, y)` from `0.0` to `1.0` and depth `z` in meters. Used for localized, egocentric actions like `look_at` or `grasp`. 
- **World Frame:** Absolute physical coordinates in meters, where the origin `(0,0)` is the center of a 4m x 4m room, `+x` is east, and `+y` is north.
- **How it works:** When the LLM decides to interact with an object it sees, it issues camera-frame coordinates. The `Robot` class handles the translation using trigonometry (FOV offsets and heading) to project the camera coordinates into the 2D world frame map.

### C. Task-Based Execution & Motor Primitives
- **How it works:** The LLM is instructed not just to make gestures, but to commit to high-level **tasks** (e.g., `fetch`, `deliver`, `inspect`) using the `execute_task` tool. This opens an active task in the `Robot` class's queue.
- **Motor Control:** The LLM can subsequently issue `move_robot` (relative), `turn_robot` (relative), `navigate_to` (absolute world frame), and `execute_robot_action` (camera frame manipulation). The Python `Robot` class calculates the resulting positions and headings, clamps them to the room bounds, and broadcasts the updated `RobotState` to the UI.

### D. Zero-Copy Shared Memory Vision Pipeline
- **How it works:** Capturing video in the main thread blocks asyncio loops. Thus, a dedicated `FrameBroker` multiprocessing worker captures frames using OpenCV (forcing MJPG codec and a 1-frame buffer to prevent stale frame lag). 
- **Shared Memory:** The broker writes frames to a RAM-backed shared memory block guarded by a sequence lock (Seqlock). This allows multiple independent processes (the Gemini uploader, the UI streamer, and the Face worker) to read the freshest frame simultaneously without IPC overhead or blocking.

### E. Merged Vision Pipeline & Gemini Live Native Multimodality
- **How it works:** Previously separate, the vision pipeline is now natively merged with the Gemini Live session in `brain_live.py`. While the UI receives a high-FPS stream for smooth rendering, the Gemini session concurrently sips JPEG frames from the exact same shared memory broker at a throttled rate (`VIDEO_GEMINI_FPS`, typically ~1 fps).
- **Native Grounding:** These frames are sent directly via `session.send_realtime_input(video=...)` into the model's multimodal context. The model uses this native vision to ground its tool calls, allowing it to accurately compute camera-frame coordinates `(x, y, z)` for the `execute_robot_action` tool without requiring external object-detection prompts for known objects.

### F. Parallel Face Identification & Context Injection
- **How it works:** A separate multiprocessing worker (`FaceIDWorker`) uses `insightface` (buffalo_l models) to analyze the shared memory frames in parallel. 
- **High-Freq Stream:** Sends bounding box data rapidly via IPC queue for the UI to draw overlays.
- **Low-Freq Stream (Roster):** Maintains a state machine of who is currently in the room. When someone arrives or leaves, it pushes a roster event to the main process.
- **Context Injection:** The main process quietly injects a text message into the Gemini Live session (e.g., `[VISION] John has arrived.`). The system prompt instructs the LLM not to narrate these tags mechanically, but to seamlessly incorporate the knowledge into the natural conversation alongside its native video feed.

### G. Hardware Bridge
- **How it works:** An optional `HardwareBridge` class connects via `pyserial` to an ESP32 microcontroller at 115200 baud. Every tool call executed by the backend is serialized into a compact JSON line and mirrored to the serial port. The firmware (`nexabot_firmware.ino`) can parse this JSON to drive physical motors.

---

## 3. Script Interactions & Technical Details

### Backend (`backend/`)
- `main.py`: The entry point. Initializes multiprocessing queues, spawns the `FrameBroker` and `FaceIDWorker`. Instantiates the `Core` class which ties together the WebSockets, Hardware Bridge, Audio I/O, Robot Simulator, and Brains. Contains the asyncio loops for dispatching UI commands and fanning out telemetry to the UI.
- `config.py`: Loads the `.env` file natively. Defines all constants, hardware flags, and contains the massive `SYSTEM_PROMPT`. The prompt strictly defines the robot's persona, its physical dimensions (3 feet tall, 1.5m arm reach), coordinate systems, and cognitive rules (e.g., "Safety Bubble", "Honesty over Hallucination").
- `brain_live.py`: Wraps the `google-genai` SDK. Manages the active WebSocket connection to Gemini. Handles parallel tasks for uploading audio, uploading video (throttled to a low FPS to save tokens), and downloading audio/tool calls.
- `brain_fallback.py`: Implements a simple HTTP POST to NVIDIA's inference endpoint, stripping `<think>` reasoning tags from the output before rendering it to the UI.
- `tools.py`: A static schema file that uses Google GenAI `types.Tool` to define the JSON schemas for the 6 core robot functions (`execute_robot_action`, `move_robot`, `turn_robot`, `navigate_to`, `execute_task`, `get_visible_people`).
- `robot.py`: The execution engine and state store. Contains `RobotState` (x, y, heading, gripper state) and a list of `Task` objects. Methods like `_navigate_to` use math to simulate driving to a point. Modifying this class is the key to physical ROS 2 integration.
- `audio_io.py`: Uses `sounddevice` and `numpy`. `MicCapture` runs a PortAudio callback pushing PCM bytes to an asyncio queue. `SpeakerPlayer` runs a dedicated thread that pulls from a Python queue and writes to the output stream, handling the `interrupt()` drops.
- `shared_camera.py`: Implements `FrameBroker` (writer) and `FrameReader` (reader) using `multiprocessing.shared_memory`. Uses the `struct` module to pack a Seqlock counter and image dimensions in the header.
- `face_worker.py`: Runs the `insightface` pipeline. Simulates presence tracking. Communicates with `main.py` via two `multiprocessing.Queue` instances.
- `video_io.py`: Reads from `FrameReader` and uses OpenCV to encode frames to JPEG bytes using `IMWRITE_JPEG_QUALITY`. Yields these bytes asynchronously.
- `state_server.py`: Runs a standard `http.server` in a background thread to serve the frontend files, and an `asyncio` WebSocket server (`websockets` library) to stream JSON state and receive UI commands.
- `hardware_bridge.py`: Safely wraps `pyserial`. Captures tool call dictionaries, dumps them to JSON strings, and writes them with a newline terminator.

### Frontend (`frontend/`)
- `index.html`: Layout relies heavily on CSS Grid/Flexbox. Divided into Left (Vision/Sensors), Center (World Map), and Right (Tasks/Logs).
- `js/display.js`: The WebSocket client. Listens for events like `type: "robot"` to redraw the simulated room canvas (rendering the robot's heading, camera FOV cone, and task targets). Renders `type: "frame"` by updating an `<img>` tag with base64 JPEG data. Overlays face bounding boxes onto an absolute-positioned `<canvas>`.
- `css/style.css`: Provides the visual styling (dark mode, layout grids, status pills, meters).

### Firmware (`firmware/`)
- `nexabot_firmware/nexabot_firmware.ino`: Standard Arduino C++ sketch. Listens on `Serial`. Expected to use a library like `ArduinoJson` to parse the incoming string and map `cmd` and `args` to physical GPIO logic.

---

## 4. Operational Flow Example

1. **Start:** User runs `python main.py --auto`. 
2. **Boot:** `main.py` spawns camera and face workers. Loads `SYSTEM_PROMPT`. Connects to Gemini Live. WebSocket server starts.
3. **Observation:** Camera broker writes frames. Gemini brain uploads frames at ~1 fps. Face worker detects a face and sends `{"type": "arrival", "name": "Alice"}`. `main.py` injects `[VISION] Alice has arrived.` into Gemini.
4. **Interaction:** User speaks into the microphone: *"Alice is here, bring her the blue cup from the table."*
5. **Inference:** Gemini processes the audio and vision. It speaks back (PCM data streamed to `SpeakerPlayer`): *"On it, grabbing the cup for Alice."*
6. **Execution:** Gemini issues a tool call: `execute_task(type="deliver", description="bring blue cup to Alice")`. 
7. **Simulation:** `robot.py` logs the task. `main.py` broadcasts the updated state.
8. **UI Update:** `display.js` adds the task to the Task Queue UI and plots a target on the World Map.
9. **Motor Action:** Gemini issues `navigate_to(world_x=1.5, world_y=-1.0)`. `robot.py` updates the robot's `x` and `y` position. UI redraws the robot dot moving to the new coordinates.
10. **Hardware:** If connected, `hardware_bridge.py` writes `{"cmd": "navigate_to", "args": {"world_x": 1.5, ...}}` to the ESP32.
