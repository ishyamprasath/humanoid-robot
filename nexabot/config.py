"""
NexaBot terminal configuration.

The active app is terminal-first: typed command in, strict JSON task out, and
an optional camera preview window for object coordinates.
"""

from __future__ import annotations

import os


# Optional model/API settings kept for compatibility with the older brain files.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-live-preview")
GEMINI_API_VERSION = os.getenv("GEMINI_API_VERSION", "v1beta")
VOICE_NAME = os.getenv("VOICE_NAME", "Kore")
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
NVIDIA_MODEL = os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning")
NVIDIA_URL = os.getenv("NVIDIA_URL", "https://integrate.api.nvidia.com/v1/chat/completions")


# Audio constants are unused by the terminal runner but left for audio_io imports.
SEND_SAMPLE_RATE = 16000
RECV_SAMPLE_RATE = 24000
MIC_CHUNK_SIZE = 1024


# Camera preview and coordinate tracking.
VIDEO_ENABLED = os.getenv("NEXABOT_CAMERA", "1") not in {"0", "false", "False"}
VIDEO_WIDTH = int(os.getenv("NEXABOT_CAMERA_WIDTH", "640"))
VIDEO_HEIGHT = int(os.getenv("NEXABOT_CAMERA_HEIGHT", "480"))
VIDEO_FPS = 15
VIDEO_JPEG_QUALITY = 70
CAMERA_WINDOW_NAME = "NexaBot Camera Coordinates"


# Optional real hardware over USB serial.
SERIAL_PORT = os.getenv("NEXABOT_SERIAL_PORT") or None
SERIAL_BAUD = int(os.getenv("NEXABOT_SERIAL_BAUD", "115200"))


TASK_SCHEMA_VERSION = "terminal-task-v1"
TASK_KEYWORDS = [
    "observe_object",
    "approach_object",
    "pick_object",
    "release_object",
    "move_robot",
    "turn_robot",
    "stop_robot",
    "idle",
]


SYSTEM_PROMPT = """
You are NexaBot's terminal task planner.

Return exactly one JSON object per user command. Do not produce spoken text.
Do not produce gestures. Do not invent object coordinates. Use camera-derived
coordinates only when supplied by the terminal runtime.

Required JSON fields:
- schema: "terminal-task-v1"
- task: one of observe_object, approach_object, pick_object, release_object,
  move_robot, turn_robot, stop_robot, idle
- task_keywords: minimal lowercase keywords from the command
- object: object label, color if known, visibility, and coordinates
- command: serial-safe command name and args
- result: terminal-readable status summary
""".strip()
