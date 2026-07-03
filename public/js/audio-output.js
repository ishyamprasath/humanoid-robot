// ============================================================
// SpeakerOutput — 24 kHz PCM playback with barge-in interrupt
// ============================================================

export class SpeakerOutput {
  constructor({ sampleRate = 24000 }) {
    this.sampleRate = sampleRate;
    this.ctx = null;
    this.nextStartTime = 0;
    this.activeSources = new Set();
    this.onSpeakingChange = () => {};
  }

  async init() {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: this.sampleRate });
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  enqueue(base64Pcm) {
    if (!this.ctx) return;
    const f32 = base64ToFloat32(base64Pcm);
    if (!f32.length) return;
    const buffer = this.ctx.createBuffer(1, f32.length, this.sampleRate);
    buffer.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (this.nextStartTime < now) this.nextStartTime = now + 0.03;
    src.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;
    this.activeSources.add(src);
    this.onSpeakingChange(true);
    src.onended = () => {
      this.activeSources.delete(src);
      if (this.activeSources.size === 0) this.onSpeakingChange(false);
    };
  }

  interrupt() {
    for (const src of this.activeSources) {
      try { src.onended = null; src.stop(); } catch {}
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
    this.onSpeakingChange(false);
  }
}

function base64ToFloat32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000;
  return f32;
}
