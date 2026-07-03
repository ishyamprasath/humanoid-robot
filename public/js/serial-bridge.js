// ============================================================
// SerialBridge — Web Serial mirror to real robot firmware
// ============================================================

export class SerialBridge {
  constructor({ baudRate = 115200, onStatus = () => {}, onLog = () => {} }) {
    this.baudRate = baudRate;
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.port = null;
    this.writer = null;
  }
  get supported() { return "serial" in navigator; }
  get connected() { return !!this.writer; }

  async connect() {
    if (!this.supported) { this.onLog("⚠️ Web Serial not supported (Chrome/Edge only)."); return false; }
    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.baudRate });
      this.writer = this.port.writable.getWriter();
      this.onStatus(true);
      this.onLog(`🔌 Hardware connected @ ${this.baudRate} baud`);
      this._readLoop();
      return true;
    } catch (e) { this.onLog(`⚠️ Serial connect failed: ${e.message}`); this.onStatus(false); return false; }
  }

  async _readLoop() {
    try {
      const decoder = new TextDecoder();
      const reader = this.port.readable.getReader();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value);
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.onLog(`🤖 HW: ${line}`);
        }
      }
    } catch {}
  }

  async send(name, args) {
    if (!this.writer) return;
    try {
      const line = JSON.stringify({ cmd: name, args }) + "\n";
      await this.writer.write(new TextEncoder().encode(line));
    } catch (e) { this.onLog(`⚠️ Serial write failed: ${e.message}`); }
  }

  async disconnect() {
    try { this.writer?.releaseLock(); await this.port?.close(); } catch {}
    this.writer = null; this.port = null;
    this.onStatus(false); this.onLog("🔌 Hardware disconnected");
  }
}
