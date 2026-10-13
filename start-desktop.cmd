@echo off
REM youtubesub desktop overlay - one-click start (Electron/TypeScript stack, #207).
REM Starts WS server + overlay on 127.0.0.1:9877 (port from setting.json).
REM Right-click the overlay for display mode / order / font size / background / click-through / quit.
REM "settings" in that menu opens the SAME non-modal window (settings / tuning / diagnostics pages); single entry since #209.
setlocal
cd /d "%~dp0"

REM Agent/IDE terminals often carry ELECTRON_RUN_AS_NODE=1 (their host is an
REM Electron app); it turns electron.exe into a plain Node and the app dies
REM with "no export named BrowserWindow". Same neutralization as the E2E harness.
set "ELECTRON_RUN_AS_NODE="

where node >nul 2>nul
if errorlevel 1 (
  echo [youtubesub] node not found on PATH. Install Node.js 22 LTS or newer, then re-run.
  pause
  exit /b 1
)

if not exist "app\node_modules\electron\dist\electron.exe" (
  echo [youtubesub] first run: installing app dependencies...
  cd /d "%~dp0app"
  call npm install
  if errorlevel 1 goto :install_failed
  if not exist "node_modules\electron\dist\electron.exe" (
    echo [youtubesub] electron binary missing, running its installer...
    call node node_modules\electron\install.js
    if errorlevel 1 goto :install_failed
  )
  cd /d "%~dp0"
)

if not exist "app\dist\main\main.js" (
  echo [youtubesub] building the app...
  cd /d "%~dp0app"
  call npm run build
  if errorlevel 1 goto :build_failed
  cd /d "%~dp0"
)

start "youtubesub" /d "%~dp0app" "node_modules\electron\dist\electron.exe" .
exit /b 0

:install_failed
cd /d "%~dp0"
echo [youtubesub] dependency install failed. See output above.
pause
exit /b 1

:build_failed
cd /d "%~dp0"
echo [youtubesub] build failed. See output above.
pause
exit /b 1
