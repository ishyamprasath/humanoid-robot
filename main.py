import os
import sys
import uvicorn

def main():
    # Force UTF-8 on Windows command prompts to prevent print encoding errors
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    port = int(os.environ.get("PORT", 8080))
    print(f"🤖 Starting Robot Unified Application (main.py) on http://localhost:{port}...")
    uvicorn.run("frontend.main:app", host="0.0.0.0", port=port, reload=True)

if __name__ == "__main__":
    main()
