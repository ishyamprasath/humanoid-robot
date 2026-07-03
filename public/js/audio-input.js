// ============================================================
// MicCapture — mic → 16 kHz PCM16 base64 chunks
// ============================================================

const WORKLET_SOURCE = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('pcm-capture', PCMCaptureProcessor);
`;

export class MicCapture {
  constructor({ sampleRate = 16000, chunkSamples = 2048, onChunk = () => {}, onLevel = () => {} }) {
    this.sampleRate = sampleRate;
    this.chunkSamples = chunkSamples;
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.muted = false;
    this._buf = new Float32Array(chunkSamples);
    this._filled = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext({ sampleRate: this.sampleRate });
    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    await this.ctx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this._accumulate(e.data);
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  setMuted(m) { this.muted = m; }

  _accumulate(f32) {
    if (this.muted) { this.onLevel(0); return; }
    let offset = 0;
    while (offset < f32.length) {
      const space = this.chunkSamples - this._filled;
      const take = Math.min(space, f32.length - offset);
      this._buf.set(f32.subarray(offset, offset + take), this._filled);
      this._filled += take;
      offset += take;
      if (this._filled === this.chunkSamples) this._flush();
    }
  }

  _flush() {
    const f32 = this._buf;
    const int16 = new Int16Array(f32.length);
    let sum = 0;
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sum += s * s;
    }
    this.onLevel(Math.sqrt(sum / f32.length));
    this.onChunk(int16ToBase64(int16));
    this._filled = 0;
  }

  stop() {
    try { this.source?.disconnect(); this.node?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
  }
}

export function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
