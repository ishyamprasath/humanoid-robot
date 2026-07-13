# Face ID Integration Jobsheet

This document provides a detailed technical breakdown of the changes made to the humanoid robot's backend to integrate the Face ID subsystem, transitioning the application from a monolithic structure to a multi-process architecture.

---

## 1. Multi-Process Architecture & Shared Memory
**Files created/modified:** `backend/shared_camera.py` (new), `backend/video_io.py` (modified)

### Technical Explanation
The core challenge was allowing both the heavy computer vision pipeline (Face ID) and the Gemini Live async loop to read from the single webcam without causing Global Interpreter Lock (GIL) contention or blocking the event loop.

- **`FrameBroker` (Writer)**: Implemented in `shared_camera.py`, this class runs in a dedicated OS process. It securely holds the only `cv2.VideoCapture` handle. It reads frames in a `while True` loop and writes raw BGR bytes directly into a `multiprocessing.shared_memory.SharedMemory` block. 
- **Sequence Lock (Seqlock)**: To prevent torn reads (reading a frame while it's being written) without using heavyweight mutexes that would block the readers, a sequence lock pattern is used in the first 8 bytes of the shared memory header (`struct.pack`). The writer increments the counter to an odd number before writing, and to an even number after writing.
- **`FrameReader` (Consumer)**: Implemented in `shared_camera.py`, this class is used by consumers. It checks the sequence lock: if odd, it waits. It reads the frame, then checks the sequence lock again. If the lock changed during the read, it retries. This ensures zero-copy, non-blocking reads.
- **`video_io.py` Refactor**: The `CameraFeed` class was completely rewritten. Instead of opening `cv2.VideoCapture(0)`, it instantiates `FrameReader` and pulls frames from shared memory, encoding them to JPEG for the Gemini session and WebSocket streams.

## 2. Face ID Worker Process
**Files created/modified:** `backend/face_worker.py` (new)

### Technical Explanation
To execute the Face ID pipeline entirely decoupled from the async event loop, the `FaceIDWorker` was created to run inside its own `multiprocessing.Process`.

- **Pipeline Scaffolding**: It imports `insightface` and initializes the `buffalo_l` model pack. It connects to the shared camera via `FrameReader`.
- **Inter-Process Communication (IPC)**: Two `multiprocessing.Queue` objects are used for communication back to the main process, ensuring that heavy Python objects (like image arrays) never cross process boundaries.
    - **High-frequency Queue**: Emits bounding boxes (`bboxes`) as JSON-serializable dictionaries for the frontend to render at native framerate. It uses non-blocking `put_nowait` and evicts old data if the queue is full.
    - **Low-frequency Queue**: Emits roster delta events (`{"type": "arrival", "name": "Person"}`).
- **Ledger Scaffolding**: Basic debounce logic was stubbed out, throttling roster pings using `MAX_ROSTER_PING_RATE` and `TRACK_GRACE_PERIOD_SEC`.

## 3. Cognitive Core Wiring & Main Loop Refactor
**Files created/modified:** `backend/main.py` (modified)

### Technical Explanation
The main entry point was drastically refactored to spawn the new processes and hook them into the async event loop without blocking it.

- **Process Spawning**: In `main()`, `mp.set_start_method('spawn', force=True)` is used to ensure clean, cross-platform process isolation. Both `FrameBroker` and `FaceIDWorker` are spawned as `daemon=True` so they die when the main process terminates.
- **Queue Listeners**: Added `_roster_queue_listener` and `_vision_queue_listener` to the `Core` class. These run as `asyncio.Task`s in the background. Because `Queue.get()` is blocking, it is wrapped in `loop.run_in_executor(None, self.low_freq_q.get)` to safely yield to the asyncio loop.
- **Roster Cache**: The main process maintains a thread-safe `self.roster_cache = set()`. It updates deterministically based on the "arrival" and "departure" events from the low-frequency queue.
- **Realtime Text Pushes**: When an arrival/departure event triggers, the core injects it directly into the Gemini session via `self.brain.send_text(f"[VISION] {name} has arrived.")`.

## 4. Tool & Persona Updates
**Files created/modified:** `backend/tools.py` (modified), `backend/config.py` (modified)

### Technical Explanation
The Gemini session needed to be instructed on how to handle the new vision events and how to actively poll for presence.

- **`get_visible_people` Tool**: Appended to the Gemini tool registry in `tools.py`. In `main.py`, the `_handle_tool_call` wrapper intercepts this tool execution and returns `list(self.roster_cache)` synchronously, completely bypassing the Face ID worker process. This fulfills the requirement that tool calls must return instantly from local cache.
- **Persona Addendum**: Updated `SYSTEM_PROMPT` in `config.py`. Added a strict rule explaining that `[VISION]` tagged messages are "automated environmental context, not spoken words" to prevent the model from mechanically narrating the arrival events.
- **Configuration Variables**: Added constants for the vision tuning (`FACE_MATCH_THRESHOLD`, `TRACK_DEBOUNCE_FRAMES`, etc.) into `config.py` so they can be modified centrally.
