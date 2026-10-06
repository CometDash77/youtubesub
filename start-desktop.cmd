@echo off
REM youtubesub desktop overlay - one-click start.
REM Starts WS server + overlay on 127.0.0.1:9877 (port from setting.json).
REM Right-click the overlay for display mode / order / font size / background / click-through / quit.
REM "settings" and "debug" in that menu open the SAME non-modal window (settings / tuning / diagnostics pages).
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [youtubesub] python not found on PATH.
  echo [youtubesub] install Python 3.12, then run:  pip install -r requirements.txt
  pause
  exit /b 1
)

where pythonw >nul 2>nul
if errorlevel 1 (
  echo [youtubesub] pythonw not found on PATH. Reinstall Python with the windowed executable.
  pause
  exit /b 1
)

python -c "import PySide6, websockets" >nul 2>nul
if errorlevel 1 (
  echo [youtubesub] desktop dependencies are missing. Run: pip install -r requirements.txt
  pause
  exit /b 1
)

start "" pythonw "%~dp0desktop\app.py"
endlocal
