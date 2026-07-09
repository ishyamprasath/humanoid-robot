// AudioWorklet processor — runs on the realtime audio thread.
// Converts float32 mic samples to 512-sample PCM16 chunks (32 ms @ 16 kHz)
// and posts them (zero-copy transfer) to the main thread with an RMS level.

class Pcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(512);
    this._len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this._buf[this._len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._len === this._buf.length) {
        let sum = 0;
        for (let j = 0; j < this._buf.length; j++) {
          const v = this._buf[j] / 32768;
          sum += v * v;
        }
        const out = this._buf.slice(0);
        this.port.postMessage(
          { pcm: out.buffer, rms: Math.sqrt(sum / this._buf.length) },
          [out.buffer],
        );
        this._len = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-capture", Pcm16Capture);
