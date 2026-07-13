// ============================================================
// Robot cognitive core — browser-native, zero backend.
//
// The browser IS the robot's head: getUserMedia camera = eyes
// (native ~30 fps on screen, throttled JPEG frames to the model),
// AudioWorklet mic = ears (16 kHz PCM straight to Gemini Live),
// WebAudio = voice (24 kHz, instant barge-in). Tool calls drive
// the Robot world model. One process, one network hop.
// ============================================================

import {
  API_KEY, CAMERA_HFOV, MAX_RETRIES, MODEL, MODEL_FRAME_FPS,
  MODEL_FRAME_JPEG_QUALITY, MODEL_FRAME_WIDTH, REGREET_COOLDOWN_MS,
  RETRY_DELAY_MS, ROOM_HALF_METERS as ROOM_HALF, SEND_SAMPLE_RATE,
  SYSTEM_PROMPT, VOICE_NAME,
} from "./config.js";
import { FaceEngine } from "./faces.js";
import { PeopleStore } from "./people-store.js";
import { Robot } from "./robot.js";
import { buildTools } from "./tools.js";
import { GoogleGenAI, Modality } from "@google/genai";
import { MicCapture, SpeakerPlayer } from "./audio.js";

const $ = (id) => document.getElementById(id);
const els = {
  powerBtn: $("powerBtn"), muteBtn: $("muteBtn"),
  statusPill: $("statusPill"), statusText: $("statusText"),
  linkPill: $("linkPill"), linkText: $("linkText"),
  cameraFeed: $("cameraFeed"), cameraOverlay: $("cameraOverlay"), cameraIdle: $("cameraIdle"),
  robotFace: $("robotFace"), speakingDot: $("speakingDot"),
  simCanvas: $("simCanvas"),
  transcript: $("transcript"), textInput: $("textInput"), textSend: $("textSend"),
  taskList: $("taskList"), actionLog: $("actionLog"),
  coordWorld: $("coordWorld"), coordHeading: $("coordHeading"),
  coordCam: $("coordCam"), coordWorldTarget: $("coordWorldTarget"),
  statGripper: $("statGripper"), statCurrentTask: $("statCurrentTask"),
  statVisitor: $("statVisitor"),
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
  visitor: null,   // null | "unknown" | person name
  speaking: false, // robot voice active (drives the mouth)
  expression: "neutral", // model-set emotion; the LED face eases toward it
};

// LED-face animation state (eased each frame toward the target expression).
const face = {
  eyeOpen: 1, vEyeOpen: 0,
  mouthOpen: 0, vMouthOpen: 0,
  curve: 0.5, vCurve: 0,
  eyeCurve: 0, vEyeCurve: 0,
  eyeScale: 1, vEyeScale: 0,
  gazeX: 0, vGazeX: 0,
  gazeY: 0, vGazeY: 0,
  browH: 0, vBrowH: 0,
  browA: 0, vBrowA: 0,
  tilt: 0, vTilt: 0,
  aMouth: 0, vAMouth: 0,
  aEyeScale: 0, vAEyeScale: 0,
  aBrowH: 0, vABrowH: 0,
  intensity: 0.5, vIntensity: 0,
  r: 52, vR: 0,
  g: 222, vG: 0,
  b: 244, vB: 0,
  browAlpha: 0, vBrowAlpha: 0,
  blinkUntil: 0,
  nextBlink: 0,
};

// Clean up hot-reloaded stale instances
if (window.activeWebSocket) {
    console.log("🔌 Closing stale hot-reloaded WebSocket...");
    try { window.activeWebSocket.close(); } catch(e){}
}
if (window.activeSpeechRecognition) {
    console.log("🎙️ Stopping stale hot-reloaded SpeechRecognition...");
    try { window.activeSpeechRecognition.stop(); } catch(e){}
}

let ws = null;
let sttRec = null;
let ai = null;
let session = null;
let mic = null;
let player = null;
const synth = window.speechSynthesis;
let sessionGen = 0;        // guards stale callbacks after power-off
let isSttProcessing = false;
let audioCtx = null;       // Reusable AudioContext to avoid Chrome limit errors


let camStream = null;
let frameTimer = null;
let retries = 0;
let userLine = null, botLine = null;

let currentSessionId = null;
const lastTaskStatuses = new Map();

// Premium Voice Visualizer State
let currentVolume = 0;
let wavePhase = 0;

async function postLog(type, content) {
  if (!currentSessionId) return;
  try {
    await fetch(`/api/log/${type}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: currentSessionId,
        timestamp: Date.now(),
        content,
      }),
    });
  } catch (e) {
    console.error("Failed to post log:", e);
  }
}

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
    
    // Log tool action to server
    postLog("action", {
      type: ok ? "call" : "error",
      message: `${name}(${JSON.stringify(args)}) -> ${ok ? "success" : "rejected: " + (result.reason || "")}`
    });

    // Log task event to server if this is execute_task and success
    if (name === "execute_task" && ok) {
      postLog("task", {
        event: "created",
        message: `Task ${result.task_id} (${args.task_type}): "${args.description}" - priority: ${args.priority || "normal"}`
      });
    }
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

    // Check for task status changes
    for (const t of snap.tasks) {
      const prev = lastTaskStatuses.get(t.id);
      if (prev !== t.status) {
        lastTaskStatuses.set(t.id, t.status);
        if (prev) { // only log changes, not initial state
          postLog("task", {
            event: "status_change",
            message: `Task ${t.id} (${t.type}) status changed from "${prev}" to "${t.status}"`
          });
        }
      }
    }
  },
});

// ----------------------------------------------------------
// Face memory — who is in front of me, and what do I know?
// (in-browser recognition, IndexedDB memory — no cloud)
// ----------------------------------------------------------
const peopleStore = new PeopleStore();
const lastGreeted = new Map(); // name -> last proactive-greeting timestamp

const faceEngine = new FaceEngine({
  store: peopleStore,
  onLog: logAction,
  onFaceBox: (box) => { state.faceBox = box; },
  onPersonChange: (who) => { handlePersonChange(who); },
});

function timeOfDay() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
}
function timeContext() {
  const now = new Date();
  const dateStr = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `Today is ${dateStr}. Local time: ${timeStr} — ${timeOfDay()}.`;
}

function sendContext(text, complete) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'text', text: text }));
    }
  } catch {}
}

async function handlePersonChange(who) {
  state.visitor = who;
  if (who === null || !session) return;

  if (who === "unknown") {
    logAction("👤 unfamiliar face in view");
    // Proactive stranger greeting: starts with a warm "Hey!" and asks for their name.
    sendContext(
      `(Vision system: an unfamiliar person has come into view. ${timeContext()} ` +
      "Greet them warmly and briefly starting with 'Hey!' or 'Hey there!', ask for their good name, " +
      "and ask how to spell it if it is needed or unusual, then wait for their response. Do not call remember_person yet.)",
      true
    );
    return;
  }

  logAction(`👤 recognized ${who}`);
  peopleStore.touch(who);
  const now = Date.now();
  if (now - (lastGreeted.get(who) || 0) < REGREET_COOLDOWN_MS) return;
  lastGreeted.set(who, now);

  const person = (await peopleStore.loadAll()).find((p) => p.name === who);
  const notes = person?.notes?.length
    ? ` What you remember about them: ${person.notes.join("; ")}.`
    : "";
  // turnComplete: true -> the robot speaks FIRST (proactive greeting)
  sendContext(
    `(Vision system: ${who} just came into view. ${timeContext()}${notes} ` +
    "Greet them by name proactively starting with a warm 'Hey!', matching the time of day, " +
    "and weave in a remembered detail if it feels natural.)",
    true
  );
}

async function executePeopleTool(name, args) {
  try {
    if (name === "remember_person") {
      const personName = String(args.name || "").trim();
      if (!personName) return { status: "error", reason: "no name given" };
      const desc = faceEngine.captureDescriptor();
      if (!desc) {
        return { status: "error", reason: "no face clearly visible right now — ask them to face the camera" };
      }
      await peopleStore.savePerson(personName, desc);
      await faceEngine.refreshMatcher();
      lastGreeted.set(personName, Date.now()); // just met — skip the proactive re-greet
      logAction(`🧠 remembered person: ${personName}`);
      return { status: "success", remembered: personName };
    }

    if (name === "remember_fact") {
      const fact = String(args.fact || "").trim();
      const who = faceEngine.current && faceEngine.current !== "unknown" ? faceEngine.current : null;
      if (!who) return { status: "error", reason: "no recognized person in view to attach this memory to" };
      if (!fact) return { status: "error", reason: "empty fact" };
      await peopleStore.addNote(who, fact);
      logAction(`🧠 noted about ${who}: ${fact}`);
      return { status: "success", person: who, noted: fact };
    }

    if (name === "forget_person") {
      const personName = String(args.name || "").trim();
      const removed = await peopleStore.removeByName(personName);
      await faceEngine.refreshMatcher();
      lastGreeted.delete(personName);
      logAction(removed ? `🗑 forgot ${personName}` : `forget_person: "${personName}" not found`);
      return removed
        ? { status: "success", forgot: personName }
        : { status: "error", reason: `no one named "${personName}" in memory` };
    }

    return { status: "error", reason: `unknown people tool "${name}"` };
  } catch (e) {
    return { status: "error", reason: String(e?.message || e) };
  }
}
const PEOPLE_TOOLS = new Set(["remember_person", "remember_fact", "forget_person"]);

// ----------------------------------------------------------
// UI tools — drive the on-screen LED face (no robot/people side effects)
// ----------------------------------------------------------
const UI_TOOLS = new Set(["set_expression"]);
const EXPRESSIONS = new Set([
  "neutral", "happy", "excited", "curious",
  "thinking", "surprised", "sad", "love", "sleepy",
  "angry", "confused", "cheeky", "bored", "scared", "sassy",
]);

function executeUiTool(name, args) {
  if (name === "set_expression") return setExpression(args.emotion);
  return { status: "error", reason: `unknown ui tool ${name}` };
}

function setExpression(emotion) {
  const e = String(emotion || "").toLowerCase();
  if (!EXPRESSIONS.has(e)) {
    return { status: "error", reason: `unknown emotion "${emotion}"` };
  }
  state.expression = e;
  logAction(`expression → ${e}`);
  return { status: "success", expression: e };
}

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

// Boot the camera + face detection at page load — no API key needed.
// The Gemini session is started separately by powerOn() / connect().
async function bootCamera() {
  const ok = await startCamera();
  setMedia(ok, ok ? "Camera ready" : "No camera");
  if (!ok) return;
  logAction("camera live — face detection starting…");
  const faceOk = await faceEngine.init();
  if (faceOk) {
    faceEngine.start(els.cameraFeed);
    logAction("face engine ready — watching for faces");
  }
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
// Local LLM & Web Speech Integration
// ----------------------------------------------------------

function initSpeechRecognition(wsRef) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.error("SpeechRecognition not supported in this browser");
        logAction("SpeechRecognition not supported");
        return null;
    }
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    let silenceTimer = null;
    let latestTranscript = '';

    rec.onstart = () => {
        console.log("🎙️ Speech recognition active");
        logAction("microphone hot");
        isSttProcessing = false;
        latestTranscript = '';
    };

    rec.onerror = (e) => {
        console.error("🎙️ Speech recognition error:", e.error);
        logAction(`mic error: ${e.error}`);
    };

    rec.onend = () => {
        console.log("🎙️ Speech recognition disconnected");
        if (silenceTimer) clearTimeout(silenceTimer);
        // Auto-restart if ws is open, not muted, and we are NOT currently processing or speaking
        if (ws && ws.readyState === WebSocket.OPEN && !state.muted && !isSttProcessing && !state.speaking) {
            console.log("🎙️ Restarting Speech recognition...");
            try { rec.start(); } catch(err) {
                console.error("Failed to restart speech recognition:", err);
            }
        } else {
            logAction("microphone off");
        }
    };

    rec.onresult = (event) => {
        if (isSttProcessing) return; // Ignore input if already processing
        
        let final = '';
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                final += event.results[i][0].transcript;
            } else {
                interim += event.results[i][0].transcript;
            }
        }
        
        let currentText = final || interim;
        if (currentText) {
            latestTranscript = currentText.trim();
        }

        // Reset the silence timer
        if (silenceTimer) clearTimeout(silenceTimer);
        
        if (latestTranscript && wsRef && wsRef.readyState === WebSocket.OPEN && !state.muted) {
            silenceTimer = setTimeout(() => {
                isSttProcessing = true;
                console.log("🎙️ Smart Silence Detected! Sending:", latestTranscript);
                transcriptDelta("user", latestTranscript);
                userLine = null;
                wsRef.send(JSON.stringify({ type: 'text', text: latestTranscript }));
                
                // Stop the recognition immediately to prevent further result events
                try { rec.stop(); } catch(e){}
            }, 2200); // 2.2 seconds of silence to allow mid-sentence pauses
        }
    };
    
    return rec;
}

function playRobotBeep() { 
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        if (!audioCtx) {
            audioCtx = new AudioContextClass();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.type = 'sine';
        // Classic high-pitched double-beep
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.08);
        
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.22);
        
        osc.start();
        osc.stop(audioCtx.currentTime + 0.22);
    } catch(e) {
        console.error("Failed to play robot beep:", e);
    }
}

function cleanSpeechText(text) {
    if (!text) return "";
    
    let clean = text
        // Strip emojis and symbols that speech engines pronounce literally
        .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu, '')
        // Strip asterisks (*) and underscores (_) commonly outputted by LLMs for formatting
        .replace(/\*/g, '')
        .replace(/_/g, '')
        // Replace double hyphens with a space
        .replace(/--/g, ' ')
        // Clean up stuttering notations like "Wh.. what" or "w-w-what"
        .replace(/\b(\w+)\.\.\s*\1\b/gi, '$1')
        .replace(/\b\w+-\w+-\b/gi, '')
        .replace(/\b(\w)-\1-(\w+)\b/gi, '$2')
        .replace(/\b(\w)-(\w+)\b/gi, '$2')
        .replace(/\b(\w)\.\.(\w+)\b/gi, (match, g1, g2) => {
            if (g2.startsWith(g1.toLowerCase()) || g2.startsWith(g1.toUpperCase())) {
                return g2;
            }
            return match;
        })
        .replace(/\bwh\.\.\s*what\b/gi, 'what')
        .replace(/\b(\w+)-\1\b/gi, '$1')
        // Replace multiple dots (e.g. "hello.. how") with space/comma
        .replace(/\.{2,}/g, ' ')
        // Clean up extra spacing
        .replace(/\s+/g, ' ')
        .trim();
        
    return clean;
}

function speak(text, prosody = {}, onStart, onEnd) {
    synth.cancel(); // Stop current speech
    
    // Stop the mic immediately so it doesn't listen during playback
    if (sttRec) {
        try { sttRec.stop(); } catch(e){} 
    }

    // Play robot beep sound effect if text contains "beep" or "boop"
    const hasBeeps = /beep|boop/i.test(text);
    if (hasBeeps) {
        playRobotBeep();
    }

    // Clean up stutters and strip beep/boop words from speech synthesis
    let cleanText = cleanSpeechText(text)
        .replace(/\bbeep\b/gi, '')
        .replace(/\bboop\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

    const utterance = new SpeechSynthesisUtterance(cleanText);
    
    const voices = synth.getVoices();
    const preferredVoices = [
        'Microsoft Sonia Online (Natural)',
        'Microsoft Aria Online (Natural)',
        'Microsoft Jenny Online (Natural)',
        'Google US English',
        'Samantha',
        'Alex'
    ];

    let selectedVoice = voices.find(v => v.lang.startsWith('en'));
    for (const name of preferredVoices) {
        const found = voices.find(v => v.name.includes(name));
        if (found) {
            selectedVoice = found;
            break;
        }
    }

    if (selectedVoice) utterance.voice = selectedVoice;
    
    // Apply LLM prosody formatting
    utterance.pitch = 0.5 + (prosody.pitch || 0.5);
    utterance.rate = Math.max(0.5, Math.min(2, prosody.speed || 1.0));
    utterance.volume = Math.max(0, Math.min(1, prosody.volume || 0.9));
    
    let safetyTimeout = null;
    const cleanup = () => {
        if (safetyTimeout) {
            clearTimeout(safetyTimeout);
            safetyTimeout = null;
        }
        state.speaking = false;
        els.speakingDot?.classList.remove("active");
        
        // Restart speech recognition after speech finishes
        isSttProcessing = false;
        if (sttRec && ws && ws.readyState === WebSocket.OPEN && !state.muted) {
            console.log("🎙️ Speech finished/reset. Restarting mic...");
            try { sttRec.start(); } catch(e){}
        }
    };

    utterance.onstart = () => {
        state.speaking = true;
        els.speakingDot?.classList.add("active");
        if (onStart) onStart();
        
        // Safety timeout: dynamic duration based on character count (approx 12 characters per second + 8s buffer)
        const safetyDuration = Math.max(15000, (cleanText.length / 12) * 1000 + 8000);
        safetyTimeout = setTimeout(() => {
            console.warn("🎙️ Speech synthesis took too long or got stuck. Forcing cleanup.");
            synth.cancel();
            cleanup();
            if (onEnd) onEnd();
        }, safetyDuration);
    };

    utterance.onend = () => {
        cleanup();
        if (onEnd) onEnd();
    };

    utterance.onerror = (err) => {
        console.error("SpeechSynthesis error:", err);
        cleanup();
        if (onEnd) onEnd();
    };
    
    // Wrap speak in a setTimeout to avoid Chrome SpeechSynthesis queue bug
    setTimeout(() => {
        synth.speak(utterance);
        
        // Fallback: If onstart is never fired (swallowed completely by browser), force cleanup after 4.5s
        // This allows slow online natural voices (Microsoft Edge) to fetch audio without false triggers
        safetyTimeout = setTimeout(() => {
            if (!state.speaking) {
                console.warn("🎙️ Speech onstart never fired. Swallowed by browser? Forcing cleanup.");
                cleanup();
                if (onEnd) onEnd();
            }
        }, 4500);
    }, 100);
}

let micStream = null;
let micAnalyser = null;
let micSource = null;

async function initBargeInAnalyser() {
    try {
        if (!audioCtx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioContextClass();
        }
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micSource = audioCtx.createMediaStreamSource(micStream);
        micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 256;
        micSource.connect(micAnalyser);
        
        const bufferLength = micAnalyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        function checkVolume() {
            if (!state.powerOn) return; // Stop checking if powered off
            
            if (state.speaking && micAnalyser) {
                micAnalyser.getByteTimeDomainData(dataArray);
                
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    const deviation = (dataArray[i] - 128) / 128;
                    sum += deviation * deviation;
                }
                const rms = Math.sqrt(sum / bufferLength);
                
                // Volume threshold (0.12 requires firm speaking or clap close to mic)
                const BARGE_IN_THRESHOLD = 0.12;
                if (rms > BARGE_IN_THRESHOLD) {
                    console.log("🎙️ Interruption detected! RMS:", rms);
                    handleBargeIn();
                }
            }
            requestAnimationFrame(checkVolume);
        }
        
        checkVolume();
    } catch(e) {
        console.error("Failed to initialize barge-in analyzer:", e);
    }
}

function handleBargeIn() {
    // 1. Halt speech immediately
    synth.cancel();
    
    // 2. Change expression to surprised
    targetState = setEmotion("surprise", 0.8);
    
    // 3. Update transcript to show interruption
    transcriptDelta("robot", " [interrupted]...");
    botLine = null; // reset line boundary
    
    // 4. Force speech recognition to restart immediately
    isSttProcessing = false;
    state.speaking = false;
    els.speakingDot?.classList.remove("active");
    
    if (sttRec) {
        try { sttRec.stop(); } catch(e){}
    }
}

async function powerOn() {
  if (ws || state.powerOn) return;
  
  // Initialize barge-in analyser
  await initBargeInAnalyser();
  
  // Wipe all saved face embeddings and memories to start completely fresh from scratch
  await peopleStore.clearAll();
  await faceEngine.refreshMatcher();
  
  // Reuse existing sessionId from sessionStorage if present (handles refreshes)
  let sessionId = sessionStorage.getItem("robot_session_id");
  if (!sessionId) {
    const pad = (n) => String(n).padStart(2, "0");
    const d = new Date();
    sessionId = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    sessionStorage.setItem("robot_session_id", sessionId);
  }
  currentSessionId = sessionId;
  lastTaskStatuses.clear();

  retries = 0;
  await connect();
}

async function connect() {
  const gen = ++sessionGen;
  
  // Clean up any existing WebSocket cleanly before starting a new connection
  if (ws) {
      try {
          ws.onclose = null;
          ws.close();
      } catch(e){}
      ws = null;
  }
  
  setStatus("connecting", "waking up…");
  logAction(`connecting -> Local LLM`);

  try {
    const socket = new WebSocket(`ws://localhost:8080/ws?sessionId=${currentSessionId}`);
    ws = socket;
    window.activeWebSocket = socket;
    
    socket.onopen = () => {
        if (gen !== sessionGen) return;
        retries = 0;
        setStatus("online", "");
        logAction("online — listening & watching");
        setMedia(true, "Media ✓");
    };
    
    socket.onmessage = async (event) => {
        if (gen !== sessionGen) return;
        const data = JSON.parse(event.data);
        
        if (data.type === 'init') {
            if (data.mode === 'gemini_live') {
                console.log("🧠 Switching to Gemini Live mode!");
                try {
                    socket.onclose = null; // Prevent reconnect loop
                    socket.close();
                } catch(e){} 
                if (ws === socket) ws = null;
                runGeminiLiveMode(data.apiKey, data.model, data.voice, gen);
            } else {
                console.log("🧠 Staying in Gemma 4 mode!");
                sttRec = initSpeechRecognition(socket);
                window.activeSpeechRecognition = sttRec;
                if (sttRec && !state.muted) {
                    try { sttRec.start(); } catch(e){}
                    logAction("microphone hot");
                }
            }
            return;
        }
        
        if (data.type === 'response') {
            if (data.emotion) {
                const emotionMap = {
                    "happiness": "happy",
                    "sadness": "sad",
                    "curiosity": "curious",
                    "surprise": "surprised",
                    "fear": "scared",
                    "anger": "angry"
                };
                const mappedEmotion = emotionMap[data.emotion.toLowerCase()] || data.emotion;
                setExpression(mappedEmotion);
            }
            
            if (data.speech_text) {
                transcriptDelta("robot", data.speech_text);
                botLine = null; // Reset botLine so next response starts a new line
                speak(
                    data.speech_text, 
                    data.prosody || {},
                    () => { 
                        state.speaking = true;
                        els.speakingDot?.classList.add("active");
                    },
                    () => { 
                        state.speaking = false;
                        els.speakingDot?.classList.remove("active");
                    }
                );
            }
        }
    };
    
    socket.onerror = (e) => {
        if (gen !== sessionGen) return;
        logAction(`link error`);
    };
    
    socket.onclose = (e) => {
        if (gen !== sessionGen) return;
        if (ws === socket) ws = null;
        maybeReconnect(e?.reason || "link closed");
    };
    
  } catch (e) {
    ws = null;
    teardownMedia();
    setStatus("error", `connect failed: ${e?.message || e}`);
    logAction(`connect failed: ${e?.message || e}`);
    return;
  }

  // Wipe all saved face embeddings and memories to start completely fresh from scratch
  await peopleStore.clearAll();
  await faceEngine.refreshMatcher();

  const knownNames = [];
  const knownTxt = knownNames.length
    ? `People you already know by face: ${knownNames.join(", ")}.`
    : "You don't know anyone by face yet.";
  
  // Try to send boot context once connected (disabled to prevent double responses on startup)
  /*
  setTimeout(() => {
    sendContext(
      `(System boot complete. ${timeContext()} ${knownTxt} Say a short and warm "Hey!" or "Hey there!", matching the time of day, and wait for the user to respond.)`,
      true
    );
  }, 1000);
  */
}

function maybeReconnect(reason) {
  if (!state.powerOn) return;
  
  // Prevent reconnect loop if Gemini Live (WebRTC) connection fails
  if (ws === null) {
      console.error("🔌 Gemini Live connection failed:", reason);
      logAction(`Gemini Live connection failed: ${reason}`);
      setStatus("error", `Live API failed: ${reason}`);
      teardownMedia();
      return;
  }
  
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
  if (sttRec) {
    try { sttRec.stop(); } catch(e){}
    sttRec = null;
  }
  synth.cancel();
  state.speaking = false;
  els.speakingDot?.classList.remove("active");

  // Clean up Gemini Live captures
  if (mic) {
    try { mic.stop(); } catch(e){}
    mic = null;
  }
  if (player) {
    try { player.stop(); } catch(e){}
    player = null;
  }
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
}

function powerOff() {
  sessionGen++; // invalidate all in-flight callbacks
  try { if (ws) ws.close(); } catch {}
  ws = null;

  // Clean up Gemini Live session
  try { if (session) session.close(); } catch(e){}
  session = null;

  teardownMedia();
  
  // Clear the session storage on manual Power Off
  sessionStorage.removeItem("robot_session_id");
  currentSessionId = null;
  
  setStatus("offline", "");
  setMedia(false, "Media off");
  logAction("cognitive core shut down");

  // Stop mic stream if active
  if (micStream) {
      try {
          micStream.getTracks().forEach(track => track.stop());
      } catch(e){}
      micStream = null;
  }
}

// ----------------------------------------------------------
// Controls
// ----------------------------------------------------------
els.powerBtn.addEventListener("click", () => {
  if (state.powerOn) {
    powerOff();
  } else {
    powerOn();
  }
});
const exprBtns = document.querySelectorAll("#expressionControls .btn");
if (exprBtns) {
  exprBtns.forEach(btn => {
    btn.addEventListener("click", (e) => {
      setExpression(e.target.dataset.expr);
    });
  });
}
els.muteBtn.addEventListener("click", () => {
  state.muted = !state.muted;
  if (sttRec) {
    if (state.muted) {
        try { sttRec.stop(); } catch(e){}
    } else {
        try { sttRec.start(); } catch(e){}
    }
  }
  els.muteBtn.textContent = state.muted ? "Unmute" : "Mute";
  els.muteBtn.classList.toggle("active", state.muted);
  logAction(`mic ${state.muted ? "muted" : "live"}`);
});

function sendText() {
  const text = els.textInput.value.trim();
  if (!text) return;
  els.textInput.value = "";
  transcriptDelta("user", text);
  postLog("conversation", { role: "user", text });
  userLine = null;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'text', text: text }));
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
  els.statVisitor.textContent =
    state.visitor === null ? "—" : state.visitor === "unknown" ? "unknown" : state.visitor;
  els.statVisitor.className =
    `metric-value ${state.visitor === "unknown" ? "warn" : state.visitor ? "ok" : ""}`;
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
  drawRobotFace();
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
  // Size the overlay canvas to match the video element's actual display pixels
  // (DPR-aware), so the face box aligns perfectly with the video.
  const videoEl = els.cameraFeed;
  const rect = videoEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.round(rect.width);
  const cssH = Math.round(rect.height);
  if (els.cameraOverlay.width !== cssW * dpr || els.cameraOverlay.height !== cssH * dpr) {
    els.cameraOverlay.width = cssW * dpr;
    els.cameraOverlay.height = cssH * dpr;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const W = cssW, H = cssH;
  octx.clearRect(0, 0, W, H);

  // face recognition box + name badge
  const fb = state.faceBox;
  if (fb) {
    const known = fb.label !== "unknown";
    const x = fb.x * W, y = fb.y * H, w = fb.w * W, h = fb.h * H;
    // Glowing box: cyan for known, amber for unknown
    octx.shadowColor = known ? "rgba(16,185,129,0.8)" : "rgba(245,158,11,0.8)";
    octx.shadowBlur = 10;
    octx.strokeStyle = known ? "rgba(16,185,129,0.95)" : "rgba(245,158,11,0.95)";
    octx.lineWidth = 2.5;
    octx.strokeRect(x, y, w, h);
    octx.shadowBlur = 0;
    // Corner accent marks
    const cs = Math.min(w, h) * 0.18;
    octx.strokeStyle = known ? "#10b981" : "#f59e0b";
    octx.lineWidth = 3;
    [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([cx,cy], i) => {
      const sx = i % 2 === 0 ? 1 : -1, sy = i < 2 ? 1 : -1;
      octx.beginPath();
      octx.moveTo(cx, cy + sy * cs); octx.lineTo(cx, cy); octx.lineTo(cx + sx * cs, cy);
      octx.stroke();
    });
    // Name badge
    const label = known ? fb.label : "unknown";
    octx.font = "600 13px system-ui, sans-serif";
    const tw = octx.measureText(label).width;
    const by = Math.max(22, y);
    octx.fillStyle = known ? "rgba(6,95,70,0.92)" : "rgba(120,53,15,0.92)";
    octx.beginPath();
    octx.roundRect(x, by - 22, tw + 16, 22, 4);
    octx.fill();
    octx.fillStyle = "#fff";
    octx.fillText(label, x + 8, by - 6);
  }

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
logAction(`display ready - click Power On to start`);
state.powerOn = false;
state.expression = "neutral";

requestAnimationFrame(tick);
// Auto-start camera + face detection without needing Power On.
bootCamera();

// ----------------------------------------------------------
// LED dot-matrix robot face
// ----------------------------------------------------------
// Per-expression target shape params.
const EXPR_PARAMS = {
  neutral:     { curve: 0.35, eyeCurve: 0.0,  eyeScale: 1.0,  base: 0.05, gazeX: 0.0,  gazeY: 0.0,  browH: 0.0, browA: 0.0, tilt: 0.0, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 1.0, intensity: 0.6, r: 52, g: 222, b: 244, browAlpha: 0.0 },
  happy:       { curve: 1.0,  eyeCurve: 0.6,  eyeScale: 1.15, base: 0.12, gazeX: 0.0,  gazeY: 0.0,  browH: 0.0, browA: 0.0, tilt: 0.0, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 1.5, intensity: 1.0, r: 253, g: 167, b: 68, browAlpha: 0.0 },
  curious:     { curve: 0.45, eyeCurve: 0.2,  eyeScale: 1.1,  base: 0.06, gazeX: 0.28, gazeY: 0.1,  browH: 0.2, browA: 0.0, tilt: 0.1, aMouth: 0.0, aBrowH: 0.2, aEyeScale: 0.0, jitter: 1.1, intensity: 0.7, r: 87, g: 219, b: 210, browAlpha: 1.0 },
  thinking:    { curve: 0.1,  eyeCurve: -0.1, eyeScale: 0.9,  base: 0.03, gazeX: 0.36, gazeY: -0.2, browH: -0.1, browA: 0.1, tilt: -0.05, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 0.8, intensity: 0.5, r: 43, g: 212, b: 238, browAlpha: 0.0 },
  surprised:   { curve: 0.1,  eyeCurve: 0.0,  eyeScale: 1.45, base: 0.55, gazeX: 0.0,  gazeY: 0.2,  browH: 0.5, browA: 0.1, tilt: 0.0, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 1.4, intensity: 1.0, r: 223, g: 210, b: 144, browAlpha: 1.0 },
  sad:         { curve: -0.7, eyeCurve: -0.6, eyeScale: 0.95, base: 0.04, gazeX: 0.0,  gazeY: -0.3, browH: 0.0, browA: 0.0, tilt: 0.05, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 0.6, intensity: 0.3, r: 23, g: 159, b: 232, browAlpha: 0.0 },
  love:        { curve: 0.85, eyeCurve: 0.7,  eyeScale: 1.05, base: 0.08, gazeX: 0.0,  gazeY: 0.0,  browH: 0.0, browA: 0.0, tilt: 0.0, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 1.0, intensity: 0.8, r: 246, g: 76, b: 161, browAlpha: 0.0 },
  sleepy:      { curve: 0.2,  eyeCurve: 0.3,  eyeScale: 0.55, base: 0.03, gazeX: 0.0,  gazeY: -0.1, browH: 0.0, browA: 0.0, tilt: 0.0, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 0.3, intensity: 0.2, r: 25, g: 189, b: 230, browAlpha: 0.0 },
  angry:       { curve: -0.2, eyeCurve: -0.4, eyeScale: 0.9,  base: 0.0,  gazeX: 0.0,  gazeY: 0.0,  browH: -0.3, browA: -0.4, tilt: 0.0, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 1.5, intensity: 1.0, r: 250, g: 56, b: 72, browAlpha: 1.0 },
  confused:    { curve: 0.1,  eyeCurve: -0.1, eyeScale: 1.0,  base: 0.05, gazeX: -0.1, gazeY: 0.0,  browH: 0.0, browA: 0.0, tilt: 0.15, aMouth: -0.1, aBrowH: 0.4, aEyeScale: 0.1, jitter: 1.2, intensity: 0.7, r: 49, g: 219, b: 242, browAlpha: 1.0 },
  cheeky:      { curve: 0.6,  eyeCurve: 0.4,  eyeScale: 0.95, base: 0.05, gazeX: 0.1,  gazeY: 0.0,  browH: 0.0, browA: 0.0, tilt: -0.1, aMouth: 0.4, aBrowH: 0.3, aEyeScale: -0.1, jitter: 1.1, intensity: 0.8, r: 234, g: 197, b: 87, browAlpha: 1.0 },
  bored:       { curve: 0.1,  eyeCurve: 0.0,  eyeScale: 0.75, base: 0.0,  gazeX: 0.0,  gazeY: 0.0,  browH: 0.0, browA: 0.0, tilt: 0.0, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 0.2, intensity: 0.3, r: 55, g: 158, b: 190, browAlpha: 0.0 },
  scared:      { curve: -0.3, eyeCurve: -0.1, eyeScale: 1.3,  base: 0.2,  gazeX: 0.0,  gazeY: -0.1, browH: 0.4, browA: 0.2, tilt: 0.0, aMouth: 0.0, aBrowH: 0.0, aEyeScale: 0.0, jitter: 3.0, intensity: 1.0, r: 53, g: 143, b: 233, browAlpha: 1.0 },
};

function spring(p, t, v, k, d) {
  const f = (t - p) * k - v * d;
  v += f;
  p += v;
  return { p, v };
}

function drawRobotFace() {
  const canvas = els.robotFace;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.round(rect.width), cssH = Math.round(rect.height);
  if (cssW < 2 || cssH < 2) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW, H = cssH;
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, W, H);

  const p = EXPR_PARAMS[state.expression] || EXPR_PARAMS.neutral;
  const now = performance.now();
  const asleep = !state.powerOn;
  const listening = state.powerOn && !state.speaking && !state.muted && currentVolume > 0.02;

  // Layered idle motion
  const t = now / 1000;
  const jit = asleep ? 0 : p.jitter;
  const breath = Math.sin(t * 1.5) * 0.03 * jit;
  const driftX = Math.sin(t * 0.8) * 0.08 * jit;
  const driftY = Math.cos(t * 1.1) * 0.08 * jit;
  
  // Occasional saccades
  if (!face.saccadeTime || now > face.saccadeTime) {
    face.saccadeX = (Math.random() - 0.5) * 0.2 * jit;
    face.saccadeY = (Math.random() - 0.5) * 0.2 * jit;
    face.saccadeTime = now + 1000 + Math.random() * 3000;
  }
  // Smoothly blend out saccade over time
  const sacProgress = Math.max(0, 1 - (now - (face.saccadeTime - 1000)) / 200);
  const sacX = face.saccadeX * sacProgress;
  const sacY = face.saccadeY * sacProgress;

  const targetGazeX = p.gazeX + driftX + sacX;
  const targetGazeY = p.gazeY + driftY + sacY;
  const eyeScaleT = (asleep ? 0.9 : p.eyeScale) * (listening ? 1.08 : 1) + breath;

  // Spring physics (critically damped-ish)
  const kFast = 0.1, dFast = 0.4;
  const kSlow = 0.05, dSlow = 0.3;

  let res;
  res = spring(face.curve, p.curve, face.vCurve, kFast, dFast); face.curve = res.p; face.vCurve = res.v;
  res = spring(face.eyeCurve, p.eyeCurve, face.vEyeCurve, kFast, dFast); face.eyeCurve = res.p; face.vEyeCurve = res.v;
  res = spring(face.eyeScale, eyeScaleT, face.vEyeScale, kSlow, dSlow); face.eyeScale = res.p; face.vEyeScale = res.v;
  res = spring(face.gazeX, targetGazeX, face.vGazeX, kFast, dFast); face.gazeX = res.p; face.vGazeX = res.v;
  res = spring(face.gazeY, targetGazeY, face.vGazeY, kFast, dFast); face.gazeY = res.p; face.vGazeY = res.v;
  res = spring(face.browH, p.browH, face.vBrowH, kFast, dFast); face.browH = res.p; face.vBrowH = res.v;
  res = spring(face.browA, p.browA, face.vBrowA, kFast, dFast); face.browA = res.p; face.vBrowA = res.v;
  res = spring(face.tilt, p.tilt, face.vTilt, 0.08, 0.4); face.tilt = res.p; face.vTilt = res.v;
  res = spring(face.aMouth, p.aMouth, face.vAMouth, kFast, dFast); face.aMouth = res.p; face.vAMouth = res.v;
  res = spring(face.aEyeScale, p.aEyeScale, face.vAEyeScale, kFast, dFast); face.aEyeScale = res.p; face.vAEyeScale = res.v;
  res = spring(face.aBrowH, p.aBrowH, face.vABrowH, kFast, dFast); face.aBrowH = res.p; face.vABrowH = res.v;

  res = spring(face.intensity, p.intensity, face.vIntensity, kSlow, dSlow); face.intensity = res.p; face.vIntensity = res.v;
  res = spring(face.r, p.r, face.vR, kSlow, dSlow); face.r = res.p; face.vR = res.v;
  res = spring(face.g, p.g, face.vG, kSlow, dSlow); face.g = res.p; face.vG = res.v;
  res = spring(face.b, p.b, face.vB, kSlow, dSlow); face.b = res.p; face.vB = res.v;
  res = spring(face.browAlpha, p.browAlpha, face.vBrowAlpha, kFast, dFast); face.browAlpha = res.p; face.vBrowAlpha = res.v;

  if (!asleep && now > face.nextBlink) {
    face.blinkUntil = now + 110 + (Math.random() < 0.1 ? 100 : 0); // occasionally longer blink
    face.nextBlink = now + 2600 + Math.random() * 3600;
  }
  const eyeOpenT = asleep ? 0.12 : (now < face.blinkUntil ? (Math.random() < 0.2 ? 0.3 : 0.06) : 1);
  res = spring(face.eyeOpen, eyeOpenT, face.vEyeOpen, 0.4, 0.5); face.eyeOpen = res.p; face.vEyeOpen = res.v;

  const level = state.speaking ? (Math.sin(performance.now() / 70) * 0.25 + 0.25) : 0;
  const mouthT = asleep ? 0 : Math.max(p.base, level);
  res = spring(face.mouthOpen, mouthT, face.vMouthOpen, 0.3, 0.6); face.mouthOpen = res.p; face.vMouthOpen = res.v;

  // ---- dynamic overrides ----
  let dynamicEyeScale = face.eyeScale;
  if (state.expression === "love") {
    const beat = (now % 1000) / 1000; 
    if (beat < 0.15) {
      dynamicEyeScale += Math.sin(beat / 0.15 * Math.PI) * 0.15;
    } else if (beat > 0.2 && beat < 0.35) {
      dynamicEyeScale += Math.sin((beat - 0.2) / 0.15 * Math.PI) * 0.1;
    }
  }

  let eyeRollX = 0, eyeRollY = 0;
  if (state.expression === "bored") {
    const roll = (now % 4000) / 4000; // 4 second loop
    if (roll < 0.15) {
      const p = roll / 0.15;
      eyeRollX = -0.8 * p;
      eyeRollY = -0.8 * p;
    } else if (roll < 0.4) {
      const p = (roll - 0.15) / 0.25;
      eyeRollX = -0.8 + 1.6 * p; 
      eyeRollY = -0.8 - 0.2 * Math.sin(p * Math.PI); 
    } else if (roll < 0.5) {
      const p = (roll - 0.4) / 0.1;
      eyeRollX = 0.8 * (1 - p);
      eyeRollY = -0.8 * (1 - p);
    }
  }

  // ---- geometry ----
  const TAU = Math.PI * 2;
  const u = Math.min(W, H);
  const cx = W / 2, cy = H / 2;
  
  // Apply Tilt globally
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(face.tilt);
  ctx.translate(-cx, -cy);

  const eyeDX = u * 0.2;
  const eyeY = cy - u * 0.12 + (face.gazeY + eyeRollY) * u * 0.05;
  const gazePx = (face.gazeX + eyeRollX) * u * 0.04;
  const mouthY = cy + u * 0.16, mw = u * 0.24;

  const baseIntensity = Math.max(0.1, Math.min(1.0, face.intensity));
  
  const rC = Math.max(0, Math.min(255, Math.round(face.r)));
  const gC = Math.max(0, Math.min(255, Math.round(face.g)));
  const bC = Math.max(0, Math.min(255, Math.round(face.b)));
  
  const rgbStr = `${rC}, ${gC}, ${bC}`;
  
  // Pulse glow intensity with the breathing sine wave
  const pulse = 1.0 + breath * 2.0; 
  const finalAlpha = Math.min(1, baseIntensity * pulse);

  // --- Matrix Dot Grid Mode ---
  const eyeLit = (px, py, side) => {
    const scale = dynamicEyeScale + (side > 0 ? face.aEyeScale : -face.aEyeScale);
    const eyeRx = u * 0.115 * scale;
    const eyeRy = u * 0.125 * scale * Math.max(0.08, face.eyeOpen);
    const ecx = cx + side * eyeDX + gazePx;
    const X = px - ecx, Y = py - eyeY;
    
    if (state.expression === "love") {
      // Heart shape equation: (x^2 + y^2 - 1)^3 - x^2 * y^3 <= 0
      let nx = X / (u * 0.115 * scale) * 1.25;
      let ny = -Y / (u * 0.115 * scale) * 1.25 + 0.2; // canvas Y is inverted, shift up slightly
      let eq = Math.pow(nx*nx + ny*ny - 1, 3) - nx*nx * ny*ny*ny;
      return eq <= 0;
    }

    if ((X / eyeRx) ** 2 + (Y / eyeRy) ** 2 > 1) return false;
    
    if (Math.abs(face.eyeCurve) > 0.05 && face.eyeOpen > 0.4) {
      const off = face.eyeCurve * eyeRy * 1.1; 
      if ((X / eyeRx) ** 2 + ((Y - off) / eyeRy) ** 2 <= 1) return false;
    }
    return true;
  };

    const browLit = (px, py, side) => {
      if (face.eyeOpen < 0.2 || face.browAlpha < 0.01) return false;
      const h = face.browH + (side > 0 ? face.aBrowH : -face.aBrowH);
      const browY = eyeY - u * 0.15 - h * u * 0.1;
      const ecx = cx + side * eyeDX + gazePx;
      const X = px - ecx, Y = py - browY;
      const ang = side * face.browA;
      const rX = X * Math.cos(-ang) - Y * Math.sin(-ang);
      const rY = X * Math.sin(-ang) + Y * Math.cos(-ang);
      
      if (Math.abs(rX) < u * 0.12 && Math.abs(rY) < u * 0.015) return true;
      return false;
    };

    const mouthLit = (px, py) => {
      const X = px - cx;
      if (Math.abs(X) > mw) return false;
      const t = X / mw; // -1 to 1
      const asymOffset = t * face.aMouth * (u * 0.05); 
      const yc = mouthY + face.curve * (u * 0.075) * (1 - t * t) - asymOffset;
      const taper = Math.sqrt(Math.max(0, 1 - t * t));
      const half = (u * 0.017 + face.mouthOpen * u * 0.1) * (0.4 + 0.6 * taper);
      return Math.abs(py - yc) <= half;
    };

    const cell = Math.max(6, Math.round(u / 45)); 
    const rDim = cell * 0.14, rLit = cell * 0.45;
    const lit = [];
    
    ctx.fillStyle = `rgba(${rgbStr}, ${0.05 * finalAlpha})`;
    for (let py = 0; py < H; py += cell) {
      for (let px = 0; px < W; px += cell) {
        if (eyeLit(px, py, -1) || eyeLit(px, py, 1) || mouthLit(px, py) || browLit(px, py, -1) || browLit(px, py, 1)) {
          lit.push(px, py);
        } else {
          ctx.beginPath();
          ctx.arc(px, py, rDim, 0, TAU);
          ctx.fill();
        }
      }
    }
    
  ctx.shadowColor = `rgba(${rgbStr}, ${finalAlpha})`;
  ctx.shadowBlur = cell * 0.75;
  ctx.fillStyle = `rgba(${rgbStr}, ${finalAlpha})`;
  for (let i = 0; i < lit.length; i += 2) {
    ctx.beginPath();
    ctx.arc(lit[i], lit[i+1], rLit, 0, TAU);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.restore();
}

async function runGeminiLiveMode(apiKey, modelName, voiceName, gen) {
  player = new SpeakerPlayer({
    onSpeaking: (active) => {
      state.speaking = active;
      els.speakingDot?.classList.toggle("active", active);
    },
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
      currentVolume = rms;
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
  const camOk = !!camStream;
  setMedia(micOk && camOk, micOk && camOk ? "Media ✓" : micOk ? "No camera" : camOk ? "No mic" : "No media");
  if (micOk) logAction(`microphone hot · ${mic.label()} · echo-cancelled (barge-in enabled)`);

  ai = new GoogleGenAI({ apiKey: apiKey, httpOptions: { apiVersion: "v1beta" } });
  logAction(`connecting -> ${modelName} · voice ${voiceName}`);

  try {
    session = await ai.live.connect({
      model: modelName,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } },
        },
        systemInstruction: SYSTEM_PROMPT,
        tools: buildTools(),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: async () => {
          if (gen !== sessionGen) return;
          retries = 0;
          setStatus("online", "");
          logAction("online — listening & watching");
          
          // Seed session memory from python backend log cache if present
          try {
              const res = await fetch(`/api/memory?sessionId=${currentSessionId}`);
              const data = await res.json();
              if (data.turns && data.turns.length > 0) {
                  console.log(`🧠 Seeding Gemini Live session memory with ${data.turns.length} turns`);
                  session.sendClientContent({
                      turns: data.turns,
                      turnComplete: false
                  });
                  logAction(`reloaded ${data.turns.length} conversation context turns`);
              }
          } catch (e) {
              console.warn("Failed to reload session memory:", e);
          }
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

  if (gen !== sessionGen) return;

  if (camOk) {
    startFrameUpload(gen);
    logAction(`camera stream: native fps on screen · ${MODEL_FRAME_FPS} fps to the model`);
    if (faceEngine.ready && !faceEngine._timer) faceEngine.start(els.cameraFeed);
  }
}

function handleServerMessage(msg) {
  if (msg.data) player?.play(bytesFromB64(msg.data));

  const tc = msg.toolCall;
  if (tc?.functionCalls?.length) {
    Promise.all(tc.functionCalls.map(async (fc) => ({
      id: fc.id,
      name: fc.name,
      response: {
        result: UI_TOOLS.has(fc.name)
          ? executeUiTool(fc.name, fc.args || {})
          : PEOPLE_TOOLS.has(fc.name)
          ? await executePeopleTool(fc.name, fc.args || {})
          : robot.execute(fc.name, fc.args || {}),
      },
    }))).then((functionResponses) => {
      try { session?.sendToolResponse({ functionResponses }); } catch {}
    });
  }

  const sc = msg.serverContent;
  if (sc) {
    if (sc.inputTranscription?.text) transcriptDelta("user", sc.inputTranscription.text);
    if (sc.outputTranscription?.text) transcriptDelta("robot", sc.outputTranscription.text);
    if (sc.interrupted) {
      player?.interrupt();
      logAction("interrupted — user barge-in");
      postLog("action", { type: "interrupt", message: "User barge-in interrupted playback" });
    }
    if (sc.turnComplete) {
      if (userLine && userLine.textContent) {
        postLog("conversation", { role: "user", text: userLine.textContent });
      }
      if (botLine && botLine.textContent) {
        postLog("conversation", { role: "robot", text: botLine.textContent });
      }
      userLine = null;
      botLine = null;
    }
  }
}
