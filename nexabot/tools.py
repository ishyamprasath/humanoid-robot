"""
Function declarations for exact robot tasks.

No gesture/body-language functions are exposed. The model must produce task
keywords and target coordinates that can be printed and executed from terminal.
"""

from google.genai import types


TASK_ENUM = [
    "observe_object",
    "approach_object",
    "pick_object",
    "release_object",
    "move_robot",
    "turn_robot",
    "stop_robot",
    "idle",
]


def build_tools() -> list[types.Tool]:
    return [
        types.Tool(
            function_declarations=[
                types.FunctionDeclaration(
                    name="execute_robot_task",
                    description=(
                        "Execute one exact humanoid robot task. Output must be usable "
                        "as JSON in a terminal or serial bridge. Do not use gestures."
                    ),
                    parameters={
                        "type": "OBJECT",
                        "properties": {
                            "task": {
                                "type": "STRING",
                                "enum": TASK_ENUM,
                                "description": "Exact task keyword.",
                            },
                            "task_keywords": {
                                "type": "ARRAY",
                                "items": {"type": "STRING"},
                                "description": "Minimal command keywords from the user.",
                            },
                            "target_label": {"type": "STRING"},
                            "target_coordinates": {
                                "type": "OBJECT",
                                "properties": {
                                    "x": {"type": "NUMBER"},
                                    "y": {"type": "NUMBER"},
                                    "z": {"type": "NUMBER"},
                                    "pixel_x": {"type": "NUMBER"},
                                    "pixel_y": {"type": "NUMBER"},
                                },
                            },
                            "direction": {
                                "type": "STRING",
                                "enum": ["forward", "backward", "left", "right"],
                            },
                            "distance_cm": {"type": "NUMBER"},
                            "angle_degrees": {"type": "NUMBER"},
                        },
                        "required": ["task", "task_keywords"],
                    },
                )
            ]
        )
    ]
