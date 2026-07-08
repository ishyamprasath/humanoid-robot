"""
CLI Handler for Robot Cognitive Core.
Maps text-based slash commands (e.g. /navigate 1.5 2.0) to actual backend tool executions.
"""

class CommandHandler:
    def __init__(self, core):
        self.core = core
        
        self.commands = {
            "/help": (self._do_help, "List all available commands."),
            "/move": (self._do_move, "Drive robot. Usage: /move [forward|backward|left|right] [cm]"),
            "/turn": (self._do_turn, "Turn robot. Usage: /turn [degrees]"),
            "/navigate": (self._do_navigate, "Go to coordinates. Usage: /navigate [x] [y] [speed]"),
            "/action": (self._do_action, "Camera frame action. Usage: /action [look_at|grasp|release|idle] [x] [y] [z]"),
            "/task": (self._do_task, "Open task. Usage: /task [type] [description]"),
            "/people": (self._do_people, "Get visible people. Usage: /people"),
            "/remember_person": (self._do_remember_person, "Save face. Usage: /remember_person [name]"),
            "/remember_fact": (self._do_remember_fact, "Save fact. Usage: /remember_fact [fact string]"),
            "/forget_person": (self._do_forget_person, "Delete face. Usage: /forget_person [name]"),
        }

    def execute(self, text: str) -> str:
        parts = text.split(" ", 1)
        cmd = parts[0].lower()
        args_str = parts[1].strip() if len(parts) > 1 else ""

        if cmd not in self.commands:
            return f"Unknown command '{cmd}'. Type /help for a list of commands."
        
        handler_func = self.commands[cmd][0]
        try:
            return handler_func(args_str)
        except Exception as e:
            return f"Error executing {cmd}: {e}"

    def _do_help(self, args_str: str) -> str:
        lines = ["Available commands:"]
        for cmd, (func, desc) in self.commands.items():
            lines.append(f"  {cmd.ljust(18)} : {desc}")
        return "\n".join(lines)

    def _do_move(self, args_str: str) -> str:
        args = args_str.split()
        if len(args) < 2: return "Usage: /move [direction] [cm]"
        res = self.core.robot.execute("move_robot", {
            "direction": args[0],
            "distance_cm": float(args[1])
        })
        return str(res)

    def _do_turn(self, args_str: str) -> str:
        if not args_str: return "Usage: /turn [degrees]"
        res = self.core.robot.execute("turn_robot", {
            "angle_degrees": float(args_str)
        })
        return str(res)

    def _do_navigate(self, args_str: str) -> str:
        args = args_str.split()
        if len(args) < 2: return "Usage: /navigate [x] [y] [speed]"
        kwargs = {"world_x": float(args[0]), "world_y": float(args[1])}
        if len(args) >= 3: kwargs["speed"] = float(args[2])
        res = self.core.robot.execute("navigate_to", kwargs)
        return str(res)

    def _do_action(self, args_str: str) -> str:
        args = args_str.split()
        if len(args) < 4: return "Usage: /action [type] [x] [y] [z]"
        res = self.core.robot.execute("execute_robot_action", {
            "action_type": args[0],
            "target_coordinates": {
                "x": float(args[1]),
                "y": float(args[2]),
                "z": float(args[3])
            }
        })
        return str(res)

    def _do_task(self, args_str: str) -> str:
        parts = args_str.split(" ", 1)
        if len(parts) < 2: return "Usage: /task [type] [description]"
        res = self.core.robot.execute("execute_task", {
            "task_type": parts[0],
            "description": parts[1]
        })
        return str(res)
        
    def _do_people(self, args_str: str) -> str:
        return f"People visible: {sorted(self.core.roster_cache)}"

    def _do_remember_person(self, args_str: str) -> str:
        if not args_str: return "Usage: /remember_person [name]"
        return str(self.core._face_command("remember_person", name=args_str))
        
    def _do_remember_fact(self, args_str: str) -> str:
        if not args_str: return "Usage: /remember_fact [fact string]"
        return str(self.core._face_command("remember_fact", fact=args_str))

    def _do_forget_person(self, args_str: str) -> str:
        if not args_str: return "Usage: /forget_person [name]"
        return str(self.core._face_command("forget_person", name=args_str))
