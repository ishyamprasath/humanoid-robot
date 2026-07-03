// ============================================================
// Robot — main orchestrator
// ============================================================

import { CONFIG, SYSTEM_PROMPT } from "./config.js";
import { TOOL_DECLARATIONS } from "./tools.js";
import { GeminiLiveClient } from "./gemini-live.js";
import { MicCapture } from "./audio-input.js";
import { SpeakerOutput } from "./audio-output.js";
import { CameraFeed } from "./video-input.js";
import { RobotSimulator } from "./robot-sim.js";
import { SerialBridge } from "./serial-bridge.js";
import { FallbackChat } from "./fallback-chat.js";

const $ = (id) => document.getElementById(id);

const els = {
  powerBtn: $("powerBtn"),
  muteBtn: $("muteBtn"),
  camBtn: $("camBtn"),
  hwBtn: $("hwBtn"),
  fallbackBtn: $("fallbackBtn"),
  statusPill: $("statusPill"),
  statusText: $("statusText"),
  video: $("cameraVideo"),
  overlay: $("cameraOverlay"),
  micMeterFill: $("micMeterFill"),
  speakingDot: $("speakingDot"),
  simCanvas: $("simCanvas"),
  transcript: $("transcript"),
  actionLog: $("actionLog"),
  taskList: $("taskList"),
  fallbackPanel: $("fallbackPanel"),
  fallbackLog: $("fallbackLog"),
  fallbackInput: $("fallbackInput"),
  fallbackSend: $("fallbackSend"),
  coordWorld: $("coordWorld"),
  coordHeading: $("coordHeading"),
  coordCam: $("coordCam"),
  coordWorldTarget: $("coordWorldTarget"),
  statGripper: $("statGripper"),
  statCurrentTask: $("statCurrentTask"),
};

const speaker = new SpeakerOutput({ sampleRate: CONFIG.RECV_SAMPLE_RATE });
speaker.onSpeakingChange = (speaking) => els.speakingDot.classList.toggle("active", speaking);

const sim = new RobotSimulator({
  canvas: els.simCanvas,
  overlayCanvas: els.overlay,
  coordEls: {
    world: els.coordWorld,
    heading: els.coordHeading,
    camTarget: els.coordCam,
    worldTarget: els.coordWorldTarget,
  },
  statusEls: {
    gripper: els.statGripper,
    currentTask: els.statCurrentTask,
  },
  taskListEl: els.taskList,
  onLog: (msg) => logAction(msg),
  onTasksChanged: () => {},
});

const serial = new SerialBridge({
  onStatus: (connected) => {
    els.hwBtn.classList.toggle("active", connected);
    els.hwBtn.textContent = connected ? "Hardware ✓" : "Hardware";
  },
  onLog: (msg) => logAction(msg),
});

const fallback = new FallbackChat({
  onReply: (text) => appendFallback("Robot", text, "bot"),
  onError: (err) => appendFallback("System", `⚠ ${err}`, "sys"),
});

let mic = null, camera = null, gemini = null;
let running = false, muted = false, cameraOn = true;
let userLine = null, botLine = null;

// ---------------- Power ----------------
els.powerBtn.addEventListener("click", () => (running ? powerOff() : powerOn()));

async function powerOn() {
  setStatus("connecting", "Connecting…");
  els.powerBtn.disabled = true;
  try {
    await speaker.init();

    mic = new MicCapture({
      sampleRate: CONFIG.SEND_SAMPLE_RATE,
      chunkSamples: CONFIG.MIC_CHUNK_SAMPLES,
      onChunk: (b64) => gemini?.ready && gemini.sendAudioChunk(b64),
      onLevel: (rms) => { els.micMeterFill.style.width = `${Math.min(100, rms * 300)}%`; },
    });
    await mic.start();

    camera = new CameraFeed({
      width: CONFIG.VIDEO_WIDTH, height: CONFIG.VIDEO_HEIGHT, jpegQuality: CONFIG.JPEG_QUALITY,
    });
    await camera.start(els.video);
    syncOverlaySize();

    gemini = new GeminiLiveClient({ config: CONFIG, tools: TOOL_DECLARATIONS, systemPrompt: SYSTEM_PROMPT });
    wireBrain(gemini);
    await gemini.connect();

    camera.startStreaming((frame) => gemini?.ready && gemini.sendVideoFrame(frame), CONFIG.VIDEO_FPS);

    running = true;
    els.powerBtn.textContent = "Power Off";
    els.powerBtn.classList.add("danger");
    setStatus("online", "Online");
    logAction("● Cognitive core online — Gemini 3.1 Flash Live · voice Kore");
    gemini.sendText("(System boot complete. Greet whoever you can see, briefly and warmly.)");
  } catch (e) {
    console.error(e);
    setStatus("error", `Brain offline: ${e.message}`);
    logAction(`○ ${e.message}`);
    logAction("💡 NVIDIA Nemotron fallback chat is available (Fallback button).");
    showFallback(true);
    cleanupSenses();
  } finally {
    els.powerBtn.disabled = false;
  }
}

function powerOff() {
  running = false;
  gemini?.disconnect();
  gemini = null;
  cleanupSenses();
  speaker.interrupt();
  els.powerBtn.textContent = "Power On";
  els.powerBtn.classList.remove("danger");
  setStatus("offline", "Offline");
  logAction("○ Cognitive core shut down");
}

function cleanupSenses() {
  mic?.stop(); mic = null;
  camera?.stop(); camera = null;
  els.micMeterFill.style.width = "0%";
}

// ---------------- Brain wiring ----------------
function wireBrain(g) {
  g.onAudio = (b64) => speaker.enqueue(b64);
  g.onInterrupted = () => { speaker.interrupt(); logAction("✂ Interrupted — user barge-in"); };
  g.onInputTranscript = (t) => {
    if (!userLine) userLine = newLine(els.transcript, "You", "user");
    userLine.textContent += t; scroll(els.transcript);
  };
  g.onOutputTranscript = (t) => {
    if (!botLine) botLine = newLine(els.transcript, "Robot", "bot");
    botLine.textContent += t; scroll(els.transcript);
  };
  g.onTurnComplete = () => { userLine = null; botLine = null; };
  g.onToolCall = async (functionCalls) => {
    const results = functionCalls.map((fc) => {
      const result = sim.execute(fc.name, fc.args || {});
      serial.send(fc.name, fc.args || {});
      return result;
    });
    g.sendToolResponse(functionCalls, results);
  };
  g.onClose = (code, reason) => {
    if (running) { setStatus("error", `Link closed (${code})`); logAction(`○ Live link closed: ${code} ${reason || ""}`); powerOff(); }
  };
  g.onError = () => setStatus("error", "Connection error");
}

// ---------------- Controls ----------------
els.muteBtn.addEventListener("click", () => {
  muted = !muted; mic?.setMuted(muted);
  els.muteBtn.textContent = muted ? "Unmute" : "Mute";
  els.muteBtn.classList.toggle("active", muted);
});
els.camBtn.addEventListener("click", () => {
  cameraOn = !cameraOn; camera?.setEnabled(cameraOn);
  els.camBtn.textContent = cameraOn ? "Camera On" : "Camera Off";
  els.camBtn.classList.toggle("active", !cameraOn);
});
els.hwBtn.addEventListener("click", () => (serial.connected ? serial.disconnect() : serial.connect()));
els.fallbackBtn.addEventListener("click", () => showFallback(els.fallbackPanel.classList.contains("hidden")));

function showFallback(show) {
  els.fallbackPanel.classList.toggle("hidden", !show);
  els.fallbackBtn.classList.toggle("active", show);
}

function sendFallbackMessage() {
  const text = els.fallbackInput.value.trim();
  if (!text) return;
  els.fallbackInput.value = "";
  appendFallback("You", text, "user");
  fallback.send(text);
}
els.fallbackSend.addEventListener("click", sendFallbackMessage);
els.fallbackInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendFallbackMessage(); });

function appendFallback(who, text, cls) {
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  const b = document.createElement("b"); b.textContent = `${who}: `;
  div.appendChild(b); div.appendChild(document.createTextNode(text));
  els.fallbackLog.appendChild(div); scroll(els.fallbackLog);
}

// ---------------- Log helpers ----------------
function newLine(container, who, cls) {
  const div = document.createElement("div");
  div.className = `line ${cls}`;
  const b = document.createElement("b"); b.textContent = `${who}: `;
  div.appendChild(b);
  const span = document.createElement("span"); div.appendChild(span);
  container.appendChild(div);
  return span;
}
function scroll(el) { el.scrollTop = el.scrollHeight; }
function logAction(msg) {
  const div = document.createElement("div");
  div.className = "line";
  const time = new Date().toLocaleTimeString([], { hour12: false });
  div.textContent = `${time} · ${msg}`;
  els.actionLog.appendChild(div); scroll(els.actionLog);
  while (els.actionLog.children.length > 300) els.actionLog.removeChild(els.actionLog.firstChild);
}
function setStatus(state, text) {
  els.statusPill.dataset.state = state;
  els.statusText.textContent = text;
}
function syncOverlaySize() { els.overlay.width = CONFIG.VIDEO_WIDTH; els.overlay.height = CONFIG.VIDEO_HEIGHT; }

// ---------------- Boot ----------------
setStatus("offline", "Offline");
logAction("Cockpit ready. Press Power On to wake the robot.");
