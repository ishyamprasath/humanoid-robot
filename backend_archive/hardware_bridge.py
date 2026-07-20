"""
Optional USB serial bridge — mirrors every tool call to microcontroller
hardware (the firmware/ ESP32 sketch) as one JSON line at 115200 baud.
No-op unless SERIAL_PORT is set in .env and pyserial is installed.
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
            self.on_log(f"hardware connected on {SERIAL_PORT} @ {SERIAL_BAUD}")
        except ImportError:
            self.on_log("pyserial not installed — hardware bridge disabled")
        except Exception as e:
            self.on_log(f"serial open failed: {e}")

    @property
    def connected(self) -> bool:
        return self._ser is not None

    def send(self, name: str, args: dict):
        if not self._ser:
            return
        try:
            self._ser.write((json.dumps({"cmd": name, "args": args}) + "\n").encode())
        except Exception as e:
            self.on_log(f"serial write failed: {e}")

    def close(self):
        if self._ser:
            try:
                self._ser.close()
            except Exception:
                pass
            self._ser = None
