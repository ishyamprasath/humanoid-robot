// ============================================================
// Robot cognitive core — browser-native, zero backend.
//
// The browser IS the robot's head: getUserMedia camera = eyes
// (native ~30 fps on screen, throttled JPEG frames to the model),
// AudioWorklet mic = ears (16 kHz PCM straight to Gemini Live),
// WebAudio = voice (24 kHz, instant barge-in). Tool calls drive
// the Robot world model. One process, one network hop.
// ============================================================

import { GoogleGenAI, Modality } from "@google/genai";
import { MicCapture, SpeakerPlayer } from "./audio.js";
import {
  API_KEY, CAMERA_HFOV, MAX_RETRIES, MODEL, MODEL_FRAME_FPS,
  MODEL_FRAME_JPEG_QUALITY, MODEL_FRAME_WIDTH, RETRY_DELAY_MS,
  ROOM_HALF_METERS as ROOM_HALF, SEND_SAMPLE_RATE, SYSTEM_PROMPT, VOICE_NAME,
} from "./config.js";
import { Robot } from "./robot.js";
import { buildTools } from "./tools.js";

const $ = (id) => document.getElementById(id);
const els = {
  powerBtn: $("powerBtn"), muteBtn: $("muteBtn"),
  statusPill: $("statusPill"), statusText: $("statusText"),
  linkPill: $("linkPill"), linkText: $("linkText"),
  cameraFeed: $("cameraFeed"), cameraOverlay: $("cameraOverlay"), cameraIdle: $("cameraIdle"),
  micMeterFill: $("micMeterFill"), speakingDot: $("speakingDot"),
  simCanvas: $("simCanvas"),
  transcript: $("transcript"), textInput: $("textInput"), textSend: $("textSend"),
  taskList: $("taskList"), actionLog: $("actionLog"),
  coordWorld: $("coordWorld"), coordHeading: $("coordHeading"),
  coordCam: $("coordCam"), coordWorldTarget: $("coordWorldTarget"),
  statGripper: $("statGripper"), statCurrentTask: $("statCurrentTask"),
};

// ----------------------------------------------------------
// Local render state (pose eased toward robot-model targets)
// ----------------------------------------------------------
const state = {
  powerOn: false,
  muted: false,
  target: { x: 0, y: 0, heading: Math.PI / 2 },
  shown: { x: 0, y: 0, heading: Math.PI / 2 },
  gripper: "open",
  lookTarget: null,
  tasks: [],
  trail: [{ x: 0, y: 0 }],
};

let ai = null;
let session = null;        // live Gemini session (null when off)
let sessionGen = 0;        // guards stale callbacks after power-off
let mic = null;
let player = null;
let camStream = null;
let frameTimer = null;
let retries = 0;
let userLine = null, botLine = null;

// ----------------------------------------------------------
// base64 helpers
// ----------------------------------------------------------
function b64FromBytes(bytes) {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ----------------------------------------------------------
// Status / logs / transcript
// ----------------------------------------------------------
function setStatus(st, detail = "") {
  els.statusPill.dataset.state = st;
  els.statusText.textContent =
    st === "online" ? "Online" :
    st === "connecting" ? "Connecting…" :
    st === "error" ? (detail || "Error") : "Offline";
  state.powerOn = st === "online" || st === "connecting";
  els.powerBtn.textContent = state.powerOn ? "Power Off" : "Power On";
  els.powerBtn.classList.toggle("danger", state.powerOn);
}

function setMedia(up, label) {
  els.linkPill.dataset.state = up ? "online" : "error";
  els.linkText.textContent = label;
}

function logAction(text) {
  const div = document.createElement("div");
  div.className = "line";
  div.textContent = `${new Date().toLocaleTimeString([], { hour12: false })} · ${text}`;
  els.actionLog.appendChild(div);
  els.actionLog.scrollTop = els.actionLog.scrollHeight;
  while (els.actionLog.children.length > 300) els.actionLog.removeChild(els.actionLog.firstChild);
}

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

function transcriptDelta(role, text) {
  if (role === "user") {
    if (!userLine) userLine = newLine("You", "user");
    userLine.textContent += text;
  } else {
    if (!botLine) botLine = newLine("Robot", "bot");
    botLine.textContent += text;
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

// ----------------------------------------------------------
// Robot world model
// ----------------------------------------------------------
const robot = new Robot({
  onAction: (name, args, result) => {
    const ok = result.status === "success";
    logAction(`${ok ? "⚡" : "✋"} ${name} ${ok ? JSON.stringify(args) : "REJECTED: " + (result.reason || "")}`);
  },
  onState: (snap) => {
    const p = snap.pose;
    state.target.x = p.x;
    state.target.y = p.y;
    state.target.heading = (p.heading_deg * Math.PI) / 180;
    state.gripper = snap.gripper;
    state.tasks = snap.tasks;
    if (snap.look_target) {
      state.lookTarget = { ...snap.look_target, shownUntil: performance.now() + 6000 };
    }
    renderTasks();
    renderHud();
  },
});

// ----------------------------------------------------------
// Camera — native-fps preview + throttled model frames
// ----------------------------------------------------------
const frameCanvas = document.createElement("canvas");

async function startCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    els.cameraFeed.srcObject = camStream;
    els.cameraIdle.style.display = "none";
    return true;
  } catch (e) {
    els.cameraIdle.textContent = "camera unavailable";
    logAction(`camera off — ${e.name || e}`);
    return false;
  }
}

function stopCamera() {
  try { camStream?.getTracks().forEach((t) => t.stop()); } catch {}
  camStream = null;
  els.cameraFeed.srcObject = null;
  els.cameraIdle.style.display = "";
  els.cameraIdle.textContent = "camera offline";
}

function startFrameUpload(gen) {
  const video = els.cameraFeed;
  const interval = 1000 / MODEL_FRAME_FPS;
  frameTimer = setInterval(() => {
    if (gen !== sessionGen || !session || !video.videoWidth) return;
    const scale = MODEL_FRAME_WIDTH / video.videoWidth;
    frameCanvas.width = MODEL_FRAME_WIDTH;
    frameCanvas.height = Math.round(video.videoHeight * scale);
    const ctx2d = frameCanvas.getContext("2d");
    ctx2d.drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    frameCanvas.toBlob(
      async (blob) => {
        if (!blob || gen !== sessionGen || !session) return;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        try {
          session.sendRealtimeInput({
            video: { data: b64FromBytes(bytes), mimeType: "image/jpeg" },
          });
        } catch {}
      },
      "image/jpeg",
      MODEL_FRAME_JPEG_QUALITY,
    );
  }, interval);
}

// ----------------------------------------------------------
// Gemini Live session
// ----------------------------------------------------------
async function powerOn() {
  if (session || state.powerOn) return;
  if (!API_KEY) {
    setStatus("error", "VITE_GEMINI_API_KEY missing — copy .env.example to .env");
    logAction("VITE_GEMINI_API_KEY missing in frontend/.env");
    return;
  }
  retries = 0;
  await connect();
}

async function connect() {
  const gen = ++sessionGen;
  setStatus("connecting", "waking up…");

  // media first — mic & camera in parallel
  player = new SpeakerPlayer({
    onSpeaking: (active) => els.speakingDot.classList.toggle("active", active),
  });
  await player.resume();

  mic = new MicCapture({
    onChunk: (bytes) => {
      if (gen !== sessionGen || !session) return;
      try {
        session.sendRealtimeInput({
          audio: { data: b64FromBytes(bytes), mimeType: `audio/pcm;rate=${SEND_SAMPLE_RATE}` },
        });
      } catch {}
    },
    onLevel: (rms) => {
      els.micMeterFill.style.width = `${Math.min(100, rms * 300)}%`;
    },
  });

  let micOk = true;
  try {
    await mic.start();
    mic.setMuted(state.muted);
  } catch (e) {
    micOk = false;
    logAction(`mic unavailable — ${e.name || e} (text chat still works)`);
  }
  const camOk = await startCamera();
  setMedia(micOk && camOk, micOk && camOk ? "Media ✓" : micOk ? "No camera" : camOk ? "No mic" : "No media");
  if (micOk) logAction(`microphone hot · ${mic.label()} · echo-cancelled (barge-in enabled)`);

  ai = new GoogleGenAI({ apiKey: API_KEY, httpOptions: { apiVersion: "v1beta" } });
  logAction(`connecting -> ${MODEL} · voice ${VOICE_NAME}`);

  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } },
        },
        systemInstruction: SYSTEM_PROMPT,
        tools: buildTools(),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          if (gen !== sessionGen) return;
          retries = 0;
          setStatus("online", "");
          logAction("online — listening & watching");
        },
        onmessage: (msg) => {
          if (gen !== sessionGen) return;
          handleServerMessage(msg);
        },
        onerror: (e) => {
          if (gen !== sessionGen) return;
          logAction(`link error: ${e?.message || e}`);
        },
        onclose: (e) => {
          if (gen !== sessionGen) return;
          session = null;
          maybeReconnect(e?.reason || "link closed");
        },
      },
    });
  } catch (e) {
    session = null;
    teardownMedia();
    setStatus("error", `connect failed: ${e?.message || e}`);
    logAction(`connect failed: ${e?.message || e}`);
    return;
  }

  if (gen !== sessionGen) return; // powered off while connecting
  if (camOk) {
    startFrameUpload(gen);
    logAction(`camera stream: native fps on screen · ${MODEL_FRAME_FPS} fps to the model`);
  }

  session.sendClientContent({
    turns: [{
      role: "user",
      parts: [{ text: "(System boot complete. Greet whoever is nearby warmly and briefly in your own voice.)" }],
    }],
    turnComplete: true,
  });
}

function handleServerMessage(msg) {
  if (msg.data) player?.play(bytesFromB64(msg.data));

  const tc = msg.toolCall;
  if (tc?.functionCalls?.length) {
    const functionResponses = tc.functionCalls.map((fc) => ({
      id: fc.id,
      name: fc.name,
      response: { result: robot.execute(fc.name, fc.args || {}) },
    }));
    try { session?.sendToolResponse({ functionResponses }); } catch {}
  }

  const sc = msg.serverContent;
  if (sc) {
    if (sc.inputTranscription?.text) transcriptDelta("user", sc.inputTranscription.text);
    if (sc.outputTranscription?.text) transcriptDelta("robot", sc.outputTranscription.text);
    if (sc.interrupted) {
      player?.interrupt();
      logAction("interrupted — user barge-in");
    }
    if (sc.turnComplete) { userLine = null; botLine = null; }
  }
}

function maybeReconnect(reason) {
  if (!state.powerOn) return;
  retries += 1;
  if (retries > MAX_RETRIES) {
    teardownMedia();
    setStatus("error", `link lost: ${reason}`);
    logAction(`brain gave up after ${MAX_RETRIES} retries: ${reason}`);
    return;
  }
  setStatus("connecting", `reconnecting (${retries}/${MAX_RETRIES})…`);
  logAction(`brain link dropped (${reason}); reconnecting in ${RETRY_DELAY_MS / 1000}s`);
  teardownMedia();
  const gen = sessionGen;
  setTimeout(() => { if (gen === sessionGen && state.powerOn) connect(); }, RETRY_DELAY_MS);
}

function teardownMedia() {
  if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
  mic?.stop(); mic = null;
  player?.stop(); player = null;
  stopCamera();
  els.micMeterFill.style.width = "0%";
  els.speakingDot.classList.remove("active");
}

function powerOff() {
  sessionGen++; // invalidate all in-flight callbacks
  try { session?.close(); } catch {}
  session = null;
  teardownMedia();
  setStatus("offline", "");
  setMedia(false, "Media off");
  logAction("cognitive core shut down");
}

// ----------------------------------------------------------
// Controls
// ----------------------------------------------------------
els.powerBtn.addEventListener("click", () => (state.powerOn ? powerOff() : powerOn()));
els.muteBtn.addEventListener("click", () => {
  state.muted = !state.muted;
  mic?.setMuted(state.muted);
  els.muteBtn.textContent = state.muted ? "Unmute" : "Mute";
  els.muteBtn.classList.toggle("active", state.muted);
  logAction(`mic ${state.muted ? "muted" : "live"}`);
});

function sendText() {
  const text = els.textInput.value.trim();
  if (!text) return;
  els.textInput.value = "";
  transcriptDelta("user", text);
  userLine = null;
  if (session) {
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    });
  } else {
    transcriptDelta("robot", "(power me on first — the brain is offline)");
    botLine = null;
  }
}
els.textSend.addEventListener("click", sendText);
els.textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendText(); });

// ----------------------------------------------------------
// Task queue / HUD
// ----------------------------------------------------------
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const signed = (n) => { const s = Number(n).toFixed(2); return n >= 0 ? `+${s}` : s; };
const arrowFor = (deg) => ["→", "↗", "↑", "↖", "←", "↙", "↓", "↘"][Math.round(deg / 45) % 8];

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

function renderHud() {
  const s = state.shown;
  els.coordWorld.textContent = `${signed(s.x)} , ${signed(s.y)}  m`;
  const deg = Math.round(((s.heading * 180) / Math.PI + 360) % 360);
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
  const canvasHeading = -s.heading; // canvas y is flipped

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
// boot
// ----------------------------------------------------------
setStatus("offline", "");
setMedia(false, "Media off");
logAction(`display ready — ${MODEL} · voice ${VOICE_NAME} · press Power On`);
if (!API_KEY) logAction("⚠ VITE_GEMINI_API_KEY missing — copy .env.example to .env and restart `npm run dev`");
requestAnimationFrame(tick);
