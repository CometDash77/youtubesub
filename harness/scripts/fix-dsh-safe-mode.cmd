@echo off
rem Process-level execution-policy bypass; does not change machine or user policy.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-dsh-safe-mode.ps1" %*
