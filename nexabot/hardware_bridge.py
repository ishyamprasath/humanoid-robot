"""
Optional serial bridge — mirrors every tool call to real robot hardware.

If config.SERIAL_PORT is set and pyserial is installed, every brain
tool call is also written as one JSON line at 115 200 baud. Otherwise
this is a no-op and the simulator alone runs the show.
"""

from __future__ import annotations

import json

from config import SERIAL_BAUD, SERIAL_PORT


class HardwareBridge:
    def __init__(self, on_log=None):
        self.on_log = on_log or (lambda s: None)
        self._ser = None
        if not SERIAL_PORT:
            return
        try:
            import serial  # type: ignore
            self._ser = serial.Serial(SERIAL_PORT, SERIAL_BAUD, timeout=0.1)
            self.on_log(f"🔌 hardware connected on {SERIAL_PORT} @ {SERIAL_BAUD} baud")
        except ImportError:
            self.on_log("⚠️  pyserial not installed — hardware bridge disabled")
        except Exception as e:
            self.on_log(f"⚠️  serial open failed: {e}")

    @property
    def connected(self) -> bool:
        return self._ser is not None

    def send(self, name: str, args: dict):
        if not self._ser:
            return
        try:
            line = json.dumps({"cmd": name, "args": args}) + "\n"
            self._ser.write(line.encode("utf-8"))
        except Exception as e:
            self.on_log(f"⚠️  serial write failed: {e}")

    def close(self):
        if self._ser:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None
