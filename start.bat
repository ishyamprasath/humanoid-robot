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
echo [2/2] Starting Python backend...
python main.py

pause
