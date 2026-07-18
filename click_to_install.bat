@echo off
echo =========================================
echo 🤖 Robot System Installer
echo =========================================

IF EXIST ".venv\" GOTO SkipVenv
echo [1/3] Creating Python virtual environment (.venv)...
python -m venv .venv
GOTO ContinueVenv

:SkipVenv
echo [1/3] Virtual environment already exists. Skipping creation.

:ContinueVenv

echo [2/3] Activating virtual environment...
call .venv\Scripts\activate.bat

echo [3/3] Installing requirements from requirements.txt...
pip install -r requirements.txt

echo.
echo =========================================
echo ✅ Installation complete! 
echo You can now use start.bat to run the robot.
echo =========================================
pause
