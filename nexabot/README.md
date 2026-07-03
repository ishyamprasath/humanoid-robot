# NexaBot - Terminal Task Model

Pure Python terminal runner for a humanoid robot task loop.

The terminal is the only interaction surface:

- Type a command.
- A separate OpenCV camera window opens when a camera is available.
- The terminal prints one strict JSON task object.
- Object coordinates are included from the camera tracker.
- No gesture output is generated.

## Quick Start

```powershell
cd nexabot
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python nexabot.py
```

Examples:

```text
task> find red object
task> pick blue object
task> approach yellow cup
task> move forward 40
task> turn left 45
task> /coords red
task> /objects
task> /map
```

Every normal task prints JSON like:

```json
{
  "schema": "terminal-task-v1",
  "task": "pick_object",
  "task_keywords": ["pick_object", "pick", "blue", "object"],
  "object": {
    "visible": true,
    "label": "blue object",
    "color": "blue",
    "coordinates": {
      "x": 0.512,
      "y": 0.477,
      "z": 0.82,
      "pixel_x": 327,
      "pixel_y": 229
    }
  },
  "command": {
    "cmd": "execute_robot_task",
    "args": {
      "task": "pick_object",
      "target_coordinates": {
        "x": 0.512,
        "y": 0.477,
        "z": 0.82
      }
    }
  }
}
```

## Files

| File | Purpose |
|---|---|
| `nexabot.py` | Terminal task loop and JSON output |
| `video_io.py` | Separate camera window and object coordinates |
| `robot_sim.py` | Terminal robot state model |
| `hardware_bridge.py` | Optional USB serial bridge |
| `config.py` | Camera, serial, and schema settings |
| `tools.py` | Exact task schema for optional model integrations |
| `firmware/` | ESP32/Arduino receiver for the same JSON task command |

## Camera Coordinates

The camera module uses lightweight color tracking. Commands that name a color,
such as `find red object`, return the matching colored object's normalized
coordinates:

- `x`: 0.0 left to 1.0 right
- `y`: 0.0 top to 1.0 bottom
- `z`: estimated depth in meters from bounding-box size
- `pixel_x`, `pixel_y`: camera pixel center

Generic commands such as `find object` use the largest visible color-tracked
object. If no object is detected, JSON still prints the exact task with
`visible: false` and a reason.

## Hardware

Set `NEXABOT_SERIAL_PORT`, for example:

```powershell
$env:NEXABOT_SERIAL_PORT = "COM4"
python nexabot.py
```

Wire protocol, one JSON object per line at 115200 baud:

```json
{"cmd":"execute_robot_task","args":{"task":"move_robot","direction":"forward","distance_cm":50}}
{"cmd":"execute_robot_task","args":{"task":"turn_robot","angle_degrees":-90}}
{"cmd":"execute_robot_task","args":{"task":"pick_object","target_coordinates":{"x":0.5,"y":0.6,"z":0.4}}}
```
