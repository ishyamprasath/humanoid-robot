// ============================================================
// GeminiLiveClient — bidirectional WebSocket to Gemini Live API.
// Streams mic PCM + camera JPEG up, receives voice + tool calls
// + transcripts down.
// ============================================================

export class GeminiLiveClient {
  constructor({ config, tools, systemPrompt }) {
    this.config = config;
    this.tools = tools;
    this.systemPrompt = systemPrompt;
    this.ws = null;
    this.ready = false;

    this.onAudio = () => {};
    this.onToolCall = () => {};
    this.onInterrupted = () => {};
    this.onTurnComplete = () => {};
    this.onInputTranscript = () => {};
    this.onOutputTranscript = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
    this.onError = () => {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.GEMINI_WS_URL_TEMPLATE.replace("{ver}", this.config.GEMINI_API_VERSION);
      const url = `${wsUrl}?key=${encodeURIComponent(this.config.GEMINI_API_KEY)}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this._send({
          setup: {
            model: this.config.GEMINI_MODEL,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: this.config.VOICE_NAME },
                },
              },
            },
            systemInstruction: { parts: [{ text: this.systemPrompt }] },
            tools: [{ functionDeclarations: this.tools }],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        });
      };

      this.ws.onmessage = async (evt) => {
        let raw = evt.data;
        if (raw instanceof Blob) raw = await raw.text();
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.setupComplete) {
          this.ready = true;
          this.onOpen();
          resolve();
          return;
        }
        if (msg.toolCall?.functionCalls?.length) {
          this.onToolCall(msg.toolCall.functionCalls);
        }
        const sc = msg.serverContent;
        if (sc) {
          if (sc.interrupted) this.onInterrupted();
          if (sc.inputTranscription?.text) this.onInputTranscript(sc.inputTranscription.text);
          if (sc.outputTranscription?.text) this.onOutputTranscript(sc.outputTranscription.text);
          const parts = sc.modelTurn?.parts || [];
          for (const p of parts) {
            if (p.inlineData?.data) this.onAudio(p.inlineData.data);
          }
          if (sc.turnComplete) this.onTurnComplete();
        }
      };

      this.ws.onerror = (e) => {
        this.onError(e);
        if (!this.ready) reject(new Error("Gemini Live WebSocket failed to connect."));
      };
      this.ws.onclose = (e) => {
        this.ready = false;
        this.onClose(e.code, e.reason);
        if (!this.ready) reject(new Error(`Connection closed (${e.code}) ${e.reason || ""}`));
      };
    });
  }

  sendAudioChunk(base64Pcm16k) {
    this._send({
      realtimeInput: {
        audio: { mimeType: `audio/pcm;rate=${this.config.SEND_SAMPLE_RATE}`, data: base64Pcm16k },
      },
    });
  }

  sendVideoFrame(base64Jpeg) {
    this._send({
      realtimeInput: { video: { mimeType: "image/jpeg", data: base64Jpeg } },
    });
  }

  sendText(text) {
    this._send({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  sendToolResponse(functionCalls, results) {
    this._send({
      toolResponse: {
        functionResponses: functionCalls.map((fc, i) => ({
          id: fc.id,
          name: fc.name,
          response: { result: results[i] },
        })),
      },
    });
  }

  disconnect() {
    this.ready = false;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close(1000, "client shutdown");
    this.ws = null;
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }
}
