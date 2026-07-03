// ============================================================
// CameraFeed — webcam preview + 1 fps JPEG frames upstream
// ============================================================

export class CameraFeed {
  constructor({ width = 640, height = 480, jpegQuality = 0.7 }) {
    this.width = width;
    this.height = height;
    this.jpegQuality = jpegQuality;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx2d = this.canvas.getContext("2d");
    this._timer = null;
    this.enabled = true;
  }

  async start(videoEl) {
    this.videoEl = videoEl;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: this.width, height: this.height, facingMode: "user" },
    });
    videoEl.srcObject = this.stream;
    await videoEl.play();
  }

  captureFrame() {
    if (!this.enabled || !this.videoEl || this.videoEl.readyState < 2) return null;
    this.ctx2d.drawImage(this.videoEl, 0, 0, this.width, this.height);
    const dataUrl = this.canvas.toDataURL("image/jpeg", this.jpegQuality);
    return dataUrl.split(",")[1] || null;
  }

  startStreaming(onFrame, fps = 1) {
    this.stopStreaming();
    this._timer = setInterval(() => {
      const frame = this.captureFrame();
      if (frame) onFrame(frame);
    }, Math.max(200, 1000 / fps));
  }

  stopStreaming() { if (this._timer) clearInterval(this._timer); this._timer = null; }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.stream) this.stream.getVideoTracks().forEach((t) => (t.enabled = enabled));
  }

  stop() {
    this.stopStreaming();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
