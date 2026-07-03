"""
Terminal-native robot state model.

The simulator accepts exact task keywords and returns machine-readable status
dicts. It intentionally has no gesture channel; every output is a task.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


class C:
    RESET = "\x1b[0m"
    BOLD = "\x1b[1m"
    DIM = "\x1b[2m"
    CYAN = "\x1b[36m"
    GREEN = "\x1b[32m"
    YELLOW = "\x1b[33m"
    RED = "\x1b[31m"
    MAGENTA = "\x1b[35m"
    BLUE = "\x1b[34m"
    GRAY = "\x1b[90m"


def paint(color: str, text: str) -> str:
    return f"{color}{text}{C.RESET}"


GRID_W, GRID_H, CM_PER_CELL = 40, 20, 10
TASKS = {
    "observe_object",
    "approach_object",
    "pick_object",
    "release_object",
    "move_robot",
    "turn_robot",
    "stop_robot",
    "idle",
}


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _normalize_rad(value: float) -> float:
    while value > math.pi:
        value -= 2 * math.pi
    while value < -math.pi:
        value += 2 * math.pi
    return value


@dataclass
class RobotState:
    x: float = GRID_W / 2
    y: float = GRID_H / 2
    heading: float = 0.0
    gripper: str = "open"
    current_task: str = "idle"
    target: dict | None = None
    trail: list[tuple[float, float]] = field(default_factory=list)


class RobotSimulator:
    """Executes terminal task JSON against a simple top-down robot model."""

    def __init__(self, on_action=None):
        self.state = RobotState()
        self.on_action = on_action or (lambda name, args, result: None)

    def execute(self, name: str, args: dict | None) -> dict:
        args = args or {}
        try:
            if name == "execute_robot_task":
                result = self._task(args)
            elif name == "move_robot":
                result = self._move(args)
            elif name == "turn_robot":
                result = self._turn(args)
            else:
                result = {"status": "error", "reason": f'unknown command "{name}"'}
        except Exception as exc:
            result = {"status": "error", "reason": str(exc)}

        self.on_action(name, args, result)
        return result

    def _task(self, args: dict) -> dict:
        task = args.get("task", "idle")
        if task not in TASKS:
            return {"status": "error", "reason": f'unknown task "{task}"'}

        self.state.current_task = task
        target = args.get("target_coordinates")
        self.state.target = target if isinstance(target, dict) else None

        if task == "move_robot":
            return self._move(args)
        if task == "turn_robot":
            return self._turn(args)
        if task == "stop_robot":
            return {"status": "success", "task": task, "motors": "stopped"}
        if task == "idle":
            return {"status": "success", "task": task}
        if task == "release_object":
            self.state.gripper = "open"
            return {"status": "success", "task": task, "gripper": "open"}

        if not isinstance(target, dict):
            return {
                "status": "error",
                "task": task,
                "reason": "target_coordinates_required",
            }

        x = _clamp(float(target.get("x", 0.5)), 0, 1)
        y = _clamp(float(target.get("y", 0.5)), 0, 1)
        z = _clamp(float(target.get("z", 0.0)), 0, 2)
        self.state.heading = _normalize_rad(self.state.heading + (x - 0.5) * (math.pi / 3))

        if task == "observe_object":
            return {
                "status": "success",
                "task": task,
                "target_coordinates": {"x": x, "y": y, "z": z},
            }

        if task == "approach_object":
            return self._advance_toward(task, z)

        if task == "pick_object":
            if z > 1.5:
                return {
                    "status": "error",
                    "task": task,
                    "reason": "target_out_of_reach",
                    "max_reach_m": 1.5,
                    "target_z_m": z,
                }
            self.state.gripper = "closed"
            return {
                "status": "success",
                "task": task,
                "gripper": "closed",
                "target_coordinates": {"x": x, "y": y, "z": z},
            }

        return {"status": "success", "task": task}

    def _move(self, args: dict) -> dict:
        direction = args.get("direction", "forward")
        distance_cm = _clamp(float(args.get("distance_cm", 0)), 0, 300)
        distance_cells = distance_cm / CM_PER_CELL
        heading = self.state.heading

        if direction == "forward":
            dx, dy = math.cos(heading), math.sin(heading)
        elif direction == "backward":
            dx, dy = -math.cos(heading), -math.sin(heading)
        elif direction == "left":
            dx, dy = math.cos(heading - math.pi / 2), math.sin(heading - math.pi / 2)
        elif direction == "right":
            dx, dy = math.cos(heading + math.pi / 2), math.sin(heading + math.pi / 2)
        else:
            return {"status": "error", "reason": f'bad direction "{direction}"'}

        self._remember_position()
        self.state.x = _clamp(self.state.x + dx * distance_cells, 1, GRID_W - 2)
        self.state.y = _clamp(self.state.y + dy * distance_cells, 1, GRID_H - 2)
        return {
            "status": "success",
            "task": "move_robot",
            "direction": direction,
            "distance_cm": round(distance_cm, 1),
            "position_cm": self._position_cm(),
        }

    def _turn(self, args: dict) -> dict:
        degrees = _clamp(float(args.get("angle_degrees", 0)), -180, 180)
        self.state.heading = _normalize_rad(self.state.heading + math.radians(degrees))
        return {
            "status": "success",
            "task": "turn_robot",
            "turned_degrees": round(degrees, 1),
            "heading_degrees": round(math.degrees(self.state.heading), 1),
        }

    def _advance_toward(self, task: str, depth_m: float) -> dict:
        travel_cm = max(0, min(120, int(depth_m * 100) - 35))
        self._remember_position()
        cells = travel_cm / CM_PER_CELL
        self.state.x = _clamp(self.state.x + math.cos(self.state.heading) * cells, 1, GRID_W - 2)
        self.state.y = _clamp(self.state.y + math.sin(self.state.heading) * cells, 1, GRID_H - 2)
        return {
            "status": "success",
            "task": task,
            "traveled_cm": travel_cm,
            "position_cm": self._position_cm(),
        }

    def _remember_position(self):
        self.state.trail.append((self.state.x, self.state.y))
        if len(self.state.trail) > 80:
            self.state.trail.pop(0)

    def _position_cm(self) -> dict[str, int]:
        return {"x": round(self.state.x * CM_PER_CELL), "y": round(self.state.y * CM_PER_CELL)}

    def _heading_arrow(self) -> str:
        arrows = [">", "\\", "v", "/", "<", "\\", "^", "/"]
        idx = round(_normalize_rad(self.state.heading) / (math.pi / 4) + 8) % 8
        return arrows[idx]

    def render(self) -> str:
        grid = [[" "] * GRID_W for _ in range(GRID_H)]
        for x in range(GRID_W):
            grid[0][x] = "-"
            grid[GRID_H - 1][x] = "-"
        for y in range(GRID_H):
            grid[y][0] = "|"
            grid[y][GRID_W - 1] = "|"
        grid[0][0] = grid[0][GRID_W - 1] = "+"
        grid[GRID_H - 1][0] = grid[GRID_H - 1][GRID_W - 1] = "+"

        for tx, ty in self.state.trail:
            gx, gy = round(tx), round(ty)
            if 0 < gx < GRID_W - 1 and 0 < gy < GRID_H - 1:
                grid[gy][gx] = "."

        rx, ry = round(self.state.x), round(self.state.y)
        if 0 < rx < GRID_W - 1 and 0 < ry < GRID_H - 1:
            grid[ry][rx] = self._heading_arrow()

        stats = (
            f"pos={self._position_cm()['x']},{self._position_cm()['y']}cm  "
            f"heading={round(math.degrees(self.state.heading), 1)}deg  "
            f"gripper={self.state.gripper}  task={self.state.current_task}"
        )
        return "\n".join(["Physical world: 4m x 2m"] + ["".join(row) for row in grid] + [stats])

    def print(self):
        print("\n" + self.render() + "\n", flush=True)
