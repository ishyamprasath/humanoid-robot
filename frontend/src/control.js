import { relay } from './relay.js';

const els = {
    statusPill: document.getElementById('statusPill'),
    statusText: document.getElementById('statusText'),
    powerBtn: document.getElementById('powerBtn'),
    muteBtn: document.getElementById('muteBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    modeToggleBtn: document.getElementById('modeToggleBtn'),
    faceTranscriptBtn: document.getElementById('faceTranscriptBtn'),
    transcript: document.getElementById('transcript'),
    actionLog: document.getElementById('actionLog'),
    taskList: document.getElementById('taskList'),
    textInput: document.getElementById('textInput'),
    textSend: document.getElementById('textSend'),
    modeBtns: document.querySelectorAll('.mode-btn'),
    // Settings modal
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    llmUrlInput: document.getElementById('llmUrlInput'),
    refreshModelsBtn: document.getElementById('refreshModelsBtn'),
    llmModelSelect: document.getElementById('llmModelSelect'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn')
};

let isPowerOn = false;
let isMuted = false;

// UI Setup
els.modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        els.modeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        relay.publish('display_mode', { mode: btn.dataset.mode });
    });
});

let currentLlmMode = 'auto'; // auto | gemini_live | ultravox | local
if (els.modeToggleBtn) {
    els.modeToggleBtn.addEventListener('click', () => {
        if (currentLlmMode === 'auto') {
            currentLlmMode = 'gemini_live';
            els.modeToggleBtn.textContent = 'Mode: Gemini';
        } else if (currentLlmMode === 'gemini_live') {
            currentLlmMode = 'ultravox';
            els.modeToggleBtn.textContent = 'Mode: Ultravox';
        } else if (currentLlmMode === 'ultravox') {
            currentLlmMode = 'local';
            els.modeToggleBtn.textContent = 'Mode: Local';
        } else {
            currentLlmMode = 'auto';
            els.modeToggleBtn.textContent = 'Mode: Auto';
        }
        relay.publish('llm_mode', { mode: currentLlmMode });
    });
}

// Settings Modal Logic
if (els.settingsBtn) {
    els.settingsBtn.addEventListener('click', () => {
        els.settingsModal.style.display = 'flex';
    });
    
    els.closeSettingsBtn.addEventListener('click', () => {
        els.settingsModal.style.display = 'none';
    });
    
    els.refreshModelsBtn.addEventListener('click', async () => {
        const url = els.llmUrlInput.value.trim();
        els.refreshModelsBtn.textContent = '...';
        els.refreshModelsBtn.disabled = true;
        
        try {
            const resp = await fetch(`/api/local_models?url=${encodeURIComponent(url)}`);
            const data = await resp.json();
            
            els.llmModelSelect.innerHTML = '';
            if (data.data && Array.isArray(data.data)) {
                data.data.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.id;
                    els.llmModelSelect.appendChild(opt);
                });
            } else if (data.error) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = `Error: ${data.error}`;
                els.llmModelSelect.appendChild(opt);
            }
        } catch (e) {
            els.llmModelSelect.innerHTML = `<option value="">Failed to fetch models</option>`;
        }
        
        els.refreshModelsBtn.textContent = 'Refresh';
        els.refreshModelsBtn.disabled = false;
    });
    
    els.saveSettingsBtn.addEventListener('click', async () => {
        const url = els.llmUrlInput.value.trim();
        const model = els.llmModelSelect.value;
        
        if (url && model) {
            els.saveSettingsBtn.textContent = 'Saving...';
            try {
                await fetch('/api/config/llm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url + '/chat/completions', model: model })
                });
                // Switch to Local mode automatically if saved
                if (currentLlmMode !== 'local') {
                    currentLlmMode = 'local';
                    els.modeToggleBtn.textContent = 'Mode: Local';
                    relay.publish('llm_mode', { mode: currentLlmMode });
                }
            } catch (e) {
                console.error("Failed to save config", e);
            }
            els.saveSettingsBtn.textContent = 'Save & Apply';
            els.settingsModal.style.display = 'none';
        }
    });
}

let faceTranscriptVisible = false;
if (els.faceTranscriptBtn) {
    els.faceTranscriptBtn.addEventListener('click', () => {
        faceTranscriptVisible = !faceTranscriptVisible;
        els.faceTranscriptBtn.classList.toggle('active', faceTranscriptVisible);
        relay.publish('toggle_transcript', { show: faceTranscriptVisible });
    });
}

document.getElementById('testGestureBtn')?.addEventListener('click', () => {
    relay.publish('test_gesture', { gesture: 'hi' });
});

els.powerBtn.addEventListener('click', () => {
    isPowerOn = !isPowerOn;
    relay.publish('power', { on: isPowerOn });
});

els.muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    els.muteBtn.textContent = isMuted ? "Unmute Mic" : "Mute Mic";
    relay.publish('mute', { muted: isMuted });
});

els.textSend.addEventListener('click', () => {
    const text = els.textInput.value.trim();
    if (text) {
        relay.publish('text', { text });
        els.textInput.value = '';
    }
});
els.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.textSend.click();
});

// Relay events
relay.on('status', (payload) => {
    els.statusPill.dataset.state = payload.state;
    els.statusText.textContent = payload.state === 'online' ? 'Online' :
        payload.state === 'connecting' ? 'Connecting...' :
        payload.state === 'error' ? (payload.detail || 'Error') : 'Offline';
    
    isPowerOn = (payload.state === 'online' || payload.state === 'connecting');
    els.powerBtn.textContent = isPowerOn ? 'Power Off' : 'Power On';
    els.powerBtn.classList.toggle('danger', isPowerOn);
});

let userLine = null;
let botLine = null;

relay.on('transcript', (payload) => {
    if (payload.isNew || (payload.role === 'user' && !userLine) || (payload.role === 'bot' && !botLine)) {
        const div = document.createElement("div");
        div.className = `line ${payload.role}`;
        const b = document.createElement("b");
        b.textContent = `${payload.role === 'user' ? 'You' : 'Robot'}: `;
        div.appendChild(b);
        const span = document.createElement("span");
        div.appendChild(span);
        els.transcript.appendChild(div);
        
        if (payload.role === 'user') userLine = span;
        else botLine = span;
    }
    
    if (payload.role === 'user' && userLine) userLine.textContent = payload.text;
    if (payload.role === 'bot' && botLine) botLine.textContent = payload.text;
    
    els.transcript.scrollTop = els.transcript.scrollHeight;
});

relay.on('log', (payload) => {
    const div = document.createElement("div");
    div.className = "line";
    div.textContent = `${new Date().toLocaleTimeString([], { hour12: false })} · ${payload.text}`;
    
    const targetEl = payload.kind === 'task' ? els.taskList : els.actionLog;
    targetEl.appendChild(div);
    targetEl.scrollTop = targetEl.scrollHeight;
    while (targetEl.children.length > 300) targetEl.removeChild(targetEl.firstChild);
});

// Connect
relay.connect();

// WebRTC Video Receiver
const remoteVideo = document.getElementById('remoteVideo');
let rtcPeerConnection = null;

function requestStream() {
    relay.publish('webrtc_request', {});
}

relay.on('open', () => {
    requestStream();
});

relay.on('webrtc_offer', async (payload) => {
    if (!payload.offer) return;
    if (rtcPeerConnection) {
        rtcPeerConnection.close();
    }
    
    rtcPeerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    rtcPeerConnection.onicecandidate = (e) => {
        if (e.candidate) {
            relay.publish('webrtc_ice_control', { candidate: e.candidate });
        }
    };

    rtcPeerConnection.ontrack = (e) => {
        if (remoteVideo && e.streams && e.streams[0]) {
            remoteVideo.srcObject = e.streams[0];
        }
    };

    try {
        await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
        const answer = await rtcPeerConnection.createAnswer();
        await rtcPeerConnection.setLocalDescription(answer);
        relay.publish('webrtc_answer', { answer });
    } catch (e) {
        console.error('WebRTC offer handling error:', e);
    }
});

relay.on('webrtc_ice_face', async (payload) => {
    if (rtcPeerConnection && payload.candidate) {
        try {
            await rtcPeerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (e) {
            console.error('WebRTC ice error:', e);
        }
    }
});
