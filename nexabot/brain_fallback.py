"""
NVIDIA Nemotron text fallback brain.

Used only when Gemini Live is unreachable. Talks to NVIDIA's OpenAI-
compatible chat endpoint over HTTPS. Strips the model's <think> chain-
of-thought before returning the visible reply.
"""

from __future__ import annotations

import re

import httpx

from config import NVIDIA_API_KEY, NVIDIA_MODEL, NVIDIA_URL, SYSTEM_PROMPT

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


class FallbackBrain:
    def __init__(self):
        self.messages = [
            {
                "role": "system",
                "content": (
                    SYSTEM_PROMPT
                    + "\n\n(NOTE: You are running in TEXT-ONLY fallback mode. "
                    "You have no live camera or microphone right now — say so naturally "
                    "if asked to look at or listen to something, and describe what "
                    "physical action you WOULD take.)"
                ),
            }
        ]

    async def reply(self, user_text: str) -> str:
        self.messages.append({"role": "user", "content": user_text})
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                NVIDIA_URL,
                headers={
                    "Authorization": f"Bearer {NVIDIA_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": NVIDIA_MODEL,
                    "messages": self.messages,
                    "temperature": 0.75,
                    "top_p": 0.95,
                    "max_tokens": 512,
                    "stream": False,
                },
            )
        r.raise_for_status()
        data = r.json()
        text = data["choices"][0]["message"]["content"]
        text = _THINK_RE.sub("", text).strip()
        self.messages.append({"role": "assistant", "content": text})
        return text
