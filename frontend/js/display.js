// ============================================================
// Robot display client — THIN by design.
//
// No AI, no audio capture, no secrets. It opens one WebSocket
// to the Python cognitive core and renders whatever state the
// backend broadcasts. All intelligence lives in backend/.
// ============================================================

(() => {
  "use strict";

  const WS_PORT = 8765;
  const ROOM_HALF = 2.0;                 // meters (matches backend config)
  const CAMERA_HFOV = Math.PI / 3;       // 60°

  const $ = (id) => document.getElementById(id);
  const els = {
    powerBtn: $("powerBtn"), muteBtn: $("muteBtn"), cameraBtn: $("cameraBtn"),
    statusPill: $("statusPill"), statusText: $("statusText"),
    linkPill: $("linkPill"), linkText: $("linkText"),
    cameraFrame: $("cameraFrame"), cameraOverlay: $("cameraOverlay"), cameraIdle: $("cameraIdle"),
    micMeterFill: $("micMeterFill"), speakingDot: $("speakingDot"),
    transcript: $("transcript"), textInput: $("textInput"), textSend: $("textSend"),
  };

  // ----------------------------------------------------------
  // Local render state (pose is eased toward backend targets)
  // ----------------------------------------------------------
  const state = {
    powerOn: false,
    muted: false,
    cameraOn: true,
    target: { x: 0, y: 0, heading: Math.PI / 2 },
    shown:  { x: 0, y: 0, heading: Math.PI / 2 },
    gripper: "open",
    lookTarget: null,           // {cam:{x,y,z}, world:{x,y}} + shownUntil
    tasks: [],
    trail: [{ x: 0, y: 0 }],
    frameSeen: false,
    visionBoxes: [],
    visionBoxesUntil: 0,
  };

  let ws = null;
  let userLine = null, botLine = null;

  // ----------------------------------------------------------
  // WebSocket link to the Python core (auto-reconnect)
  // ----------------------------------------------------------
  function connect() {
    ws = new WebSocket(`ws://${location.hostname}:${WS_PORT}`);
    ws.onopen = () => setLink(true);
    ws.onclose = () => { setLink(false); setTimeout(connect, 1500); };
    ws.onerror = () => {};
    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handle(msg);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function setLink(up) {
    els.linkPill.dataset.state = up ? "online" : "error";
    els.linkText.textContent = up ? "Backend ✓" : "Backend…";
  }

  // ----------------------------------------------------------
  // Message handlers
  // ----------------------------------------------------------
  function handle(msg) {
    switch (msg.type) {
      case "status": {
        els.statusPill.dataset.state = msg.state;
        els.statusText.textContent =
          msg.state === "online" ? "Online" :
          msg.state === "connecting" ? "Connecting…" :
          msg.state === "error" ? (msg.detail || "Error") : "Offline";
        state.powerOn = msg.state === "online" || msg.state === "connecting";
        els.powerBtn.textContent = state.powerOn ? "Power Off" : "Power On";
        els.powerBtn.classList.toggle("danger", state.powerOn);
        break;
      }
      case "transcript": {
        if (msg.role === "user") {
          if (!userLine) userLine = newLine("You", "user");
          userLine.textContent += msg.text;
        } else {
          if (!botLine) botLine = newLine("Robot", "bot");
          botLine.textContent += msg.text;
        }
        els.transcript.scrollTop = els.transcript.scrollHeight;
        break;
      }
      case "turn_complete":
        userLine = null; botLine = null;
        break;
      case "speaking":
        els.speakingDot.classList.toggle("active", !!msg.active);
        break;
      case "mic_level":
        els.micMeterFill.style.width = `${Math.min(100, msg.rms * 300)}%`;
        break;
      case "robot": {
        const p = msg.pose || {};
        // backend heading: degrees, 0=east, CCW positive
        state.target.x = p.x ?? 0;
        state.target.y = p.y ?? 0;
        state.target.heading = ((p.heading_deg ?? 90) * Math.PI) / 180;
        state.gripper = msg.gripper || "open";
        state.tasks = msg.tasks || [];
        state.lookTarget = msg.look_target
          ? { ...msg.look_target, shownUntil: performance.now() + 6000 }
          : state.lookTarget;
        break;
      }
      case "action":
        // logAction(actionLabel(msg)); // Action log removed
        break;
      case "frame": {
        els.cameraFrame.src = `data:image/jpeg;base64,${msg.jpeg_b64}`;
        if (!state.frameSeen) { state.frameSeen = true; els.cameraIdle.style.display = "none"; }
        break;
      }
      case "log":
        // logAction(msg.text); // Action log removed
        break;
      case "interrupted":
        // logAction("interrupted — user barge-in"); // Action log removed
        break;
      case "camera_state":
        state.cameraOn = msg.enabled;
        els.cameraBtn.textContent = state.cameraOn ? "Camera Off" : "Camera On";
        els.cameraBtn.classList.toggle("active", state.cameraOn);
        if (!state.cameraOn) {
          els.cameraIdle.style.display = "flex";
          els.cameraFrame.src = "";
          state.frameSeen = false;
          clearBoxes();
        }
        break;
      case "vision_bboxes":
        drawBoxes(msg.bboxes || []);
        break;
    }
  }

  function actionLabel(msg) {
    const ok = msg.result && msg.result.status === "success";
    const args = JSON.stringify(msg.args || {});
    return `${ok ? "⚡" : "✋"} ${msg.name} ${ok ? args : "REJECTED: " + (msg.result?.reason || "")}`;
  }

  // ----------------------------------------------------------
  // Controls
  // ----------------------------------------------------------
  els.powerBtn.addEventListener("click", () => send({ type: "power", on: !state.powerOn }));
  els.cameraBtn.addEventListener("click", () => {
    send({ type: "camera_toggle", enabled: !state.cameraOn });
  });
  els.muteBtn.addEventListener("click", () => {
    state.muted = !state.muted;
    send({ type: "mute", muted: state.muted });
    els.muteBtn.textContent = state.muted ? "Unmute" : "Mute";
    els.muteBtn.classList.toggle("active", state.muted);
  });
  function sendText() {
    const text = els.textInput.value.trim();
    if (!text) return;
    els.textInput.value = "";
    send({ type: "text", text });
  }
  els.textSend.addEventListener("click", sendText);
  els.textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendText(); });

  // ----------------------------------------------------------
  // Transcript / logs
  // ----------------------------------------------------------
  function newLine(who, cls) {
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    const b = document.createElement("b");
    b.textContent = `${who}: `;
    div.appendChild(b);
    const span = document.createElement("span");
    div.appendChild(span);
    els.transcript.appendChild(div);
    return span;
  }

  function logAction(text) {
    // Action log removed from UI
  }

  // ----------------------------------------------------------
  // Task queue
  // ----------------------------------------------------------
  function renderTasks() {
    // Task list removed from UI
  }

  // ----------------------------------------------------------
  // HUD
  // ----------------------------------------------------------
  function renderHud() {
    // HUD removed from UI
  }

  // ----------------------------------------------------------
  // World map + camera overlay render loop
  // ----------------------------------------------------------
  // Canvas removed from UI
  // const ctx = els.simCanvas.getContext("2d");
  const octx = els.cameraOverlay.getContext("2d");

  function worldToCanvas(wx, wy) {
    return { cx: 0, cy: 0 };
  }

  function tick() {
    const s = state.shown, t = state.target;
    s.x += (t.x - s.x) * 0.09;
    s.y += (t.y - s.y) * 0.09;
    let dh = t.heading - s.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    s.heading += dh * 0.12;

    const last = state.trail[state.trail.length - 1];
    if (Math.hypot(t.x - last.x, t.y - last.y) > 0.05 && Math.hypot(s.x - last.x, s.y - last.y) > 0.02) {
      state.trail.push({ x: s.x, y: s.y });
      if (state.trail.length > 200) state.trail.shift();
    }
    if (state.lookTarget && performance.now() > state.lookTarget.shownUntil) state.lookTarget = null;

    // drawWorld(); // Map removed from UI
    drawOverlay();
    // renderHud(); // HUD removed from UI
    requestAnimationFrame(tick);
  }

  function drawWorld() {
    // Map removed from UI
  }

  function drawOverlay() {
    const W = els.cameraOverlay.width, H = els.cameraOverlay.height;
    octx.clearRect(0, 0, W, H);
    drawVisionBoxes(W, H);
    const lt = state.lookTarget;
    if (!lt) return;
    const px = lt.cam.x * W, py = lt.cam.y * H;
    const pulse = 10 + 4 * Math.sin(performance.now() / 180);
    octx.strokeStyle = "rgba(234,179,8,0.95)";
    octx.lineWidth = 2.5;
    octx.beginPath(); octx.arc(px, py, pulse + 8, 0, Math.PI * 2); octx.stroke();
    octx.beginPath(); octx.moveTo(px - 20, py); octx.lineTo(px + 20, py); octx.stroke();
    octx.beginPath(); octx.moveTo(px, py - 20); octx.lineTo(px, py + 20); octx.stroke();
    octx.fillStyle = "rgba(15,23,42,0.9)";
    octx.fillRect(px + 22, py - 22, 130, 34);
    octx.fillStyle = "#fff";
    octx.font = "600 11px ui-monospace, Consolas, monospace";
    octx.fillText(`cam (${lt.cam.x.toFixed(2)}, ${lt.cam.y.toFixed(2)})`, px + 28, py - 8);
    octx.fillText(`z ${lt.cam.z.toFixed(2)} m`, px + 28, py + 6);
  }

  function drawBoxes(boxes) {
    if (!Array.isArray(boxes) || boxes.length === 0) {
      clearBoxes();
      return;
    }
    state.visionBoxes = boxes;
    state.visionBoxesUntil = performance.now() + 900;
  }

  function clearBoxes() {
    state.visionBoxes = [];
    state.visionBoxesUntil = 0;
  }

  function drawVisionBoxes(W, H) {
    if (!state.visionBoxes.length) return;
    if (performance.now() > state.visionBoxesUntil) {
      clearBoxes();
      return;
    }

    octx.save();
    octx.lineWidth = 3;
    octx.strokeStyle = "rgba(34,197,94,0.95)";
    octx.fillStyle = "rgba(15,23,42,0.88)";
    octx.font = "600 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";

    for (const item of state.visionBoxes) {
      const [x1Raw, y1Raw, x2Raw, y2Raw] = item.box || [];
      if (![x1Raw, y1Raw, x2Raw, y2Raw].every(Number.isFinite)) continue;
      const x1 = Math.max(0, Math.min(W, x1Raw));
      const y1 = Math.max(0, Math.min(H, y1Raw));
      const x2 = Math.max(0, Math.min(W, x2Raw));
      const y2 = Math.max(0, Math.min(H, y2Raw));
      const label = item.name
        ? `${item.name}${Number.isFinite(item.confidence) ? ` ${Math.round(item.confidence * 100)}%` : ""}`
        : "Person";

      octx.strokeRect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
      const labelWidth = Math.min(W - 8, Math.max(64, octx.measureText(label).width + 16));
      const labelX = Math.max(4, Math.min(x1, W - labelWidth - 4));
      const labelY = y1 > 26 ? y1 - 24 : Math.min(H - 26, y1 + 4);
      octx.fillRect(labelX, labelY, labelWidth, 22);
      octx.fillStyle = "#fff";
      octx.fillText(label, labelX + 8, labelY + 15);
      octx.fillStyle = "rgba(15,23,42,0.88)";
    }
    octx.restore();
  }

  // ----------------------------------------------------------
  // helpers
  // ----------------------------------------------------------
  function signed(n) { const s = Number(n).toFixed(2); return n >= 0 ? `+${s}` : s; }
  function arrowFor(deg) { return ["→","↗","↑","↖","←","↙","↓","↘"][Math.round(deg / 45) % 8]; }
  function esc(v) { return String(v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

  // boot
  // logAction("display client ready — connecting to Python core…");
  connect();
  requestAnimationFrame(tick);
})();
