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
    this._ctx = new AudioContext({ latencyHint: "interactive" });
    this._nextTime = 0;
    this._sources = new Set();

    // Analyser tap for real lip-sync: every buffer plays THROUGH this node on
    // its way to the speakers, so getLevel() reflects the robot's actual voice.
    this._analyser = this._ctx.createAnalyser();
    this._analyser.fftSize = 256;
    this._analyser.smoothingTimeConstant = 0.6;
    this._analyser.connect(this._ctx.destination);
    this._buf = new Uint8Array(this._analyser.fftSize);
    this._level = 0;
  }

  async resume() {
    if (this._ctx.state === "suspended") await this._ctx.resume();
  }

  /**
   * Current output loudness, 0..1, smoothed. ~0 when silent. Read once per
   * animation frame to drive the robot mouth. Cheap: one time-domain read.
   */
  getLevel() {
    this._analyser.getByteTimeDomainData(this._buf);
    let sumSq = 0;
    for (let i = 0; i < this._buf.length; i++) {
      const v = (this._buf[i] - 128) / 128; // center at 0, range -1..1
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / this._buf.length);
    // Normalize (speech RMS is small) and clamp, then ease for a fluid mouth.
    const target = Math.min(1, rms * 3.2);
    this._level += (target - this._level) * 0.4;
    return this._level;
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
    src.connect(this._analyser);
    const t = Math.max(this._ctx.currentTime + 0.038, this._nextTime);
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
