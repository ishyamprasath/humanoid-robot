import json
import os
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
import aiohttp

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SYSTEM_PROMPT = """You are a friendly robot companion with an LED dot-matrix face.

Your emotions: curiosity, happiness, sadness, surprise, fear, anger, neutral.

For EVERY response, output ONLY valid JSON:
{
  "emotion": "happy",
  "emotion_intensity": 0.8,
  "speech_text": "Your spoken response here",
  "face_expression": {
    "eye_shape": "round|narrow|wide|half_closed|upturned|downturned",
    "eyebrow_shape": "flat|raised|furrowed|one_raised|drooped",
    "mouth_shape": "smile|frown|open|o_shape|flat|tight",
    "mouth_open": 0.0,
    "eye_blink": false,
    "head_tilt": 0.0,
    "color": "#00FFFF"
  },
  "prosody": {
    "pitch": 0.7,
    "speed": 1.1,
    "volume": 0.85
  }
}
"""

def clean_json_text(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        idx = text.find("\n")
        if idx != -1:
            text = text[idx:].strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    return text

# Process-global session memories (cleared when uvicorn process restarts)
SESSION_HISTORIES = {}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("✅ Client connected to WebSocket")
    
    # Parse sessionId from query parameters
    session_id = websocket.query_params.get("sessionId", "default")
    if session_id not in SESSION_HISTORIES:
        SESSION_HISTORIES[session_id] = []
        print(f"🆕 Initialized new session memory: {session_id}")
    else:
        print(f"🔄 Loaded existing session memory: {session_id} ({len(SESSION_HISTORIES[session_id])} turns)")
        
    history = SESSION_HISTORIES[session_id]
    
    # Send init message to frontend telling it to use Gemma 4 mode
    await websocket.send_json({
        "type": "init",
        "mode": "gemma"
    })
    
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "text":
                user_text = data["text"]
                
                # Append user prompt to history
                history.append({"role": "user", "content": user_text})
                
                # Limit sliding history to last 10 turns (5 user, 5 assistant messages) in-place
                if len(history) > 10:
                    del history[0:len(history)-10]
                
                print("🧠 Routing to local Gemma 4")
                url = "http://localhost:8085/v1/chat/completions"
                headers = {}
                payload = {
                    "model": "gemma-4-e4b",
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT}
                    ] + history,
                    "temperature": 0.8,
                    "max_tokens": 10000,
                    "response_format": {"type": "json_object"}
                }
                
                async with aiohttp.ClientSession() as session:
                    async with session.post(url, headers=headers, json=payload) as resp:
                        if resp.status != 200:
                            err_text = await resp.text()
                            raise Exception(f"LLM API status {resp.status}: {err_text}")
                        result = await resp.json()
                        
                        # Retrieve assistant output from OpenAI-compatible response payload
                        assistant_content = result["choices"][0]["message"]["content"]
                        assistant_content = clean_json_text(assistant_content)
                        content = json.loads(assistant_content, strict=False)
                
                # Append assistant response JSON block to history in-place so emotions stay consistent
                history.append({"role": "assistant", "content": assistant_content})
                if len(history) > 10:
                    del history[0:len(history)-10]
                
                # Send JSON response to browser UI
                await websocket.send_json({
                    "type": "response",
                    "emotion": content["emotion"],
                    "emotion_intensity": content["emotion_intensity"],
                    "speech_text": content["speech_text"],
                    "face_expression": content["face_expression"],
                    "prosody": content.get("prosody", {})
                })
    except Exception as e:
        print(f"❌ Error: {e}")
        try:
            await websocket.send_json({
                "type": "response",
                "emotion": "sad",
                "speech_text": f"Error: {str(e)}"
            })
        except:
            pass
