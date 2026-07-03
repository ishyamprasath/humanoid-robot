"""
Robot body — tool executor + world-frame state + task queue.

This is the swap point for ROS 2 Jazzy: today `Robot.execute()` updates
an internal world model and returns simulated results; on the real robot
the same method will publish /cmd_vel, Nav2 NavigateToPose goals, gripper
actions, etc. (see ros2 notes at the bottom). Nothing upstream (the
Gemini brain) needs to change.

World frame: meters, origin (0,0) at room center, +x = east, +y = north.
Heading: radians, 0 = east, pi/2 = north.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from config import ROOM_HALF_METERS

CAMERA_HFOV = math.pi / 3  # 60 degrees horizontal field of view

TASK_TYPES = ["fetch", "deliver", "inspect", "follow", "greet", "patrol", "return_home", "wait"]


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _norm_rad(r: float) -> float:
    while r > math.pi:
        r -= 2 * math.pi
    while r < -math.pi:
        r += 2 * math.pi
    return r


def _round2(n: float) -> float:
    return round(n, 2)


@dataclass
class Task:
    id: int
    type: str
    description: str
    target: dict | None      # {"x": m, "y": m} world frame, or None
    priority: str
    status: str               # "active" | "completed"
    created_at: float

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "description": self.description,
            "target": self.target,
            "priority": self.priority,
            "status": self.status,
            "created_at": self.created_at,
        }


@dataclass
class RobotState:
    x: float = 0.0
    y: float = 0.0
    heading: float = math.pi / 2      # facing north
    gripper: str = "open"
    look_target: dict | None = None   # {"cam":{x,y,z}, "world":{x,y}}


class Robot:
    """Executes brain tool calls; emits state via callbacks."""

    def __init__(
        self,
        on_action: Callable[[str, dict, dict], None] | None = None,
        on_state: Callable[[dict], None] | None = None,
    ):
        self.state = RobotState()
        self.tasks: list[Task] = []
        self._next_task_id = 1
        self.on_action = on_action or (lambda *a: None)
        self.on_state = on_state or (lambda s: None)

    # ------------------------------------------------------------
    # Dispatch — name + args from the Live API -> result dict back
    # ------------------------------------------------------------
    def execute(self, name: str, args: dict | None) -> dict:
        args = args or {}
        try:
            handler = {
                "move_robot": self._move_robot,
                "turn_robot": self._turn_robot,
                "navigate_to": self._navigate_to,
                "execute_robot_action": self._robot_action,
                "execute_task": self._execute_task,
            }.get(name)
            result = handler(args) if handler else {"status": "error", "reason": f'unknown tool "{name}"'}
        except Exception as e:  # noqa: BLE001 — tool results must never crash the session
            result = {"status": "error", "reason": str(e)}

        self.on_action(name, args, result)
        self.on_state(self.snapshot())
        return result

    # ------------------------------------------------------------
    # Motor primitives
    # ------------------------------------------------------------
    def _move_robot(self, args: dict) -> dict:
        s = self.state
        direction = args.get("direction", "")
        dist = _clamp(float(args.get("distance_cm") or 0), 0, 300) / 100.0  # meters
        h = s.heading
        vec = {
            "forward":  (math.cos(h),  math.sin(h)),
            "backward": (-math.cos(h), -math.sin(h)),
            "left":     (math.cos(h + math.pi / 2), math.sin(h + math.pi / 2)),
            "right":    (math.cos(h - math.pi / 2), math.sin(h - math.pi / 2)),
        }.get(direction)
        if vec is None:
            return {"status": "error", "reason": f'bad direction "{direction}"'}
        lim = ROOM_HALF_METERS - 0.1
        s.x = _clamp(s.x + vec[0] * dist, -lim, lim)
        s.y = _clamp(s.y + vec[1] * dist, -lim, lim)
        return {
            "status": "success",
            "direction": direction,
            "distance_cm": dist * 100,
            "world_position_m": {"x": _round2(s.x), "y": _round2(s.y)},
        }

    def _turn_robot(self, args: dict) -> dict:
        deg = _clamp(float(args.get("angle_degrees") or 0), -180, 180)
        # positive = clockwise (right) -> decreasing heading in ENU convention
        self.state.heading = _norm_rad(self.state.heading - math.radians(deg))
        return {
            "status": "success",
            "turned_degrees": deg,
            "heading_degrees": self.heading_degrees(),
        }

    def _navigate_to(self, args: dict) -> dict:
        lim = ROOM_HALF_METERS - 0.1
        wx = _clamp(float(args.get("world_x") or 0), -lim, lim)
        wy = _clamp(float(args.get("world_y") or 0), -lim, lim)
        speed = _clamp(float(args.get("speed") or 0.6), 0.1, 1.0)
        s = self.state
        dx, dy = wx - s.x, wy - s.y
        dist = math.hypot(dx, dy)
        if dist > 0.01:
            s.heading = math.atan2(dy, dx)
        s.x, s.y = wx, wy
        return {
            "status": "success",
            "destination_m": {"x": _round2(wx), "y": _round2(wy)},
            "distance_m": _round2(dist),
            "speed": speed,
        }

    def _robot_action(self, args: dict) -> dict:
        t = args.get("target_coordinates") or {}
        p = args.get("parameters") or {}
        cam_x = _clamp(float(t.get("x") or 0.5), 0, 1)
        cam_y = _clamp(float(t.get("y") or 0.5), 0, 1)
        cam_z = _clamp(float(t.get("z") or 0), 0, 2)
        world = self._camera_to_world(cam_x, cam_z)
        action = args.get("action_type", "")
        s = self.state

        if action == "look_at":
            # pan toward the horizontal offset
            s.heading = _norm_rad(s.heading - (cam_x - 0.5) * CAMERA_HFOV)
            s.look_target = {
                "cam": {"x": cam_x, "y": cam_y, "z": cam_z},
                "world": {"x": _round2(world[0]), "y": _round2(world[1])},
            }
            return {
                "status": "success",
                "camera_frame": {"x": cam_x, "y": cam_y, "z": cam_z},
                "world_frame_m": {"x": _round2(world[0]), "y": _round2(world[1])},
            }

        if action == "grasp":
            if cam_z > 1.5:
                return {
                    "status": "error",
                    "reason": f"target {cam_z:.2f} m is beyond the 1.5 m arm reach — navigate closer first.",
                }
            force = _clamp(float(p.get("grip_force") or 0.5), 0, 1)
            s.gripper = "closed"
            s.look_target = {
                "cam": {"x": cam_x, "y": cam_y, "z": cam_z},
                "world": {"x": _round2(world[0]), "y": _round2(world[1])},
            }
            return {"status": "success", "gripper": "closed", "grip_force": force, "object_secured": True}

        if action == "release":
            s.gripper = "open"
            return {"status": "success", "gripper": "open"}

        if action == "idle":
            return {"status": "success", "action": "idle"}

        return {"status": "error", "reason": f'unknown action_type "{action}"'}

    def _execute_task(self, args: dict) -> dict:
        task_type = args.get("task_type", "")
        if task_type not in TASK_TYPES:
            return {"status": "error", "reason": f'unknown task_type "{task_type}"'}
        tc = args.get("target_coordinates") or {}
        target = None
        if "world_x" in tc or "world_y" in tc:
            target = {"x": _round2(float(tc.get("world_x") or 0)), "y": _round2(float(tc.get("world_y") or 0))}

        for t in self.tasks:
            if t.status == "active":
                t.status = "completed"

        task = Task(
            id=self._next_task_id,
            type=task_type,
            description=args.get("description") or f"{task_type} task",
            target=target,
            priority=args.get("priority") or "normal",
            status="active",
            created_at=time.time(),
        )
        self._next_task_id += 1
        self.tasks.insert(0, task)
        del self.tasks[20:]
        return {
            "status": "success",
            "task_id": task.id,
            "task_type": task.type,
            "description": task.description,
            "target_world_m": target,
            "priority": task.priority,
        }

    # ------------------------------------------------------------
    # Helpers / state export
    # ------------------------------------------------------------
    def _camera_to_world(self, cam_x: float, cam_z: float) -> tuple[float, float]:
        yaw = self.state.heading - (cam_x - 0.5) * CAMERA_HFOV
        return (self.state.x + math.cos(yaw) * cam_z,
                self.state.y + math.sin(yaw) * cam_z)

    def heading_degrees(self) -> int:
        deg = math.degrees(self.state.heading) % 360
        return int(round(deg))

    def snapshot(self) -> dict:
        s = self.state
        return {
            "pose": {"x": _round2(s.x), "y": _round2(s.y), "heading_deg": self.heading_degrees()},
            "gripper": s.gripper,
            "look_target": s.look_target,
            "tasks": [t.to_dict() for t in self.tasks],
        }


# =================================================================
# ROS 2 Jazzy migration notes (the whole point of this class):
#
#   move_robot / turn_robot  -> geometry_msgs/Twist on /cmd_vel
#                               (timed open-loop, or odom-closed-loop)
#   navigate_to              -> nav2_msgs/action/NavigateToPose goal
#                               (map frame; feed back result into the
#                                returned dict so the LLM knows it arrived)
#   look_at                  -> head pan/tilt JointTrajectory
#   grasp / release          -> control_msgs/action/GripperCommand
#   execute_task             -> custom action /robot/task, executed by a
#                               behavior-tree or state-machine node
#
# Keep this class's signature identical; implement a Ros2Robot(Robot)
# subclass whose handlers publish instead of simulating, then inject it
# in main.py. The Gemini brain never knows the difference.
# =================================================================
