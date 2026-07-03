"""
Terminal audio I/O — microphone in, speaker out.

Uses sounddevice (portable, no external binaries) to capture 16 kHz
mono PCM16 from the mic and play back 24 kHz mono PCM16 from Gemini.
Barge-in / interruption clears any queued speech instantly.
"""

from __future__ import annotations

import asyncio
import queue

import numpy as np
import sounddevice as sd

from config import MIC_CHUNK_SIZE, RECV_SAMPLE_RATE, SEND_SAMPLE_RATE


class MicCapture:
    """
    Captures mic audio in a background thread (sounddevice callback) and
    pushes raw PCM16 bytes into an asyncio.Queue for the send task to pull.
    """

    def __init__(self, out_queue: asyncio.Queue, loop: asyncio.AbstractEventLoop):
        self._out = out_queue
        self._loop = loop
        self._stream: sd.InputStream | None = None
        self._muted = False

    def _callback(self, indata, frames, time_info, status):
        if self._muted:
            return
        # indata is float32 shape (frames, 1); convert to PCM16 bytes
        pcm = np.clip(indata[:, 0] * 32767.0, -32768, 32767).astype(np.int16).tobytes()
        # Thread → asyncio: schedule the put on the main loop
        self._loop.call_soon_threadsafe(self._out.put_nowait, pcm)

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

    def stop(self):
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None


class SpeakerPlayer:
    """
    Plays queued PCM16 chunks (24 kHz mono) at Gemini's native rate.
    A worker thread drains an internal queue → sounddevice RawOutputStream.
    Call interrupt() to instantly drop everything pending (barge-in).
    """

    def __init__(self):
        self._q: queue.Queue[bytes | None] = queue.Queue()
        self._stream = sd.RawOutputStream(
            samplerate=RECV_SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=1024,
        )
        self._stream.start()
        self._worker = None
        self._running = True
        import threading
        self._worker = threading.Thread(target=self._drain, daemon=True)
        self._worker.start()

    def _drain(self):
        while self._running:
            try:
                chunk = self._q.get(timeout=0.2)
            except queue.Empty:
                continue
            if chunk is None:
                break
            try:
                self._stream.write(chunk)
            except Exception:
                pass

    def enqueue(self, pcm16_bytes: bytes):
        self._q.put(pcm16_bytes)

    def interrupt(self):
        """Drop everything queued — user barged in."""
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


def list_devices() -> str:
    """Human-readable summary of the available audio devices."""
    try:
        return str(sd.query_devices())
    except Exception as e:
        return f"(could not query audio devices: {e})"
