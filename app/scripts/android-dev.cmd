@echo off
REM Hot-reload dev on device/USB. Optional device serial after -- :
REM   android-dev.cmd
REM   android-dev.cmd -- <your-device-serial>
setlocal
cd /d "%~dp0\.."

if "%~1"=="--" if not "%~2"=="" (
  call npm run android:dev -- %2
) else (
  call npm run android:dev
)
