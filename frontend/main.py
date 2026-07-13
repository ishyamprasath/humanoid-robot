import os
import json
import aiohttp
import sys
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Get the path to this file's folder (frontend folder)
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
# Logs can be stored in the root folder or frontend folder
CONV_DIR = os.path.join(ROOT_DIR, "conv-log")
TASK_DIR = os.path.join(ROOT_DIR, "task-log")
ACT_DIR = os.path.join(ROOT_DIR, "actions-log")

# Ensure directories exist
for d in [CONV_DIR, TASK_DIR, ACT_DIR]:
    os.makedirs(d, exist_ok=True)

# Process-global memory store for Gemini Live session history
LIVE_SESSION_MEMORIES = {}
# Process-global memory store for Gemma local completion history
GEMMA_SESSION_HISTORIES = {}

# Parse environment variables from both frontend/.env and root .env
ENV_VARS = {}

def load_env(env_path):
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    parts = line.split("=", 1)
                    if len(parts) == 2:
                        ENV_VARS[parts[0].strip()] = parts[1].strip()

# Load root .env first, then frontend .env (overwriting with frontend-specific config if present)
parent_dir = os.path.dirname(ROOT_DIR)
load_env(os.path.join(parent_dir, ".env"))
load_env(os.path.join(ROOT_DIR, ".env"))

# Determine mode: default to gemini_live if api key is present, otherwise gemma
ROBOT_MODE = ENV_VARS.get("ROBOT_MODE", "").lower()
if not ROBOT_MODE:
    if ENV_VARS.get("VITE_GEMINI_API_KEY") or ENV_VARS.get("GEMINI_API_KEY"):
        ROBOT_MODE = "gemini_live"
    else:
        ROBOT_MODE = "gemma"

print(f"[Robot] Unified Robot Backend starting up in '{ROBOT_MODE}' mode")

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

@app.get("/api/config")
async def get_config():
    model = ENV_VARS.get("VITE_GEMINI_MODEL") or ENV_VARS.get("GEMINI_MODEL", "")
    if not model or "3.5" in model or "1.5" in model:
        model = "gemini-3.1-flash-live-preview"
    
    return {
        "apiKey": ENV_VARS.get("VITE_GEMINI_API_KEY") or ENV_VARS.get("GEMINI_API_KEY", ""),
        "model": model,
        "voice": ENV_VARS.get("VITE_VOICE_NAME") or ENV_VARS.get("VOICE_NAME", "Aoede")
    }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = websocket.query_params.get("sessionId", "default")
    
    if ROBOT_MODE == "gemini_live":
        print(f"[WS] Client connected (Gemini Live mode, Session: {session_id})")
        
        model = ENV_VARS.get("VITE_GEMINI_MODEL") or ENV_VARS.get("GEMINI_MODEL", "")
        if not model or "3.5" in model or "1.5" in model:
            model = "gemini-3.1-flash-live-preview"
            
        await websocket.send_json({
            "type": "init",
            "mode": "gemini_live",
            "apiKey": ENV_VARS.get("VITE_GEMINI_API_KEY") or ENV_VARS.get("GEMINI_API_KEY", ""),
            "model": model,
            "voice": ENV_VARS.get("VITE_VOICE_NAME") or ENV_VARS.get("VOICE_NAME", "Aoede")
        })
        
        try:
            while True:
                data = await websocket.receive_text()
        except Exception as e:
            print(f"[WS] WebSocket disconnected (Gemini Live): {e}")

    else:
        print(f"[WS] Client connected (Local Gemma mode, Session: {session_id})")
        
        if session_id not in GEMMA_SESSION_HISTORIES:
            GEMMA_SESSION_HISTORIES[session_id] = []
            print(f"[WS] Initialized new local Gemma session memory: {session_id}")
        else:
            print(f"[WS] Loaded existing local Gemma session memory: {session_id} ({len(GEMMA_SESSION_HISTORIES[session_id])} turns)")
            
        history = GEMMA_SESSION_HISTORIES[session_id]
        
        await websocket.send_json({
            "type": "init",
            "mode": "gemma"
        })
        
        try:
            while True:
                data = await websocket.receive_json()
                if data.get("type") == "text":
                    user_text = data["text"]
                    
                    history.append({"role": "user", "content": user_text})
                    if len(history) > 10:
                        del history[0:len(history)-10]
                    
                    print("[WS] Routing message to local Gemma 4 endpoint")
                    url = ENV_VARS.get("LOCAL_LLM_URL", "http://localhost:8085/v1/chat/completions")
                    headers = {}
                    payload = {
                        "model": ENV_VARS.get("LOCAL_LLM_MODEL", "gemma-4-e4b"),
                        "messages": [
                            {"role": "system", "content": SYSTEM_PROMPT}
                        ] + history,
                        "temperature": 0.8,
                        "max_tokens": 10000,
                        "response_format": {"type": "json_object"}
                    }
                    
                    async with aiohttp.ClientSession() as http_session:
                        async with http_session.post(url, headers=headers, json=payload) as resp:
                            if resp.status != 200:
                                err_text = await resp.text()
                                raise Exception(f"Local LLM API status {resp.status}: {err_text}")
                            result = await resp.json()
                            
                            assistant_content = result["choices"][0]["message"]["content"]
                            assistant_content = clean_json_text(assistant_content)
                            content = json.loads(assistant_content, strict=False)
                    
                    history.append({"role": "assistant", "content": assistant_content})
                    if len(history) > 10:
                        del history[0:len(history)-10]
                    
                    await websocket.send_json({
                        "type": "response",
                        "emotion": content.get("emotion", "neutral"),
                        "emotion_intensity": content.get("emotion_intensity", 0.5),
                        "speech_text": content.get("speech_text", ""),
                        "face_expression": content.get("face_expression", {}),
                        "prosody": content.get("prosody", {})
                    })
        except Exception as e:
            print(f"[WS] Local Gemma Error: {e}")
            try:
                await websocket.send_json({
                    "type": "response",
                    "emotion": "sad",
                    "speech_text": f"Gemma Mode Error: {str(e)}"
                })
            except:
                pass

@app.post("/api/log/conversation")
async def log_conversation(request: Request):
    try:
        data = await request.json()
        session_id = str(data.get("sessionId", "unknown"))
        timestamp = data.get("timestamp")
        content = data.get("content", {})
        
        date_str = datetime.fromtimestamp(timestamp / 1000.0).strftime('%H:%M:%S') if timestamp else datetime.now().strftime('%H:%M:%S')
        
        log_path = os.path.join(CONV_DIR, f"session-{session_id}.txt")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{date_str}] {content.get('role', 'unknown').upper()}: {content.get('text', '')}\n")
            
        # Append to process-global session memory
        role = content.get("role", "")
        text = content.get("text", "")
        if role and text and session_id != "unknown":
            model_role = "model" if role == "robot" else role
            if session_id not in LIVE_SESSION_MEMORIES:
                LIVE_SESSION_MEMORIES[session_id] = []
            LIVE_SESSION_MEMORIES[session_id].append({
                "role": model_role,
                "parts": [{"text": text}]
            })
            if len(LIVE_SESSION_MEMORIES[session_id]) > 10:
                del LIVE_SESSION_MEMORIES[session_id][0:len(LIVE_SESSION_MEMORIES[session_id]) - 10]
                
        return {"status": "ok"}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

@app.get("/api/memory")
async def get_memory(sessionId: str = None):
    if not sessionId or sessionId not in LIVE_SESSION_MEMORIES:
        return {"turns": []}
    return {"turns": LIVE_SESSION_MEMORIES[sessionId]}

@app.post("/api/log/task")
async def log_task(request: Request):
    try:
        data = await request.json()
        session_id = str(data.get("sessionId", "unknown"))
        timestamp = data.get("timestamp")
        content = data.get("content", {})
        
        date_str = datetime.fromtimestamp(timestamp / 1000.0).strftime('%H:%M:%S') if timestamp else datetime.now().strftime('%H:%M:%S')
        
        log_path = os.path.join(TASK_DIR, f"session-{session_id}.txt")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{date_str}] [{content.get('event', 'unknown').upper()}] {content.get('message', '')}\n")
        return {"status": "ok"}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

@app.post("/api/log/action")
async def log_action(request: Request):
    try:
        data = await request.json()
        session_id = str(data.get("sessionId", "unknown"))
        timestamp = data.get("timestamp")
        content = data.get("content", {})
        
        date_str = datetime.fromtimestamp(timestamp / 1000.0).strftime('%H:%M:%S') if timestamp else datetime.now().strftime('%H:%M:%S')
        
        log_path = os.path.join(ACT_DIR, f"session-{session_id}.txt")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{date_str}] [{content.get('type', 'unknown').upper()}] {content.get('message', '')}\n")
        return {"status": "ok"}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

# Serving static assets
DIST_DIR = os.path.join(ROOT_DIR, "dist")
if os.path.exists(DIST_DIR) and os.path.exists(os.path.join(DIST_DIR, "index.html")):
    print("[Server] Serving frontend from built 'dist/' directory")
    @app.get("/", response_class=HTMLResponse)
    async def serve_index():
        with open(os.path.join(DIST_DIR, "index.html"), "r", encoding="utf-8") as f:
            return f.read()
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST_DIR, "assets")), name="assets")
else:
    print("[Server] 'dist/' directory not found. Serving directly from source files (development fallback)")
    @app.get("/", response_class=HTMLResponse)
    async def serve_index():
        index_path = os.path.join(ROOT_DIR, "index.html")
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                return f.read()
        return "index.html not found!"
        
    app.mount("/src", StaticFiles(directory=os.path.join(ROOT_DIR, "src")), name="src")
    app.mount("/css", StaticFiles(directory=os.path.join(ROOT_DIR, "css")), name="css")
    app.mount("/public", StaticFiles(directory=os.path.join(ROOT_DIR, "public")), name="public")

if __name__ == "__main__":
    import uvicorn
    # Use environment port or default to 8080
    port = int(ENV_VARS.get("PORT") or os.environ.get("PORT") or 8080)
    print(f"[Server] Starting server on http://localhost:{port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
