// ============================================================
// Audio I/O — browser mic in (16 kHz PCM16), Gemini audio out (24 kHz).
//
// Capture runs in an AudioWorklet on the realtime audio thread with
// hardware echo cancellation from getUserMedia — so the robot does NOT
// hear itself and you can barge in mid-sentence (full duplex, no gating).
// Playback schedules PCM buffers gaplessly; interrupt() cuts instantly.
// ============================================================

import { RECV_SAMPLE_RATE, SEND_SAMPLE_RATE } from "./config.js";
import workletUrl from "./pcm-worklet.js?url";

export class MicCapture {
  constructor({ onChunk, onLevel }) {
    this.onChunk = onChunk;
    this.onLevel = onLevel || (() => {});
    this.muted = false;
    this._ctx = null;
    this._stream = null;
    this._node = null;
  }

  async start() {
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SEND_SAMPLE_RATE,
        echoCancellation: true,   // the robot must not hear itself
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this._ctx = new AudioContext({ sampleRate: SEND_SAMPLE_RATE, latencyHint: "interactive" });
    if (this._ctx.state === "suspended") await this._ctx.resume();
    await this._ctx.audioWorklet.addModule(workletUrl);
    const src = this._ctx.createMediaStreamSource(this._stream);
    this._node = new AudioWorkletNode(this._ctx, "pcm16-capture");
    this._node.port.onmessage = (e) => {
      if (this.muted) {
        this.onLevel(0);
        return;
      }
      this.onLevel(e.data.rms);
      this.onChunk(new Uint8Array(e.data.pcm));
    };
    src.connect(this._node);
    // worklet has no output; no need to reach the destination
  }

  setMuted(muted) {
    this.muted = muted;
  }

  label() {
    const track = this._stream?.getAudioTracks?.()[0];
    return track ? track.label : "mic";
  }

  stop() {
    try { this._node?.disconnect(); } catch {}
    try { this._stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { this._ctx?.close(); } catch {}
    this._node = this._stream = this._ctx = null;
  }
}

export class SpeakerPlayer {
  constructor({ onSpeaking }) {
    this.onSpeaking = onSpeaking || (() => {});
    this._ctx = new AudioContext({ sampleRate: RECV_SAMPLE_RATE, latencyHint: "interactive" });
    this._nextTime = 0;
    this._sources = new Set();
  }

  async resume() {
    if (this._ctx.state === "suspended") await this._ctx.resume();
  }

  /** Enqueue a PCM16 mono chunk (Uint8Array) for gapless playback. */
  play(bytes) {
    if (bytes.byteLength < 2) return;
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const buf = this._ctx.createBuffer(1, f32.length, RECV_SAMPLE_RATE);
    buf.getChannelData(0).set(f32);

    const src = this._ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this._ctx.destination);
    const t = Math.max(this._ctx.currentTime + 0.012, this._nextTime);
    src.start(t);
    this._nextTime = t + buf.duration;
    this._sources.add(src);
    src.onended = () => {
      this._sources.delete(src);
      if (!this._sources.size) this.onSpeaking(false);
    };
    this.onSpeaking(true);
  }

  /** Barge-in: drop everything queued, silence immediately. */
  interrupt() {
    for (const s of this._sources) {
      try { s.stop(); } catch {}
    }
    this._sources.clear();
    this._nextTime = 0;
    this.onSpeaking(false);
  }

  stop() {
    this.interrupt();
    try { this._ctx.close(); } catch {}
  }
}
