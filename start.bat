@echo off
echo =========================================
echo 🤖 Robot System Startup
echo =========================================

echo [1/2] Building frontend...
cd frontend
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo ❌ Frontend build failed!
    pause
    exit /b %errorlevel%
)
cd ..

echo.
echo [2/2] Starting Python backend and launching Edge...

:: Wait 3 seconds for server to boot, then open Edge side-by-side
start "" cmd /c "timeout /t 3 /nobreak >nul & start msedge --new-window --window-position=0,0 --window-size=960,1080 http://localhost:8000/face & start msedge --new-window --window-position=960,0 --window-size=960,1080 http://localhost:8000/control"

IF EXIST ".venv\Scripts\python.exe" GOTO RunVenv
GOTO RunGlobal

:RunVenv
cd frontend
..\.venv\Scripts\python.exe main.py
cd ..
GOTO End

:RunGlobal
echo [WARNING] Virtual environment not found! Please run click_to_install.bat first.
cd frontend
python main.py
cd ..
GOTO End

:End
pause
