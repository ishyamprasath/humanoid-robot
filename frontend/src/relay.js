export class RelayClient {
    constructor() {
        this.socket = null;
        this.handlers = new Map();
        this.reconnectTimer = null;
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/relay`;
        this.socket = new WebSocket(wsUrl);

        this.socket.onopen = () => {
            console.log('[Relay] Connected');
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
        };

        this.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type && this.handlers.has(data.type)) {
                    this.handlers.get(data.type).forEach(cb => cb(data.payload));
                }
            } catch (e) {
                console.error('[Relay] Failed to parse message', e);
            }
        };

        this.socket.onclose = () => {
            console.log('[Relay] Disconnected. Reconnecting...');
            this.reconnectTimer = setTimeout(() => this.connect(), 2000);
        };
    }

    publish(type, payload) {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type, payload }));
        }
    }

    on(type, callback) {
        if (!this.handlers.has(type)) {
            this.handlers.set(type, []);
        }
        this.handlers.get(type).push(callback);
    }
}

export const relay = new RelayClient();
