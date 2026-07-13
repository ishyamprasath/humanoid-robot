import os
import json
from datetime import datetime
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

# Get the path to this file's folder
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
CONV_DIR = os.path.join(ROOT_DIR, "conv-log")
TASK_DIR = os.path.join(ROOT_DIR, "task-log")
ACT_DIR = os.path.join(ROOT_DIR, "actions-log")

# Ensure directories exist
for d in [CONV_DIR, TASK_DIR, ACT_DIR]:
    os.makedirs(d, exist_ok=True)

# Process-global memory store for Gemini Live session history
LIVE_SESSION_MEMORIES = {}

# Parse .env to get the Gemini Live credentials
ENV_VARS = {}
env_path = os.path.join(ROOT_DIR, ".env")
if os.path.exists(env_path):
    with open(env_path, "r") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                parts = line.split("=", 1)
                if len(parts) == 2:
                    ENV_VARS[parts[0].strip()] = parts[1].strip()

@app.get("/api/config")
async def get_config():
    model = ENV_VARS.get("VITE_GEMINI_MODEL", "")
    if not model or "3.5" in model or "1.5" in model:
        model = "gemini-3.1-flash-live-preview"
    return {
        "apiKey": ENV_VARS.get("VITE_GEMINI_API_KEY", ""),
        "model": model,
        "voice": ENV_VARS.get("VITE_VOICE_NAME", "Aoede")
    }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("✅ Client connected to WebSocket (Gemini Live)")
    
    # If the user has gemini-3.5-flash in .env, fall back to gemini-3.1-flash-live-preview for Live WebRTC
    model = ENV_VARS.get("VITE_GEMINI_MODEL", "")
    if not model or "3.5" in model or "1.5" in model:
        model = "gemini-3.1-flash-live-preview"
        
    # Send init message to frontend telling it to use Gemini Multimodal Live mode
    await websocket.send_json({
        "type": "init",
        "mode": "gemini_live",
        "apiKey": ENV_VARS.get("VITE_GEMINI_API_KEY", ""),
        "model": model,
        "voice": ENV_VARS.get("VITE_VOICE_NAME", "Aoede")
    })
    
    try:
        while True:
            data = await websocket.receive_text()
    except Exception as e:
        print(f"🔌 WebSocket disconnected: {e}")

@app.post("/api/log/conversation")
async def log_conversation(request: Request):
    try:
        data = await request.json()
        session_id = str(data.get("sessionId", "unknown"))
        timestamp = data.get("timestamp")
        content = data.get("content", {})
        
        date_str = datetime.fromtimestamp(timestamp / 1000.0).strftime('%H:%M:%S') if timestamp else datetime.now().strftime('%H:%M:%S')
        
        log_path = os.path.join(CONV_DIR, f"session-{session_id}.txt")
        with open(log_path, "a") as f:
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
            # Limit to last 10 turns (5 user prompts and 5 assistant responses)
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
        with open(log_path, "a") as f:
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
        with open(log_path, "a") as f:
            f.write(f"[{date_str}] [{content.get('type', 'unknown').upper()}] {content.get('message', '')}\n")
        return {"status": "ok"}
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

DIST_DIR = os.path.join(ROOT_DIR, "dist")
if os.path.exists(DIST_DIR) and os.path.exists(os.path.join(DIST_DIR, "index.html")):
    print("🚀 Serving college demo from built 'dist/' directory")
    @app.get("/", response_class=HTMLResponse)
    async def serve_index():
        with open(os.path.join(DIST_DIR, "index.html"), "r") as f:
            return f.read()
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST_DIR, "assets")), name="assets")
else:
    print("⚠️ 'dist/' directory not found. Serving directly from source files (development fallback)")
    @app.get("/", response_class=HTMLResponse)
    async def serve_index():
        index_path = os.path.join(ROOT_DIR, "index.html")
        if os.path.exists(index_path):
            with open(index_path, "r") as f:
                return f.read()
        return "index.html not found!"
    app.mount("/src", StaticFiles(directory=os.path.join(ROOT_DIR, "src")), name="src")
    app.mount("/css", StaticFiles(directory=os.path.join(ROOT_DIR, "css")), name="css")
