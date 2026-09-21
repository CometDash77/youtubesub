@echo off
REM youtubesub desktop overlay - one-click start.
REM Starts WS server + overlay on 127.0.0.1:9877 (port from setting.json).
REM Right-click the overlay for Settings / Mode / Font / Opacity / Quit.
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [youtubesub] python not found on PATH.
  echo [youtubesub] install Python 3.12, then run:  pip install -r requirements.txt
  pause
  exit /b 1
)

echo [youtubesub] starting desktop app...  ^(health: http://127.0.0.1:9877/health^)
python "%~dp0desktop\app.py"
if errorlevel 1 (
  echo [youtubesub] app exited with an error. Check that 127.0.0.1:9877 is free
  echo [youtubesub] and that dependencies are installed:  pip install -r requirements.txt
  pause
)
endlocal
