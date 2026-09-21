@echo off
rem Process-scoped -ExecutionPolicy Bypass: the machine/user execution policy is NOT changed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-dsh.ps1" %*
exit /b %ERRORLEVEL%
