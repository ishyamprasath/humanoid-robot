@echo off
echo Activating conda environment 'robo-project'...
call C:\Dev\Runtimes\Miniconda3\Scripts\activate.bat robo-project

echo Checking if dependencies are installed...
python -c "import numpy" 2>nul
if %errorlevel% neq 0 (
    echo.
    echo Missing dependencies detected. Installing requirements automatically...
    pip install -r requirements.txt
    echo.
)

echo Starting Humanoid Robot backend...
cd backend

:: Launch the browser automatically after a short delay (gives the python server time to spin up)
start /B cmd /C "timeout /t 3 >nul & start http://localhost:8000"

:: Start the python server
python main.py

echo.
pause
