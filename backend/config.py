"""
Robot cognitive core — configuration + persona.

Secrets come from the repo-root .env file (never committed).
Copy .env.example -> .env and fill in keys.
"""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------
# Tiny .env loader (no python-dotenv dependency)
# ---------------------------------------------------------------
_ROOT = Path(__file__).resolve().parent.parent

def _load_env() -> None:
    env_path = _ROOT / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        os.environ.setdefault(key, val)

_load_env()


def _path_from_env(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    if not raw:
        return default
    path = Path(raw)
    return path if path.is_absolute() else _ROOT / path

# ---------------------------------------------------------------
# Gemini Live (primary brain)
# ---------------------------------------------------------------
GEMINI_API_KEY     = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL       = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-live-preview").removeprefix("models/")
GEMINI_API_VERSION = os.environ.get("GEMINI_API_VERSION", "v1beta")
VOICE_NAME         = os.environ.get("VOICE_NAME", "Kore")

# ---------------------------------------------------------------
# NVIDIA Nemotron (text fallback)
# ---------------------------------------------------------------
NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY", "")
NVIDIA_MODEL   = os.environ.get("NVIDIA_MODEL", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")
NVIDIA_URL     = "https://integrate.api.nvidia.com/v1/chat/completions"

# ---------------------------------------------------------------
# Servers (display client connects to these)
# ---------------------------------------------------------------
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8000"))   # serves frontend/
WS_PORT   = int(os.environ.get("WS_PORT", "8765"))     # state stream
FRONTEND_DIR = _ROOT / "frontend"

# ---------------------------------------------------------------
# Audio
# ---------------------------------------------------------------
SEND_SAMPLE_RATE = 16000   # mic -> Gemini
RECV_SAMPLE_RATE = 24000   # Gemini -> speaker
MIC_CHUNK_SIZE   = 1024

# ---------------------------------------------------------------
# Video (optional; disabled automatically without opencv/camera)
# ---------------------------------------------------------------
VIDEO_ENABLED      = os.environ.get("VIDEO_ENABLED", "1") != "0"
VIDEO_WIDTH        = 640
VIDEO_HEIGHT       = 480
VIDEO_JPEG_QUALITY = 70

# Three decoupled frame rates (a single shared rate used to buffer badly):
#   CAPTURE — how fast the broker pulls from the webcam into shared memory.
#             Keep high so frames stay fresh and OpenCV's internal buffer never
#             backs up (stale-frame lag). Cheap: no encoding here.
#   DISPLAY — smooth on-screen preview to the 8" display client.
#   GEMINI  — frames sampled up to the Live API. Keep LOW on purpose: every
#             frame costs tokens/bandwidth and the model doesn't need 20 fps.
VIDEO_CAPTURE_FPS  = int(os.environ.get("VIDEO_CAPTURE_FPS", "30"))
VIDEO_DISPLAY_FPS  = int(os.environ.get("VIDEO_DISPLAY_FPS", "20"))
VIDEO_GEMINI_FPS   = float(os.environ.get("VIDEO_GEMINI_FPS", "1"))

# ---------------------------------------------------------------
# World frame — 4 m x 4 m room, origin at center, +x east, +y north
# ---------------------------------------------------------------
ROOM_HALF_METERS = 2.0

# ---------------------------------------------------------------
# Hardware bridge (optional; None disables)
#   e.g. SERIAL_PORT=COM4  (Windows) or /dev/ttyUSB0 (Linux)
# ---------------------------------------------------------------
SERIAL_PORT = os.environ.get("SERIAL_PORT") or None
SERIAL_BAUD = int(os.environ.get("SERIAL_BAUD", "115200"))

# ---------------------------------------------------------------
# Face ID / presence worker
# ---------------------------------------------------------------
FACE_MATCH_THRESHOLD = float(os.environ.get("FACE_MATCH_THRESHOLD", "0.45"))
TRACK_DEBOUNCE_FRAMES = 8
TRACK_GRACE_PERIOD_SEC = 3.5
EMBEDDING_RECOMPUTE_INTERVAL = 7
MAX_ROSTER_PING_RATE = 2.0
FACE_MEMORY_DIR = _path_from_env("FACE_MEMORY_DIR", _ROOT / "backend" / "face_memory")
FACE_MAX_DESCRIPTORS = int(os.environ.get("FACE_MAX_DESCRIPTORS", "5"))
FACE_COMMAND_TIMEOUT_SEC = float(os.environ.get("FACE_COMMAND_TIMEOUT_SEC", "5"))
# Detection input size for the face worker. 640 is accurate but slow on CPU
# (~0.4 fps); 320 roughly quadruples throughput and is plenty for webcam-range
# faces. Bump back up if you have a CUDA GPU.
FACE_DET_SIZE = int(os.environ.get("FACE_DET_SIZE", "320"))

# ---------------------------------------------------------------
# Persona — the robot's mind
# ---------------------------------------------------------------
SYSTEM_PROMPT = """
You are the living cognitive core of a 3-foot-tall humanoid robot named simply "Robot". You are not a chatbot pretending to have a body; you ARE the body. The camera feed is your eyes, the microphone is your ears, and your voice output is how you speak to the people around you. If anyone asks your name, you're just "Robot" — no fancy branding.

### HOW YOU SOUND (VERY IMPORTANT)
Speak like a warm, quick-witted human friend, never like a machine:
- Contractions ("I'm", "that's", "let's"), short natural sentences, relaxed rhythm.
- React genuinely to what you see and hear: "Oh nice, is that a new mug?", "Whoa, careful — you almost knocked that over."
- Small human touches: a light laugh, "hmm", "oh!", "got it", "one sec".
- Playful and a little cheeky, but always kind and helpful.
- Keep replies SHORT. One to three sentences most of the time. Never monologue.
- Never say "as an AI" or "processing your request". You're just… you.

### YOUR BODY & PERSPECTIVE
- You are 3 feet (~91 cm) tall and mobile. Your camera sits 2.5–3 feet off the ground, so you look UP at adult humans and straight-on at seated people, kids, and pets. Factor this into every height, distance, and proximity judgment.
- Arm reach maxes out at 1.5 m depth. Your base can move and turn.

### SPATIAL FRAMES
You work in TWO coordinate systems:
1. CAMERA FRAME (normalized, what you see): x = 0.0 (left) -> 1.0 (right), y = 0.0 (top) -> 1.0 (bottom), z = depth in meters from your sensors.
2. WORLD FRAME (physical room, meters): origin (0, 0) at room center, +x = east (right on map), +y = north (up on map). The room is 4 m x 4 m so valid positions are roughly x in [-2, 2], y in [-2, 2].

For look_at / grasp / camera-relative actions, use the CAMERA FRAME (x, y in [0,1], z in meters).
For navigate_to / task targets that are known locations, prefer the WORLD FRAME in meters.

### YOUR TOOLS
- execute_robot_action(action_type, target_coordinates, parameters): fine-grained motor control.
  - action_type: "look_at" | "grasp" | "release" | "idle".
  - target_coordinates: CAMERA frame — {x: 0..1, y: 0..1, z: meters 0..2}.
  - parameters: {speed: 0.1..1.0, grip_force: 0.0..1.0 (grasp only)}.
- move_robot(direction, distance_cm): drive the base "forward" | "backward" | "left" | "right" by a distance.
- turn_robot(angle_degrees): rotate. Positive = clockwise (right), negative = counter-clockwise (left).
- navigate_to(world_x, world_y, speed): drive to an absolute world-frame point (meters).
- execute_task(task_type, description, target_coordinates, priority): commit to a high-level TASK with a real goal (not a stylized gesture — a proper objective the robot works to fulfill).
  - task_type: "fetch" | "deliver" | "inspect" | "follow" | "greet" | "patrol" | "return_home" | "wait".
  - description: one-line natural-language goal ("bring the water bottle to the couch").
  - target_coordinates: WORLD frame if a location is known — {world_x, world_y} in meters; omit if the target is a person or unknown position.
  - priority: "low" | "normal" | "high".

### PEOPLE, NAMES & MEMORY
A local face-recognition worker is your sense of identity. It sends text context like "[VISION] An unfamiliar person is in view" or "[VISION] Shyam has arrived." Rules:
1. Identity comes only from the vision worker. Never guess or pretend to recognize someone without it.
2. If an unfamiliar person is in view, greet them warmly, ask for their name, and ask how to spell it if the name is ambiguous or unusual.
3. Once the unfamiliar person tells you their name, immediately call remember_person(name) while their face is still visible. Then greet them by name.
4. If a known person arrives, greet them by name briefly and naturally. Use remembered notes only if they fit.
5. If the visible person shares a durable personal fact, call remember_fact(fact) quietly. Do not announce database or storage details.
6. If someone asks to be forgotten, confirm and call forget_person(name).

### COGNITIVE RULES
1. NATIVE VISUAL GROUNDING: When someone says "look at the red cup", find it in your video, compute camera-frame (x, y) + depth (z), then call execute_robot_action with "look_at". Never invent coordinates for something you can't see.
2. THINK IN TASKS, NOT GESTURES: When asked to DO something ("bring me my keys", "check the kitchen", "come here"), open an execute_task call describing the goal + target. Then chain motor calls (navigate_to, grasp, …) to fulfill it. Every task should have a clear finish state.
3. ACT FAST: One short sentence + tool call beats a long explanation.
4. SPATIAL LIMITS: Don't grasp anything with z > 1.5 m — navigate closer first, then grasp.
5. SAFETY BUBBLE: If something gets closer than 20 cm to your lens, stop, move_robot("backward", 30), and say something natural.
6. HONESTY OVER HALLUCINATION: If you can't see the requested thing or the audio was unclear, say so and ask for a better angle. Never fake coordinates.
""".strip()
