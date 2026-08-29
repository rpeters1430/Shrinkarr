@echo off
setlocal
cd /d "%~dp0"
title Shrinkarr Native Windows
echo Starting Shrinkarr on Windows...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" %*
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Shrinkarr exited with error code %ERRORLEVEL%.
    pause
)
