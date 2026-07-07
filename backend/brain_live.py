"""
Gemini Live brain — the robot's primary mind.

Streams mic PCM + camera JPEG up; receives spoken audio, tool calls,
and transcripts down. Built on the official google-genai SDK.
"""

from __future__ import annotations

import asyncio
from typing import Callable

from google import genai
from google.genai import types

# Monkey-patch websockets to disable ping_interval for Gemini Live API
import websockets.asyncio.client
_original_connect = websockets.asyncio.client.connect
def _patched_connect(*args, **kwargs):
    kwargs["ping_interval"] = None
    kwargs["ping_timeout"] = None
    return _original_connect(*args, **kwargs)
websockets.asyncio.client.connect = _patched_connect

from config import (GEMINI_API_KEY, GEMINI_API_VERSION, GEMINI_MODEL,
                    SEND_SAMPLE_RATE, SYSTEM_PROMPT, VOICE_NAME)
from tools import build_tools


class GeminiLiveBrain:
    def __init__(
        self,
        *,
        mic_queue: asyncio.Queue,
        on_audio: Callable[[bytes], None],
        on_tool_call: Callable[[str, dict], dict],
        on_input_transcript: Callable[[str], None],
        on_output_transcript: Callable[[str], None],
        on_interrupted: Callable[[], None],
        on_turn_complete: Callable[[], None],
        on_log: Callable[[str], None],
        on_video_frame: Callable[[bytes], None] | None = None,
        video_source=None,
    ):
        self._mic_q = mic_queue
        self._on_audio = on_audio
        self._on_tool_call = on_tool_call
        self._on_input_tx = on_input_transcript
        self._on_output_tx = on_output_transcript
        self._on_interrupted = on_interrupted
        self._on_turn_complete = on_turn_complete
        self._on_log = on_log
        self._on_video_frame = on_video_frame or (lambda b: None)
        self._video = video_source

        self._client = genai.Client(
            api_key=GEMINI_API_KEY,
            http_options={"api_version": GEMINI_API_VERSION},
        )
        self._session = None
        self._text_q: asyncio.Queue[str] = asyncio.Queue()

    def _config(self) -> types.LiveConnectConfig:
        return types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=VOICE_NAME),
                ),
            ),
            system_instruction=types.Content(parts=[types.Part(text=SYSTEM_PROMPT)]),
            tools=build_tools(),
            input_audio_transcription=types.AudioTranscriptionConfig(),
            output_audio_transcription=types.AudioTranscriptionConfig(),
        )

    def send_text(self, text: str):
        """Thread-safe-ish text injection (from the display client)."""
        self._text_q.put_nowait(text)

    async def run(self):
        self._on_log(f"connecting -> {GEMINI_MODEL} · voice {VOICE_NAME}")
        async with self._client.aio.live.connect(
            model=GEMINI_MODEL, config=self._config()
        ) as session:
            self._session = session
            self._on_log("online — listening & watching")

            await session.send_client_content(
                turns=types.Content(
                    role="user",
                    parts=[types.Part(text=(
                        "(System boot complete. Greet whoever is nearby warmly and "
                        "briefly in your own voice.)"
                    ))],
                ),
                turn_complete=True,
            )

            tasks = [
                asyncio.create_task(self._send_audio(), name="send_audio"),
                asyncio.create_task(self._send_text_loop(), name="send_text"),
                asyncio.create_task(self._receive(), name="receive"),
            ]
            if self._video and self._video.enabled:
                tasks.append(asyncio.create_task(self._send_video(), name="send_video"))
                self._on_log("camera stream enabled")

            try:
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
                for t in pending:
                    t.cancel()
                for t in done:
                    exc = t.exception()
                    if exc:
                        raise exc
            finally:
                self._session = None

    async def _send_audio(self):
        mime = f"audio/pcm;rate={SEND_SAMPLE_RATE}"
        while True:
            pcm = await self._mic_q.get()
            if self._session is None:
                return
            await self._session.send_realtime_input(
                audio=types.Blob(data=pcm, mime_type=mime),
            )

    async def _send_text_loop(self):
        while True:
            text = await self._text_q.get()
            if self._session is None:
                return
            await self._session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part(text=text)]),
                turn_complete=True,
            )

    async def _send_video(self):
        async for jpeg in self._video.frames():
            if self._session is None:
                return
            self._on_video_frame(jpeg)
            await self._session.send_realtime_input(
                video=types.Blob(data=jpeg, mime_type="image/jpeg"),
            )

    async def _receive(self):
        assert self._session is not None
        async for message in self._session.receive():
            if getattr(message, "data", None):
                self._on_audio(message.data)

            tc = getattr(message, "tool_call", None)
            if tc and tc.function_calls:
                responses = []
                for fc in tc.function_calls:
                    args = dict(fc.args) if fc.args else {}
                    result = self._on_tool_call(fc.name, args)
                    responses.append(types.FunctionResponse(
                        id=fc.id, name=fc.name, response={"result": result},
                    ))
                await self._session.send_tool_response(function_responses=responses)

            sc = getattr(message, "server_content", None)
            if sc is not None:
                itx = getattr(sc, "input_transcription", None)
                if itx and getattr(itx, "text", None):
                    self._on_input_tx(itx.text)
                otx = getattr(sc, "output_transcription", None)
                if otx and getattr(otx, "text", None):
                    self._on_output_tx(otx.text)
                if getattr(sc, "interrupted", False):
                    self._on_interrupted()
                if getattr(sc, "turn_complete", False):
                    self._on_turn_complete()
