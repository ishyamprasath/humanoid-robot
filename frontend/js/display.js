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
    powerBtn: $("powerBtn"), muteBtn: $("muteBtn"),
    statusPill: $("statusPill"), statusText: $("statusText"),
    linkPill: $("linkPill"), linkText: $("linkText"),
    cameraFrame: $("cameraFrame"), cameraOverlay: $("cameraOverlay"), cameraIdle: $("cameraIdle"),
    micMeterFill: $("micMeterFill"), speakingDot: $("speakingDot"),
    simCanvas: $("simCanvas"),
    transcript: $("transcript"), textInput: $("textInput"), textSend: $("textSend"),
    taskList: $("taskList"), actionLog: $("actionLog"),
    coordWorld: $("coordWorld"), coordHeading: $("coordHeading"),
    coordCam: $("coordCam"), coordWorldTarget: $("coordWorldTarget"),
    statGripper: $("statGripper"), statCurrentTask: $("statCurrentTask"),
  };

  // ----------------------------------------------------------
  // Local render state (pose is eased toward backend targets)
  // ----------------------------------------------------------
  const state = {
    powerOn: false,
    muted: false,
    target: { x: 0, y: 0, heading: Math.PI / 2 },
    shown:  { x: 0, y: 0, heading: Math.PI / 2 },
    gripper: "open",
    lookTarget: null,           // {cam:{x,y,z}, world:{x,y}} + shownUntil
    tasks: [],
    trail: [{ x: 0, y: 0 }],
    frameSeen: false,
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
        renderTasks();
        renderHud();
        break;
      }
      case "action":
        logAction(actionLabel(msg));
        break;
      case "frame": {
        els.cameraFrame.src = `data:image/jpeg;base64,${msg.jpeg_b64}`;
        if (!state.frameSeen) { state.frameSeen = true; els.cameraIdle.style.display = "none"; }
        break;
      }
      case "log":
        logAction(msg.text);
        break;
      case "interrupted":
        logAction("interrupted — user barge-in");
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
    const div = document.createElement("div");
    div.className = "line";
    div.textContent = `${new Date().toLocaleTimeString([], { hour12: false })} · ${text}`;
    els.actionLog.appendChild(div);
    els.actionLog.scrollTop = els.actionLog.scrollHeight;
    while (els.actionLog.children.length > 300) els.actionLog.removeChild(els.actionLog.firstChild);
  }

  // ----------------------------------------------------------
  // Task queue
  // ----------------------------------------------------------
  function renderTasks() {
    const el = els.taskList;
    el.innerHTML = "";
    if (!state.tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No tasks yet. Ask the robot to do something.";
      el.appendChild(empty);
      return;
    }
    for (const t of state.tasks) {
      const row = document.createElement("div");
      row.className = `task task-${t.status} priority-${t.priority}`;
      const target = t.target ? ` · ${signed(t.target.x)}, ${signed(t.target.y)} m` : "";
      row.innerHTML = `
        <div class="task-head">
          <span class="task-type">${esc(t.type)}</span>
          <span class="task-status">${esc(t.status)}</span>
        </div>
        <div class="task-desc">${esc(t.description)}</div>
        <div class="task-meta">priority ${esc(t.priority)}${target}</div>`;
      el.appendChild(row);
    }
  }

  // ----------------------------------------------------------
  // HUD
  // ----------------------------------------------------------
  function renderHud() {
    const s = state.shown;
    els.coordWorld.textContent = `${signed(s.x)} , ${signed(s.y)}  m`;
    const deg = Math.round((s.heading * 180 / Math.PI + 360) % 360);
    els.coordHeading.textContent = `${deg}° ${arrowFor(deg)}`;
    const lt = state.lookTarget;
    els.coordCam.textContent = lt
      ? `(${lt.cam.x.toFixed(2)}, ${lt.cam.y.toFixed(2)}) · z ${lt.cam.z.toFixed(2)} m` : "—";
    els.coordWorldTarget.textContent = lt
      ? `${signed(lt.world.x)} , ${signed(lt.world.y)}  m` : "—";
    els.statGripper.textContent = state.gripper.toUpperCase();
    els.statGripper.className = `metric-value ${state.gripper === "closed" ? "warn" : "ok"}`;
    const active = state.tasks.find((t) => t.status === "active");
    els.statCurrentTask.textContent = active ? `${active.type} · ${active.description}` : "idle";
  }

  // ----------------------------------------------------------
  // World map + camera overlay render loop
  // ----------------------------------------------------------
  const ctx = els.simCanvas.getContext("2d");
  const octx = els.cameraOverlay.getContext("2d");

  function worldToCanvas(wx, wy) {
    const W = els.simCanvas.width, H = els.simCanvas.height;
    return {
      cx: ((wx + ROOM_HALF) / (2 * ROOM_HALF)) * W,
      cy: H - ((wy + ROOM_HALF) / (2 * ROOM_HALF)) * H,
    };
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

    drawWorld();
    drawOverlay();
    renderHud();
    requestAnimationFrame(tick);
  }

  function drawWorld() {
    const W = els.simCanvas.width, H = els.simCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafaf7";
    ctx.fillRect(0, 0, W, H);

    // 0.5 m grid
    ctx.strokeStyle = "rgba(24,24,27,0.06)";
    ctx.lineWidth = 1;
    for (let m = -ROOM_HALF; m <= ROOM_HALF; m += 0.5) {
      const { cx } = worldToCanvas(m, 0);
      const { cy } = worldToCanvas(0, m);
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
    }

    // origin cross + meter labels
    const o = worldToCanvas(0, 0);
    ctx.strokeStyle = "rgba(24,24,27,0.18)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(o.cx - 8, o.cy); ctx.lineTo(o.cx + 8, o.cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(o.cx, o.cy - 8); ctx.lineTo(o.cx, o.cy + 8); ctx.stroke();
    ctx.fillStyle = "rgba(24,24,27,0.35)";
    ctx.font = "10px ui-monospace, Consolas, monospace";
    for (let m = -1; m <= 1; m++) {
      if (!m) continue;
      const { cx } = worldToCanvas(m, 0);
      const { cy } = worldToCanvas(0, m);
      ctx.fillText(`${m > 0 ? "+" : ""}${m}`, cx + 3, o.cy - 3);
      ctx.fillText(`${m > 0 ? "+" : ""}${m}`, o.cx + 3, cy - 3);
    }

    ctx.strokeStyle = "rgba(24,24,27,0.5)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    // trail
    if (state.trail.length > 1) {
      ctx.strokeStyle = "rgba(99,102,241,0.35)";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      const p0 = worldToCanvas(state.trail[0].x, state.trail[0].y);
      ctx.moveTo(p0.cx, p0.cy);
      for (const p of state.trail) {
        const q = worldToCanvas(p.x, p.y);
        ctx.lineTo(q.cx, q.cy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // active task target
    const activeTask = state.tasks.find((t) => t.status === "active" && t.target);
    if (activeTask) {
      const t = worldToCanvas(activeTask.target.x, activeTask.target.y);
      ctx.strokeStyle = "rgba(168,85,247,0.85)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.arc(t.cx, t.cy, 18, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(168,85,247,0.85)";
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.fillText(`🎯 ${activeTask.type}`, t.cx + 22, t.cy + 4);
    }

    // look target
    if (state.lookTarget) {
      const l = worldToCanvas(state.lookTarget.world.x, state.lookTarget.world.y);
      ctx.strokeStyle = "rgba(234,179,8,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(l.cx, l.cy, 10, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(l.cx - 12, l.cy); ctx.lineTo(l.cx + 12, l.cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(l.cx, l.cy - 12); ctx.lineTo(l.cx, l.cy + 12); ctx.stroke();
    }

    // robot
    const s = state.shown;
    const p = worldToCanvas(s.x, s.y);
    const canvasHeading = -s.heading;  // canvas y is flipped

    ctx.fillStyle = "rgba(99,102,241,0.14)";
    ctx.beginPath();
    ctx.moveTo(p.cx, p.cy);
    ctx.arc(p.cx, p.cy, 60, canvasHeading - CAMERA_HFOV / 2, canvasHeading + CAMERA_HFOV / 2);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#18181b";
    ctx.beginPath(); ctx.arc(p.cx, p.cy, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();

    ctx.strokeStyle = "#6366f1"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(p.cx, p.cy);
    ctx.lineTo(p.cx + Math.cos(canvasHeading) * 18, p.cy + Math.sin(canvasHeading) * 18);
    ctx.stroke();

    ctx.fillStyle = state.gripper === "closed" ? "#f59e0b" : "#10b981";
    ctx.beginPath();
    ctx.arc(p.cx + Math.cos(canvasHeading) * 18, p.cy + Math.sin(canvasHeading) * 18, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawOverlay() {
    const W = els.cameraOverlay.width, H = els.cameraOverlay.height;
    octx.clearRect(0, 0, W, H);
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

  // ----------------------------------------------------------
  // helpers
  // ----------------------------------------------------------
  function signed(n) { const s = Number(n).toFixed(2); return n >= 0 ? `+${s}` : s; }
  function arrowFor(deg) { return ["→","↗","↑","↖","←","↙","↓","↘"][Math.round(deg / 45) % 8]; }
  function esc(v) { return String(v).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

  // boot
  logAction("display client ready — connecting to Python core…");
  connect();
  requestAnimationFrame(tick);
})();
