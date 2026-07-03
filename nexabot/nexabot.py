"""
NexaBot terminal task runner.

Run:
    python nexabot.py

Behavior:
- Terminal is the only conversation surface.
- Camera preview opens in a separate OpenCV window when available.
- Every command prints one strict JSON task object in the terminal.
- Object coordinates come from the camera module and are included in JSON.
- No gestures are generated or executed.
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from typing import Any

VENDOR_DIR = Path(__file__).resolve().parent / ".vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

from config import TASK_SCHEMA_VERSION
from hardware_bridge import HardwareBridge
from robot_sim import C, RobotSimulator, paint
from video_io import CameraWindow


COLORS = {"red", "orange", "yellow", "green", "blue", "purple", "white", "black"}
MOVE_DIRECTIONS = {"forward", "backward", "left", "right"}


def now_ts() -> str:
    return time.strftime("%H:%M:%S")


def log(message: str):
    print(f"{paint(C.DIM, '[' + now_ts() + ']')} {message}", flush=True)


def banner():
    print()
    print(paint(C.BOLD + C.CYAN, "NexaBot - Terminal Task Model"))
    print("Typed command -> JSON task output. Camera preview opens separately when available.")
    print("Commands: /help, /coords [color], /objects, /map, /quit")
    print()


def enable_ansi_on_windows():
    if sys.platform.startswith("win"):
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
        except Exception:
            pass


class TerminalTaskPlanner:
    """Deterministic terminal parser that emits exact task JSON."""

    def __init__(self, camera: CameraWindow, sim: RobotSimulator, bridge: HardwareBridge):
        self.camera = camera
        self.sim = sim
        self.bridge = bridge

    def plan(self, text: str) -> dict[str, Any]:
        raw = text.strip()
        words = self._words(raw)
        task = self._task_from_words(words)
        target_text = " ".join(words)
        object_info = self._object_info(task, target_text)
        command = self._command_for(task, raw, words, object_info)
        sim_result = self.sim.execute(command["cmd"], command["args"])
        self.bridge.send(command["cmd"], command["args"])

        return {
            "schema": TASK_SCHEMA_VERSION,
            "timestamp": now_ts(),
            "input": raw,
            "task": task,
            "task_keywords": self._task_keywords(task, words, object_info),
            "object": object_info,
            "command": command,
            "result": sim_result,
            "terminal_output": self._terminal_output(task, object_info, sim_result),
        }

    def coords(self, target_text: str) -> dict[str, Any]:
        info = self.camera.snapshot(target_text)
        return {
            "schema": TASK_SCHEMA_VERSION,
            "timestamp": now_ts(),
            "task": "observe_object",
            "task_keywords": self._keywords_from_text("observe " + target_text),
            "object": info,
            "command": {
                "cmd": "execute_robot_task",
                "args": self._task_args("observe_object", ["observe"], info),
            },
            "terminal_output": self._terminal_output("observe_object", info, {"status": "not_executed"}),
        }

    def _words(self, text: str) -> list[str]:
        return re.findall(r"[a-zA-Z0-9.]+", text.lower())

    def _task_from_words(self, words: list[str]) -> str:
        word_set = set(words)
        if {"quit", "exit"} & word_set:
            return "idle"
        if {"stop", "halt", "pause"} & word_set:
            return "stop_robot"
        if {"release", "drop", "open"} & word_set:
            return "release_object"
        if {"pick", "pickup", "grab", "grasp", "take", "hold"} & word_set:
            return "pick_object"
        if {"approach", "near", "closer", "goto", "go"} & word_set and not (word_set & MOVE_DIRECTIONS):
            return "approach_object"
        if {"find", "locate", "see", "look", "where", "observe", "detect", "coordinate", "coordinates"} & word_set:
            return "observe_object"
        if "turn" in word_set or "rotate" in word_set:
            return "turn_robot"
        if {"move", "walk", "drive"} & word_set or word_set & MOVE_DIRECTIONS:
            return "move_robot"
        return "idle"

    def _object_info(self, task: str, target_text: str) -> dict[str, Any]:
        if task not in {"observe_object", "approach_object", "pick_object"}:
            return {
                "visible": False,
                "reason": "object_not_required_for_task",
                "coordinates": None,
            }
        return self.camera.snapshot(target_text)

    def _command_for(
        self,
        task: str,
        raw: str,
        words: list[str],
        object_info: dict[str, Any],
    ) -> dict[str, Any]:
        if task == "move_robot":
            direction = next((w for w in words if w in MOVE_DIRECTIONS), "forward")
            distance_cm = self._number_after(words, {"cm", "centimeter", "centimeters"}) or self._first_number(words) or 30
            return {
                "cmd": "execute_robot_task",
                "args": {
                    "task": task,
                    "task_keywords": self._keywords_from_text(raw),
                    "direction": direction,
                    "distance_cm": float(distance_cm),
                },
            }

        if task == "turn_robot":
            angle = self._first_number(words) or 45
            if "left" in words:
                angle = -abs(float(angle))
            elif "right" in words:
                angle = abs(float(angle))
            return {
                "cmd": "execute_robot_task",
                "args": {
                    "task": task,
                    "task_keywords": self._keywords_from_text(raw),
                    "angle_degrees": float(angle),
                },
            }

        return {
            "cmd": "execute_robot_task",
            "args": self._task_args(task, self._keywords_from_text(raw), object_info),
        }

    def _task_args(self, task: str, keywords: list[str], object_info: dict[str, Any]) -> dict[str, Any]:
        args: dict[str, Any] = {"task": task, "task_keywords": keywords}
        if object_info.get("visible"):
            args["target_label"] = object_info.get("label", "object")
            coords = object_info.get("coordinates") or {}
            args["target_coordinates"] = {
                "x": coords.get("x"),
                "y": coords.get("y"),
                "z": coords.get("z"),
                "pixel_x": coords.get("pixel_x"),
                "pixel_y": coords.get("pixel_y"),
            }
        return args

    def _task_keywords(self, task: str, words: list[str], object_info: dict[str, Any]) -> list[str]:
        keywords = self._keywords_from_text(" ".join(words))
        if task not in keywords:
            keywords.insert(0, task)
        color = object_info.get("color")
        if color and color not in keywords:
            keywords.append(color)
        return keywords[:10]

    def _keywords_from_text(self, text: str) -> list[str]:
        words = self._words(text)
        keep = []
        for word in words:
            if (
                word in COLORS
                or word in MOVE_DIRECTIONS
                or word in {
                    "find",
                    "locate",
                    "observe",
                    "look",
                    "pick",
                    "grab",
                    "release",
                    "drop",
                    "approach",
                    "move",
                    "walk",
                    "turn",
                    "rotate",
                    "stop",
                    "idle",
                    "object",
                    "cup",
                    "bottle",
                    "box",
                    "ball",
                }
            ):
                keep.append(word)
        return list(dict.fromkeys(keep)) or ["idle"]

    def _first_number(self, words: list[str]) -> float | None:
        for word in words:
            try:
                return float(word)
            except ValueError:
                continue
        return None

    def _number_after(self, words: list[str], units: set[str]) -> float | None:
        for index, word in enumerate(words):
            if word in units and index > 0:
                try:
                    return float(words[index - 1])
                except ValueError:
                    return None
        return None

    def _terminal_output(self, task: str, object_info: dict[str, Any], result: dict[str, Any]) -> str:
        if object_info.get("visible"):
            coords = object_info.get("coordinates") or {}
            return (
                f"TASK={task} OBJECT={object_info.get('label')} "
                f"COORDS=x:{coords.get('x')} y:{coords.get('y')} z:{coords.get('z')} "
                f"PIXEL={coords.get('pixel_x')},{coords.get('pixel_y')} "
                f"STATUS={result.get('status')}"
            )
        reason = object_info.get("reason", "no_object")
        return f"TASK={task} OBJECT=none REASON={reason} STATUS={result.get('status')}"


def print_json(data: dict[str, Any]):
    print(json.dumps(data, indent=2, sort_keys=False), flush=True)


def print_help():
    examples = {
        "find red object": "observe object and print camera coordinates",
        "pick blue object": "pick target if z <= 1.5m",
        "approach yellow cup": "turn toward target and move closer",
        "move forward 40": "move base 40 cm",
        "turn left 45": "rotate left 45 degrees",
        "/coords red": "print latest red object coordinates without executing",
        "/objects": "print all current camera detections",
        "/map": "print terminal robot state",
    }
    print_json({"schema": TASK_SCHEMA_VERSION, "help": examples})


def main():
    enable_ansi_on_windows()
    banner()

    camera = CameraWindow(on_log=log)
    camera.start()

    bridge = HardwareBridge(on_log=log)
    sim = RobotSimulator(on_action=lambda _name, _args, _result: None)
    planner = TerminalTaskPlanner(camera, sim, bridge)

    try:
        while True:
            try:
                line = input(paint(C.BOLD + C.GREEN, "task> ")).strip()
            except EOFError:
                break
            if not line:
                continue

            lower = line.lower()
            if lower in {"/quit", "/exit", "quit", "exit"}:
                break
            if lower == "/help":
                print_help()
                continue
            if lower == "/map":
                sim.print()
                continue
            if lower.startswith("/coords"):
                print_json(planner.coords(line.removeprefix("/coords").strip()))
                continue
            if lower == "/objects":
                print_json(
                    {
                        "schema": TASK_SCHEMA_VERSION,
                        "timestamp": now_ts(),
                        "task": "observe_object",
                        "objects": camera.detections_json(),
                    }
                )
                continue

            output = planner.plan(line)
            print_json(output)
    finally:
        camera.stop()
        bridge.close()
        log("shutdown complete")


if __name__ == "__main__":
    main()
