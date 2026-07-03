"""
Gemini Live client — the primary robot brain.

Streams microphone audio + optional camera JPEG frames up, and streams
audio + tool calls + transcripts back. Uses the official google-genai
SDK so we get proper WebSocket handling, backoff, and typed events.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Awaitable, Callable

from google import genai
from google.genai import types

from config import (
    GEMINI_API_KEY,
    GEMINI_API_VERSION,
    GEMINI_MODEL,
    SEND_SAMPLE_RATE,
    SYSTEM_PROMPT,
    VOICE_NAME,
)
from tools import build_tools


class GeminiLiveBrain:
    """
    Thin async wrapper around google-genai's Live session that plugs the
    robot's senses (mic + camera) and body (tool executor + speaker) into
    a single running conversation.
    """

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
        video_source=None,   # optional CameraFeed
    ):
        self._mic_q = mic_queue
        self._on_audio = on_audio
        self._on_tool_call = on_tool_call
        self._on_input_tx = on_input_transcript
        self._on_output_tx = on_output_transcript
        self._on_interrupted = on_interrupted
        self._on_turn_complete = on_turn_complete
        self._on_log = on_log
        self._video = video_source

        self._client = genai.Client(
            api_key=GEMINI_API_KEY,
            http_options={"api_version": GEMINI_API_VERSION},
        )
        self._session = None

    # ------------------------------------------------------------------
    # Config assembly
    # ------------------------------------------------------------------
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

    # ------------------------------------------------------------------
    # Public entry — opens the session and runs three concurrent tasks
    # ------------------------------------------------------------------
    async def run(self):
        self._on_log(f"connecting → {GEMINI_MODEL} · voice {VOICE_NAME}")

        async with self._client.aio.live.connect(
            model=GEMINI_MODEL, config=self._config()
        ) as session:
            self._session = session
            self._on_log("🟢 online — talk into your mic, I'm listening.")

            # Kick off the conversation with a system boot message.
            await session.send_client_content(
                turns=types.Content(
                    role="user",
                    parts=[types.Part(text=(
                        "(System boot complete. Greet whoever is listening warmly "
                        "and briefly in your own voice. Wave if it feels right.)"
                    ))],
                ),
                turn_complete=True,
            )

            tasks = [
                asyncio.create_task(self._send_audio(), name="send_audio"),
                asyncio.create_task(self._receive(),   name="receive"),
            ]
            if self._video and self._video.enabled:
                tasks.append(asyncio.create_task(self._send_video(), name="send_video"))
                self._on_log("📷 camera stream enabled — I can see")

            try:
                # Run until any task fails (or Ctrl+C from outside)
                done, pending = await asyncio.wait(
                    tasks, return_when=asyncio.FIRST_EXCEPTION
                )
                for t in pending:
                    t.cancel()
                for t in done:
                    exc = t.exception()
                    if exc:
                        raise exc
            finally:
                self._session = None

    # ------------------------------------------------------------------
    # Send: mic → Gemini
    # ------------------------------------------------------------------
    async def _send_audio(self):
        mime = f"audio/pcm;rate={SEND_SAMPLE_RATE}"
        while True:
            pcm = await self._mic_q.get()
            if self._session is None:
                return
            await self._session.send_realtime_input(
                audio=types.Blob(data=pcm, mime_type=mime),
            )

    # ------------------------------------------------------------------
    # Send: camera → Gemini (optional)
    # ------------------------------------------------------------------
    async def _send_video(self):
        assert self._video is not None
        async for jpeg in self._video.frames():
            if self._session is None:
                return
            await self._session.send_realtime_input(
                video=types.Blob(data=jpeg, mime_type="image/jpeg"),
            )

    # ------------------------------------------------------------------
    # Receive: Gemini → speaker + tool executor + transcripts
    # ------------------------------------------------------------------
    async def _receive(self):
        assert self._session is not None
        async for message in self._session.receive():
            # Audio out
            if getattr(message, "data", None):
                self._on_audio(message.data)

            # Tool calls — execute locally, send FunctionResponses back
            tc = getattr(message, "tool_call", None)
            if tc and tc.function_calls:
                responses = []
                for fc in tc.function_calls:
                    args = dict(fc.args) if fc.args else {}
                    result = self._on_tool_call(fc.name, args)
                    responses.append(
                        types.FunctionResponse(
                            id=fc.id, name=fc.name, response={"result": result}
                        )
                    )
                await self._session.send_tool_response(function_responses=responses)

            # Server content — transcripts, interruption, turn completion
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
