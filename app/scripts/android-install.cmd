@echo off
REM Build debug APK and adb install -r. Optional serial:
REM   android-install.cmd
REM   android-install.cmd <your-device-serial>
REM   android-install.cmd -- <your-device-serial>
setlocal
cd /d "%~dp0\.."

set "SERIAL="
if "%~1"=="--" (
  if not "%~2"=="" set "SERIAL=%~2"
) else if not "%~1"=="" (
  set "SERIAL=%~1"
)

call npm run android:apk
if errorlevel 1 exit /b 1

set "APK=src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"
if not exist "%APK%" (
  echo APK not found: %APK%
  echo Run npm run android:init once if gen\android is missing.
  exit /b 1
)

if defined SERIAL (
  adb -s %SERIAL% install -r "%APK%"
) else (
  adb install -r "%APK%"
)
