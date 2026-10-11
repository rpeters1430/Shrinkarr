@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Shrinkarr Native Windows

:: Normalize common convenience flags for PowerShell
set "ARGS="
:arg_loop
if "%~1"=="" goto run
set "ARG=%~1"
if /i "%ARG%"=="update"        set "ARG=-Update"
if /i "%ARG%"=="--update"      set "ARG=-Update"
if /i "%ARG%"=="pull"          set "ARG=-Update"
if /i "%ARG%"=="--pull"        set "ARG=-Update"
if /i "%ARG%"=="build"         set "ARG=-Build"
if /i "%ARG%"=="--build"       set "ARG=-Build"
if /i "%ARG%"=="rebuild"       set "ARG=-Build"
if /i "%ARG%"=="--rebuild"     set "ARG=-Build"
if /i "%ARG%"=="install"       set "ARG=-Install"
if /i "%ARG%"=="--install"     set "ARG=-Install"
if /i "%ARG%"=="doctor"        set "ARG=-Doctor"
if /i "%ARG%"=="--doctor"      set "ARG=-Doctor"
if /i "%ARG%"=="bench"         set "ARG=-Benchmark"
if /i "%ARG%"=="--bench"       set "ARG=-Benchmark"
if /i "%ARG%"=="benchmark"     set "ARG=-Benchmark"
if /i "%ARG%"=="--benchmark"   set "ARG=-Benchmark"
if /i "%ARG%"=="hardware"      set "ARG=-CheckHardware"
if /i "%ARG%"=="--hardware"    set "ARG=-CheckHardware"
if /i "%ARG%"=="checkhardware" set "ARG=-CheckHardware"
if /i "%ARG%"=="--checkhardware" set "ARG=-CheckHardware"
if /i "%ARG%"=="scan"          set "ARG=-Scan"
if /i "%ARG%"=="--scan"        set "ARG=-Scan"
if /i "%ARG%"=="daemon"        set "ARG=-Daemon"
if /i "%ARG%"=="--daemon"      set "ARG=-Daemon"
set "ARGS=!ARGS! %ARG%"
shift
goto arg_loop

:run
echo Starting Shrinkarr on Windows...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" %ARGS%
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Shrinkarr exited with error code %ERRORLEVEL%.
    pause
)
