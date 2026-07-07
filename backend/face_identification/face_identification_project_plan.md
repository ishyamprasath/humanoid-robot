# Real-Time Facial Identification Subsystem — Project Plan

## Objective

A standalone, high-accuracy computer vision subsystem for a humanoid robot prototype. It detects, tracks, and identifies human faces in real time, learns new faces on the fly, and feeds structured identity data into the robot's main cognitive layer (Gemini Live video SDK). Final deployment target: Raspberry Pi 5 (CPU-only) running ROS 2.

**Scope boundary:** this module owns vision only — detection, tracking, recognition, enrollment, and pose estimation. Cognitive decision-making and interaction live in Gemini Live.

---

## Why not YOLO

YOLO is a generic object detector — it can find "a face" but has no concept of identity. Identification requires embedding-based recognition (a model that turns a face into a vector, then matches vectors), which is a different problem from detection. Using a face-specialized detector (SCRFD) instead of YOLO is both lighter and more accurate for this specific task.

---

## Core pipeline

1. **Face detection + landmarks — SCRFD** (from the InsightFace project). Purpose-built for faces, lighter than YOLO, returns 5-point landmarks needed for alignment.
2. **Alignment** — warp the face crop using the landmarks before recognition. Skipping this step hurts accuracy more than almost any other design choice.
3. **Tracking** — a lightweight tracker (ByteTrack or a simple centroid/IoU tracker) maintains identity across frames so you don't need to run full recognition on every single frame — only on new tracks or periodic refreshes.
4. **Head pose estimation** — use the landmarks (5-point, or InsightFace's 106-point model for more precision) with OpenCV's `solvePnP` against a generic 3D face model to get yaw/pitch/roll. No extra library needed.
5. **Recognition — ArcFace embeddings** (also InsightFace). Each aligned face becomes a 512-dim vector; identity is decided by cosine similarity against a gallery of known embeddings, thresholded to reject unknowns.
6. **On-the-fly enrollment** — capture several frames of a new/unknown face over ~2 seconds, compute embeddings, filter outliers, and add the survivors to the gallery under a new name.

### Why InsightFace (SCRFD + ArcFace) over alternatives
- `face_recognition` (dlib) — simpler, but lower accuracy and historically painful to build on Windows.
- DeepFace — convenient wrapper, more overhead per call.
- **InsightFace** — best accuracy/speed tradeoff, ONNX-based, runs cleanly via ONNXRuntime with GPU acceleration where available. InsightFace 1.0 (May 2026) also ships a lighter pip install without the old C++ build requirement.

---

## Gallery & matching design

- Store **multiple embeddings per identity** (not one averaged vector) — preserves pose/lighting variation and consistently improves match accuracy over single-centroid comparison.
- At small scale (dozens of identities), a flat file (pickle/JSON/NumPy array) is fine for storage. Only move to FAISS/Chroma if the gallery grows into the thousands.
- **Calibrate the similarity threshold using a negative set** — embeddings from people *not* in your known list — so the system reliably rejects strangers, not just accepts your known faces. This matters more than squeezing out marginal accuracy gains, since a false positive (misidentifying a random person as an important one) is worse than a missed match.

---

## Curating the known-person dataset (~20 people: principal, chairman, faculty, etc.)

This is **not** fine-tuning the recognition network — with only ~20 identities, fine-tuning would overfit and hurt generalization. You're building a high-quality **embedding gallery** against a frozen, already-strong pretrained model.

Per person, capture **15–30 reference photos**, deliberately varying:
- **Lighting**: indoor fluorescent, daylight near a window, outdoor sun, dim/evening
- **Angle**: frontal, ±15°, ±30–45° yaw, slight pitch up/down
- **Distance**: close (0.5–1m), medium (1–3m), far (3–5m) — match how close the robot will actually get to people
- **Expression**: neutral, talking, smiling
- **Multiple sessions/days** — different clothing and backgrounds generalizes far better than one photoshoot

**Processing pipeline per photo:** detect → align → embed → outlier rejection (drop photos whose embedding is a poor match to the rest of that person's set — usually blur or bad angle) → keep 8–12 surviving embeddings per person in the gallery.

---

## Edge deployment: Raspberry Pi 5, CPU-only, ROS 2

No AI accelerator (Hailo HAT, Coral, etc.) is present, so everything runs on the Pi 5's ARM CPU cores. Model choices are scoped down accordingly:

- **Detection**: SCRFD-500m (the smallest InsightFace detector variant), input reduced to ~320×320 rather than full VGA.
- **Recognition**: the `buffalo_sc` pack's MobileFaceNet-based embedder rather than the larger ResNet50-based `buffalo_l` recognition model — a small accuracy trade for a large speed gain, which is the right call against a small, well-curated gallery.
- **Runtime**: start with ONNXRuntime (CPU execution provider, multi-threaded across the Pi 5's 4 cores) for fast setup. If more headroom is needed later, InsightFace's models also have NCNN ports — NCNN is purpose-built for ARM and can cut inference latency significantly versus generic ONNXRuntime on Raspberry Pi–class hardware. Treat this as a later optimization pass, not a day-one requirement.
- **Scheduling**: run detection + tracking every frame at reduced resolution; only re-run the recognition embedding on new tracks or every 10–15 frames on existing ones.
- **Realistic performance target**: ~8–15 fps combined loop — not 30fps. This is plenty; a 1–2 second delay before the robot references someone by name is natural in conversation.
- **Thread budget note**: camera capture, ROS 2/DDS middleware, model inference, and the Gemini bridge's network I/O all compete for 4 cores. Give ONNXRuntime 2–3 threads and leave the rest for everything else — over-subscribing threads is a common cause of unexpectedly poor FPS on Pi-class hardware.

### Camera choice
- **Pi Camera Module (CSI, via `libcamera`/`camera_ros`)** — uses the hardware ISP, avoids USB bus overhead. Best choice if the cable run from the head to the Pi 5 board is short.
- **USB UVC webcam** — costs a bit more CPU (often MJPEG decode) but offers more mounting/cable-length flexibility for a humanoid head that may sit far from the board or need to detach/swivel.
- Either way, the camera is abstracted behind a ROS 2 driver node, so this decision doesn't affect the recognition pipeline design.

---

## ROS 2 architecture

**`face_id_node`**
- Subscribes to the camera driver's image topic.
- Runs detection → tracking → recognition → pose estimation.
- Publishes a custom message array on `/vision/tracked_faces`:
  ```
  int32 track_id
  string name
  float32 confidence
  float32[4] bbox
  float32[3] pose      # yaw, pitch, roll
  ```

**`gemini_bridge_node`**
- Subscribes to `/vision/tracked_faces`.
- Maintains small per-track state so it only acts on **changes** (a new identity appears, or a track resolves from unknown → known) rather than firing on every frame.
- Relays identity context into the Gemini Live session.

### System graph
```
Camera driver → Face ID node → Gemini bridge → Gemini Live (cloud session)
   (Image frames)   (Detect + ID)   (Identity state)
```

---

## Feeding identity into Gemini Live

Gemini Live already ingests the robot's raw camera feed directly for general scene understanding — it doesn't need your video, it needs **grounding on who it's looking at**, since it has no persistent identity recognition of its own. Two integration patterns (Gemini Live supports both real-time text input and function calling):

1. **Event-driven push (primary approach)** — when a known identity newly appears, or a track resolves from unknown → known, the bridge node sends a short tagged text update via `send_realtime_input(text=...)`, e.g.:
   > `[context] Visible: Dr. Sharma, Principal (confidence 0.87)`

   Add a system instruction telling Gemini that `[context]`-tagged messages are silent factual grounding, not something to verbally acknowledge. Push only on change events — Live API retains session memory, so per-frame spamming wastes tokens and risks the model narrating the update out loud.

2. **On-demand tool call (optional complement)** — expose a function like `get_visible_person()` that Gemini can call when it wants to check who's in frame. Live API supports non-blocking function calls, so this can run alongside the live conversation without stalling audio output.

**Note on scope**: reconciling Gemini's own visual sense of "who's in frame" with your face_id_node's tracked coordinates isn't usually necessary — you're just attaching a name to whoever the robot is already looking at, which works for the common single-person-interaction case. Multi-person disambiguation in a crowd is a harder follow-on problem.

---

## Build order

1. Detection + tracking + FPS benchmarking on target hardware (get the loop solid before adding recognition weight)
2. Batch-enroll the ~20 known people from curated reference photos; verify recognition accuracy and tune the similarity threshold
3. Build the live on-the-fly enrollment flow for anyone not pre-enrolled
4. Add head pose estimation overlay
5. Wire up `/vision/tracked_faces` and the `gemini_bridge_node`
6. Optimize: thread tuning, frame-skipping, consider NCNN if more speed is needed

## Accuracy checklist
- Always align crops before embedding — never feed an unaligned face into ArcFace.
- Store multiple embeddings per identity, not a single average.
- Calibrate the match threshold against real camera/lighting conditions and a negative set, not a default from documentation.
- Flag (even if out of scope for phase 1): basic liveness/anti-spoofing if the robot's context makes photo/video spoofing a real concern.
