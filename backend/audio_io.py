"""
Audio I/O — system microphone in, system speaker out.

sounddevice (PortAudio) keeps this portable across Windows / Linux /
the robot's SBC. Mic: 16 kHz mono PCM16 chunks. Speaker: 24 kHz mono
PCM16 with instant barge-in interruption.
"""

from __future__ import annotations

import asyncio
import queue
import threading

import numpy as np
import sounddevice as sd

from config import MIC_CHUNK_SIZE, RECV_SAMPLE_RATE, SEND_SAMPLE_RATE


class MicCapture:
    """Background-thread capture -> asyncio queue of PCM16 bytes."""

    def __init__(self, out_queue: asyncio.Queue, loop: asyncio.AbstractEventLoop,
                 on_level=None):
        self._out = out_queue
        self._loop = loop
        self._stream: sd.InputStream | None = None
        self._muted = False
        self.on_level = on_level or (lambda rms: None)

    def _callback(self, indata, frames, time_info, status):
        if self._muted:
            self.on_level(0.0)
            return
        samples = indata[:, 0]
        rms = float(np.sqrt(np.mean(samples * samples)))
        self.on_level(rms)
        pcm = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16).tobytes()
        try:
            self._loop.call_soon_threadsafe(self._out.put_nowait, pcm)
        except RuntimeError:
            pass  # loop closed during shutdown

    def start(self):
        self._stream = sd.InputStream(
            samplerate=SEND_SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=MIC_CHUNK_SIZE,
            callback=self._callback,
        )
        self._stream.start()

    def set_muted(self, muted: bool):
        self._muted = muted

    @property
    def muted(self) -> bool:
        return self._muted

    def stop(self):
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None


class SpeakerPlayer:
    """Queued PCM16 playback at Gemini's 24 kHz; interrupt() drops the queue."""

    def __init__(self, on_speaking=None):
        self._q: queue.Queue[bytes | None] = queue.Queue()
        self._running = True
        self.on_speaking = on_speaking or (lambda speaking: None)
        self._stream = sd.RawOutputStream(
            samplerate=RECV_SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=1024,
        )
        self._stream.start()
        self._worker = threading.Thread(target=self._drain, daemon=True)
        self._worker.start()

    def _drain(self):
        speaking = False
        while self._running:
            try:
                chunk = self._q.get(timeout=0.15)
            except queue.Empty:
                if speaking:
                    speaking = False
                    self.on_speaking(False)
                continue
            if chunk is None:
                break
            if not speaking:
                speaking = True
                self.on_speaking(True)
            try:
                self._stream.write(chunk)
            except Exception:
                pass
        if speaking:
            self.on_speaking(False)

    def enqueue(self, pcm16: bytes):
        self._q.put(pcm16)

    def interrupt(self):
        try:
            while True:
                self._q.get_nowait()
        except queue.Empty:
            pass

    def stop(self):
        self._running = False
        self._q.put(None)
        try:
            self._stream.stop()
            self._stream.close()
        except Exception:
            pass
