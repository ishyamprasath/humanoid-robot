// ============================================================
// FallbackChat — NVIDIA Nemotron text brain
// ============================================================

import { CONFIG, SYSTEM_PROMPT } from "./config.js";

export class FallbackChat {
  constructor({ onReply = () => {}, onError = () => {} }) {
    this.onReply = onReply;
    this.onError = onError;
    this.messages = [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          "\n\n(NOTE: You are currently running in TEXT-ONLY fallback mode on a backup reasoning core. You have no live camera or microphone right now — say so naturally if asked to look at or listen to something, and describe which physical action you WOULD take.)",
      },
    ];
    this.busy = false;
  }

  async send(userText) {
    if (this.busy) return;
    this.busy = true;
    this.messages.push({ role: "user", content: userText });
    try {
      const res = await fetch(CONFIG.NVIDIA_PROXY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: this.messages }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Fallback core error ${res.status}: ${detail.slice(0, 200)}`);
      }
      const data = await res.json();
      let reply = data?.choices?.[0]?.message?.content || "(no response)";
      reply = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      this.messages.push({ role: "assistant", content: reply });
      this.onReply(reply);
    } catch (e) {
      this.onError(e.message || String(e));
    } finally {
      this.busy = false;
    }
  }
}
