"""
State server — the bridge between the Python cognitive core and the
robot's 8" display.

Two endpoints:
  http://<host>:HTTP_PORT   — serves the frontend/ display client (static)
  ws://<host>:WS_PORT       — full-duplex state stream

Server -> display messages (JSON):
  {type:"status", state:"offline|connecting|online|error", detail}
  {type:"transcript", role:"user"|"robot", text}          (streamed deltas)
  {type:"turn_complete"}
  {type:"speaking", active:bool}
  {type:"mic_level", rms:float}
  {type:"robot", pose:{x,y,heading_deg}, gripper, look_target, tasks:[…]}
  {type:"action", name, args, result, ts}
  {type:"frame", jpeg_b64}                                 (camera, ~1 fps)
  {type:"log", text, ts}
  {type:"interrupted"}

Display -> server commands (JSON):
  {type:"power", on:bool}
  {type:"mute", muted:bool}
  {type:"text", text:str}
"""

from __future__ import annotations

import asyncio
import functools
import http.server
import json
import threading
from typing import Awaitable, Callable

import websockets

from config import FRONTEND_DIR, HTTP_PORT, WS_PORT


class StateServer:
    def __init__(self, on_command: Callable[[dict], Awaitable[None]]):
        self._on_command = on_command
        self._clients: set = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._snapshot: dict[str, dict] = {}   # last message per replayable type

    # ------------------------------------------------------------
    async def start(self):
        self._loop = asyncio.get_running_loop()

        # Static frontend on a plain http.server thread (zero-dep, fine for a kiosk)
        handler = functools.partial(
            http.server.SimpleHTTPRequestHandler, directory=str(FRONTEND_DIR)
        )
        httpd = http.server.ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()

        await websockets.serve(self._handler, "0.0.0.0", WS_PORT)

    async def _handler(self, ws):
        self._clients.add(ws)
        try:
            # replay the latest snapshot so a freshly-booted display syncs instantly
            for msg in self._snapshot.values():
                await ws.send(json.dumps(msg))
            async for raw in ws:
                try:
                    cmd = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(cmd, dict):
                    await self._on_command(cmd)
        except websockets.ConnectionClosed:
            pass
        finally:
            self._clients.discard(ws)

    # ------------------------------------------------------------
    def broadcast(self, msg: dict):
        """Send to every connected display. Safe to call from any thread."""
        if msg.get("type") in ("status", "robot", "speaking", "frame"):
            self._snapshot[msg["type"]] = msg
        if self._loop is None:
            return
        data = json.dumps(msg)
        self._loop.call_soon_threadsafe(self._fanout, data)

    def _fanout(self, data: str):
        for ws in list(self._clients):
            asyncio.ensure_future(self._safe_send(ws, data))

    @staticmethod
    async def _safe_send(ws, data: str):
        try:
            await ws.send(data)
        except Exception:
            pass
