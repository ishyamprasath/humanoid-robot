// ============================================================
// RobotSimulator — 4 m × 4 m top-down world in TRUE WORLD-FRAME
// meters. Origin (0,0) at room center, +x = east, +y = north.
// Executes tool calls, animates the body, and returns realistic
// results back to the brain. Also drives the task queue and the
// look-at reticle overlay on the camera feed.
// ============================================================

const ROOM_HALF = 2.0;     // meters — room is 4×4 m, center at origin
const CAMERA_HFOV = Math.PI / 3; // 60° horizontal field of view

export class RobotSimulator {
  constructor({ canvas, overlayCanvas, coordEls, statusEls, taskListEl, onLog = () => {}, onTasksChanged = () => {} }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.overlay = overlayCanvas;
    this.overlayCtx = overlayCanvas ? overlayCanvas.getContext("2d") : null;
    this.coordEls = coordEls; // { world, heading, camTarget, worldTarget }
    this.statusEls = statusEls; // { gripper, currentTask }
    this.taskListEl = taskListEl;
    this.onLog = onLog;
    this.onTasksChanged = onTasksChanged;

    // Robot pose in WORLD FRAME
    this.state = {
      x: 0.0, y: 0.0,           // meters
      heading: Math.PI / 2,     // radians, PI/2 = facing north (+y)
      gripper: "open",
      lookTarget: null,         // {camX, camY, worldX, worldY, worldZ, until}
    };
    this.target = { x: 0, y: 0, heading: this.state.heading };
    this.trail = [{ x: 0, y: 0 }];

    // Task queue
    this.tasks = []; // {id, type, description, target?, priority, status, createdAt}
    this._nextTaskId = 1;

    this._raf = null;
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // ==========================================================
  // Tool dispatcher
  // ==========================================================
  execute(name, args = {}) {
    try {
      switch (name) {
        case "move_robot":         return this._moveRobot(args);
        case "turn_robot":         return this._turnRobot(args);
        case "navigate_to":        return this._navigateTo(args);
        case "execute_robot_action": return this._robotAction(args);
        case "execute_task":       return this._executeTask(args);
        default: return { status: "error", reason: `Unknown tool: ${name}` };
      }
    } catch (e) {
      return { status: "error", reason: String(e.message || e) };
    }
  }

  // ==========================================================
  // Motor primitives
  // ==========================================================
  _moveRobot({ direction, distance_cm }) {
    const dist = clamp(Number(distance_cm) || 0, 0, 300) / 100; // → meters
    const h = this.target.heading;
    let dx = 0, dy = 0;
    if (direction === "forward")  { dx = Math.cos(h);  dy = Math.sin(h);  }
    else if (direction === "backward") { dx = -Math.cos(h); dy = -Math.sin(h); }
    else if (direction === "left")  { dx = Math.cos(h - Math.PI/2); dy = Math.sin(h - Math.PI/2); }
    else if (direction === "right") { dx = Math.cos(h + Math.PI/2); dy = Math.sin(h + Math.PI/2); }
    else return { status: "error", reason: `Invalid direction "${direction}"` };

    this.target.x = clamp(this.target.x + dx * dist, -ROOM_HALF + 0.1, ROOM_HALF - 0.1);
    this.target.y = clamp(this.target.y + dy * dist, -ROOM_HALF + 0.1, ROOM_HALF - 0.1);
    this.onLog(`🦿 move_robot → ${direction} ${(dist*100).toFixed(0)} cm  →  world (${this.target.x.toFixed(2)}, ${this.target.y.toFixed(2)}) m`);
    return { status: "success", direction, distance_cm: dist * 100, world_position_m: { x: round2(this.target.x), y: round2(this.target.y) } };
  }

  _turnRobot({ angle_degrees }) {
    const angle = clamp(Number(angle_degrees) || 0, -180, 180);
    this.target.heading = normRad(this.target.heading + (angle * Math.PI / 180));
    const hdgDeg = Math.round(normDeg(this.target.heading * 180 / Math.PI));
    this.onLog(`🔄 turn_robot → ${angle > 0 ? "right" : "left"} ${Math.abs(angle)}°  →  heading ${hdgDeg}°`);
    return { status: "success", turned_degrees: angle, heading_degrees: hdgDeg };
  }

  _navigateTo({ world_x, world_y, speed }) {
    const wx = clamp(Number(world_x) || 0, -ROOM_HALF + 0.1, ROOM_HALF - 0.1);
    const wy = clamp(Number(world_y) || 0, -ROOM_HALF + 0.1, ROOM_HALF - 0.1);
    const s = clamp(Number(speed) || 0.6, 0.1, 1.0);
    // Turn toward target, then set position
    const dx = wx - this.target.x, dy = wy - this.target.y;
    if (Math.hypot(dx, dy) > 0.01) this.target.heading = Math.atan2(dy, dx);
    this.target.x = wx;
    this.target.y = wy;
    const dist = Math.hypot(dx, dy);
    this.onLog(`🧭 navigate_to → world (${wx.toFixed(2)}, ${wy.toFixed(2)}) m · ${dist.toFixed(2)} m · speed ${s}`);
    return { status: "success", destination_m: { x: round2(wx), y: round2(wy) }, distance_m: round2(dist), speed: s };
  }

  _robotAction({ action_type, target_coordinates = {}, parameters = {} }) {
    const camX = clamp(Number(target_coordinates.x) || 0.5, 0, 1);
    const camY = clamp(Number(target_coordinates.y) || 0.5, 0, 1);
    const camZ = clamp(Number(target_coordinates.z) || 0, 0, 2);
    // Project camera-frame target to world frame for display
    const world = this._cameraToWorld(camX, camY, camZ);

    switch (action_type) {
      case "look_at": {
        this.state.lookTarget = { camX, camY, worldX: world.x, worldY: world.y, worldZ: camZ, until: performance.now() + 6000 };
        // Pan heading toward target's horizontal offset
        this.target.heading = normRad(this.target.heading + (camX - 0.5) * CAMERA_HFOV);
        this.onLog(`👀 look_at → cam (${camX.toFixed(2)}, ${camY.toFixed(2)}, ${camZ.toFixed(2)} m)  →  world (${world.x.toFixed(2)}, ${world.y.toFixed(2)}) m`);
        return {
          status: "success",
          camera_frame: { x: camX, y: camY, z: camZ },
          world_frame_m: { x: round2(world.x), y: round2(world.y) },
        };
      }
      case "grasp": {
        if (camZ > 1.5) {
          this.onLog(`✋ grasp REFUSED — z ${camZ.toFixed(2)} m exceeds 1.5 m reach`);
          return { status: "error", reason: `Target at ${camZ.toFixed(2)} m is beyond the 1.5 m arm reach. Navigate closer first.` };
        }
        const force = clamp(Number(parameters.grip_force) || 0.5, 0, 1);
        this.state.gripper = "closed";
        this.state.lookTarget = { camX, camY, worldX: world.x, worldY: world.y, worldZ: camZ, until: performance.now() + 4000 };
        this.onLog(`🤏 grasp → cam (${camX.toFixed(2)}, ${camY.toFixed(2)}, ${camZ.toFixed(2)} m) · force ${force}`);
        return { status: "success", gripper: "closed", grip_force: force, object_secured: true, world_target_m: { x: round2(world.x), y: round2(world.y) } };
      }
      case "release": {
        this.state.gripper = "open";
        this.onLog(`🖐️ release`);
        return { status: "success", gripper: "open" };
      }
      case "idle": {
        this.onLog(`😌 idle`);
        return { status: "success", action: "idle" };
      }
      default:
        return { status: "error", reason: `Unknown action_type "${action_type}"` };
    }
  }

  _executeTask({ task_type, description, target_coordinates, priority }) {
    const validTypes = ["fetch","deliver","inspect","follow","greet","patrol","return_home","wait"];
    if (!validTypes.includes(task_type)) {
      return { status: "error", reason: `Unknown task_type "${task_type}"` };
    }
    const target = target_coordinates && (target_coordinates.world_x !== undefined || target_coordinates.world_y !== undefined)
      ? { x: Number(target_coordinates.world_x) || 0, y: Number(target_coordinates.world_y) || 0 }
      : null;

    // Any task marks all previous ones as superseded / done for the active slot
    for (const t of this.tasks) if (t.status === "active") t.status = "completed";

    const task = {
      id: this._nextTaskId++,
      type: task_type,
      description: description || `${task_type} task`,
      target,
      priority: priority || "normal",
      status: "active",
      createdAt: Date.now(),
    };
    this.tasks.unshift(task);
    if (this.tasks.length > 20) this.tasks.pop();
    this._renderTasks();
    this.onTasksChanged(this.tasks);
    this.onLog(`📋 execute_task → ${task_type.toUpperCase()} · "${task.description}"${target ? ` · world (${target.x.toFixed(2)}, ${target.y.toFixed(2)}) m` : ""} · priority ${task.priority}`);
    return {
      status: "success",
      task_id: task.id,
      task_type,
      description: task.description,
      target_world_m: target ? { x: round2(target.x), y: round2(target.y) } : null,
      priority: task.priority,
      accepted_at: new Date(task.createdAt).toISOString(),
    };
  }

  // Convert camera-frame (0..1, 0..1, meters) into a world-frame estimate
  _cameraToWorld(camX, camY, camZ) {
    const yaw = this.target.heading - (camX - 0.5) * CAMERA_HFOV;
    return {
      x: this.target.x + Math.cos(yaw) * camZ,
      y: this.target.y + Math.sin(yaw) * camZ,
    };
  }

  // ==========================================================
  // Render loop
  // ==========================================================
  _loop() {
    const s = this.state;
    s.x += (this.target.x - s.x) * 0.09;
    s.y += (this.target.y - s.y) * 0.09;
    let dh = normRad(this.target.heading - s.heading);
    s.heading = normRad(s.heading + dh * 0.12);

    const last = this.trail[this.trail.length - 1];
    if (Math.hypot(this.target.x - last.x, this.target.y - last.y) > 0.05 && Math.hypot(s.x - last.x, s.y - last.y) > 0.02) {
      this.trail.push({ x: s.x, y: s.y });
      if (this.trail.length > 200) this.trail.shift();
    }
    if (s.lookTarget && performance.now() > s.lookTarget.until) s.lookTarget = null;

    this._draw();
    this._drawOverlay();
    this._updateHud();
    this._raf = requestAnimationFrame(this._loop);
  }

  _worldToCanvas(wx, wy) {
    const W = this.canvas.width, H = this.canvas.height;
    // +y world = up on canvas
    return {
      cx: ((wx + ROOM_HALF) / (2 * ROOM_HALF)) * W,
      cy: H - ((wy + ROOM_HALF) / (2 * ROOM_HALF)) * H,
    };
  }

  _draw() {
    const c = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    c.clearRect(0, 0, W, H);

    // Background
    c.fillStyle = "#fafaf7";
    c.fillRect(0, 0, W, H);

    // 1m grid + axis labels
    c.strokeStyle = "rgba(24, 24, 27, 0.06)";
    c.lineWidth = 1;
    const step = W / (2 * ROOM_HALF); // pixels per meter
    for (let i = -ROOM_HALF; i <= ROOM_HALF; i += 0.5) {
      const {cx} = this._worldToCanvas(i, 0);
      const {cy} = this._worldToCanvas(0, i);
      c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, H); c.stroke();
      c.beginPath(); c.moveTo(0, cy); c.lineTo(W, cy); c.stroke();
    }

    // Center cross
    const origin = this._worldToCanvas(0, 0);
    c.strokeStyle = "rgba(24, 24, 27, 0.18)";
    c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(origin.cx - 8, origin.cy); c.lineTo(origin.cx + 8, origin.cy); c.stroke();
    c.beginPath(); c.moveTo(origin.cx, origin.cy - 8); c.lineTo(origin.cx, origin.cy + 8); c.stroke();

    // Meter labels
    c.fillStyle = "rgba(24, 24, 27, 0.35)";
    c.font = "10px ui-monospace, 'SF Mono', Consolas, monospace";
    for (let m = -1; m <= 1; m++) {
      if (m === 0) continue;
      const {cx} = this._worldToCanvas(m, 0);
      const {cy} = this._worldToCanvas(0, m);
      c.fillText(`${m > 0 ? '+' : ''}${m}`, cx + 3, origin.cy - 3);
      c.fillText(`${m > 0 ? '+' : ''}${m}`, origin.cx + 3, cy - 3);
    }

    // Room border
    c.strokeStyle = "rgba(24, 24, 27, 0.5)";
    c.lineWidth = 2;
    c.strokeRect(1, 1, W - 2, H - 2);

    // Trail
    if (this.trail.length > 1) {
      c.strokeStyle = "rgba(99, 102, 241, 0.35)";
      c.lineWidth = 2;
      c.setLineDash([4, 4]);
      c.beginPath();
      const p0 = this._worldToCanvas(this.trail[0].x, this.trail[0].y);
      c.moveTo(p0.cx, p0.cy);
      for (const p of this.trail) {
        const q = this._worldToCanvas(p.x, p.y);
        c.lineTo(q.cx, q.cy);
      }
      c.stroke();
      c.setLineDash([]);
    }

    // Active task target ring (world-frame)
    const activeTask = this.tasks.find((t) => t.status === "active" && t.target);
    if (activeTask) {
      const t = this._worldToCanvas(activeTask.target.x, activeTask.target.y);
      c.strokeStyle = "rgba(168, 85, 247, 0.85)";
      c.lineWidth = 2;
      c.setLineDash([6, 4]);
      c.beginPath(); c.arc(t.cx, t.cy, 18, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
      c.fillStyle = "rgba(168, 85, 247, 0.85)";
      c.font = "600 11px system-ui, -apple-system, sans-serif";
      c.fillText(`🎯 ${activeTask.type}`, t.cx + 22, t.cy + 4);
    }

    // Look target marker (from camera-frame projection)
    const s = this.state;
    if (s.lookTarget) {
      const l = this._worldToCanvas(s.lookTarget.worldX, s.lookTarget.worldY);
      c.strokeStyle = "rgba(234, 179, 8, 0.9)";
      c.lineWidth = 2;
      c.beginPath(); c.arc(l.cx, l.cy, 10, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(l.cx - 12, l.cy); c.lineTo(l.cx + 12, l.cy); c.stroke();
      c.beginPath(); c.moveTo(l.cx, l.cy - 12); c.lineTo(l.cx, l.cy + 12); c.stroke();
    }

    // Robot body
    const p = this._worldToCanvas(s.x, s.y);
    // Vision cone
    c.fillStyle = "rgba(99, 102, 241, 0.14)";
    c.beginPath();
    c.moveTo(p.cx, p.cy);
    const coneR = 60;
    // Canvas y is flipped vs. world y, so heading needs -angle for canvas
    const canvasHeading = -s.heading;
    c.arc(p.cx, p.cy, coneR, canvasHeading - CAMERA_HFOV / 2, canvasHeading + CAMERA_HFOV / 2);
    c.closePath();
    c.fill();

    // Body dot
    c.fillStyle = "#18181b";
    c.beginPath(); c.arc(p.cx, p.cy, 9, 0, Math.PI * 2); c.fill();
    c.strokeStyle = "#fff";
    c.lineWidth = 2;
    c.stroke();

    // Heading tick
    c.strokeStyle = "#6366f1";
    c.lineWidth = 3;
    c.beginPath(); c.moveTo(p.cx, p.cy);
    c.lineTo(p.cx + Math.cos(canvasHeading) * 18, p.cy + Math.sin(canvasHeading) * 18);
    c.stroke();

    // Gripper indicator dot at hand tip
    c.fillStyle = s.gripper === "closed" ? "#f59e0b" : "#10b981";
    c.beginPath();
    c.arc(p.cx + Math.cos(canvasHeading) * 18, p.cy + Math.sin(canvasHeading) * 18, 4, 0, Math.PI * 2);
    c.fill();
  }

  _drawOverlay() {
    if (!this.overlayCtx) return;
    const c = this.overlayCtx;
    const W = this.overlay.width, H = this.overlay.height;
    c.clearRect(0, 0, W, H);
    const t = this.state.lookTarget;
    if (!t) return;
    const px = t.camX * W, py = t.camY * H;
    const pulse = 10 + 4 * Math.sin(performance.now() / 180);
    c.strokeStyle = "rgba(234, 179, 8, 0.95)";
    c.lineWidth = 2.5;
    c.beginPath(); c.arc(px, py, pulse + 8, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(px - 20, py); c.lineTo(px + 20, py); c.stroke();
    c.beginPath(); c.moveTo(px, py - 20); c.lineTo(px, py + 20); c.stroke();
    // Coord tag
    c.fillStyle = "rgba(15, 23, 42, 0.9)";
    c.fillRect(px + 22, py - 22, 130, 34);
    c.fillStyle = "#fff";
    c.font = "600 11px ui-monospace, 'SF Mono', Consolas, monospace";
    c.fillText(`cam (${t.camX.toFixed(2)}, ${t.camY.toFixed(2)})`, px + 28, py - 8);
    c.fillText(`z ${t.worldZ.toFixed(2)} m`, px + 28, py + 6);
  }

  _updateHud() {
    const s = this.state;
    const hdgDeg = Math.round(normDeg(s.heading * 180 / Math.PI));
    if (this.coordEls?.world) this.coordEls.world.textContent =
      `${signed(s.x, 2)} , ${signed(s.y, 2)}  m`;
    if (this.coordEls?.heading) this.coordEls.heading.textContent =
      `${hdgDeg}° ${arrowFor(hdgDeg)}`;
    if (this.coordEls?.camTarget) this.coordEls.camTarget.textContent =
      s.lookTarget ? `(${s.lookTarget.camX.toFixed(2)}, ${s.lookTarget.camY.toFixed(2)}) · z ${s.lookTarget.worldZ.toFixed(2)} m` : "—";
    if (this.coordEls?.worldTarget) this.coordEls.worldTarget.textContent =
      s.lookTarget ? `${signed(s.lookTarget.worldX, 2)} , ${signed(s.lookTarget.worldY, 2)}  m` : "—";
    if (this.statusEls?.gripper) {
      this.statusEls.gripper.textContent = s.gripper.toUpperCase();
      this.statusEls.gripper.className = `metric-value ${s.gripper === "closed" ? "warn" : "ok"}`;
    }
    if (this.statusEls?.currentTask) {
      const active = this.tasks.find((t) => t.status === "active");
      this.statusEls.currentTask.textContent = active
        ? `${active.type} · ${active.description}`
        : "idle";
    }
  }

  _renderTasks() {
    if (!this.taskListEl) return;
    const el = this.taskListEl;
    el.innerHTML = "";
    if (!this.tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No tasks yet. Ask the robot to do something.";
      el.appendChild(empty);
      return;
    }
    for (const t of this.tasks) {
      const row = document.createElement("div");
      row.className = `task task-${t.status} priority-${t.priority}`;
      const target = t.target ? ` · ${signed(t.target.x, 2)}, ${signed(t.target.y, 2)} m` : "";
      row.innerHTML = `
        <div class="task-head">
          <span class="task-type">${escapeHtml(t.type)}</span>
          <span class="task-status">${t.status}</span>
        </div>
        <div class="task-desc">${escapeHtml(t.description)}</div>
        <div class="task-meta">priority ${t.priority}${target}</div>
      `;
      el.appendChild(row);
    }
  }

  markActiveTaskCompleted() {
    const active = this.tasks.find((t) => t.status === "active");
    if (active) {
      active.status = "completed";
      this._renderTasks();
      this.onTasksChanged(this.tasks);
    }
  }

  destroy() { cancelAnimationFrame(this._raf); }
}

// ---------- helpers ----------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(n) { return Math.round(n * 100) / 100; }
function signed(n, d) { const s = n.toFixed(d); return n >= 0 ? `+${s}` : s; }
function normRad(r) { while (r > Math.PI) r -= 2 * Math.PI; while (r < -Math.PI) r += 2 * Math.PI; return r; }
function normDeg(d) { d = d % 360; return d < 0 ? d + 360 : d; }
function arrowFor(deg) {
  const arrows = ["→","↗","↑","↖","←","↙","↓","↘"];
  return arrows[Math.round(deg / 45) % 8];
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
