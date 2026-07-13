import { relay } from './relay.js';

const els = {
    statusPill: document.getElementById('statusPill'),
    statusText: document.getElementById('statusText'),
    powerBtn: document.getElementById('powerBtn'),
    muteBtn: document.getElementById('muteBtn'),
    transcript: document.getElementById('transcript'),
    actionLog: document.getElementById('actionLog'),
    taskList: document.getElementById('taskList'),
    textInput: document.getElementById('textInput'),
    textSend: document.getElementById('textSend'),
    modeBtns: document.querySelectorAll('.mode-btn')
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

relay.on('transcript', (payload) => {
    const div = document.createElement("div");
    div.className = `line ${payload.role}`;
    const b = document.createElement("b");
    b.textContent = `${payload.role === 'user' ? 'You' : 'Robot'}: `;
    div.appendChild(b);
    const span = document.createElement("span");
    span.textContent = payload.text;
    div.appendChild(span);
    els.transcript.appendChild(div);
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
