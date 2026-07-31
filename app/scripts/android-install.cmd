@echo off
REM Build debug APK and install over USB (adb install -r). Optional serial after -- :
REM   android-install.cmd
REM   android-install.cmd -- <your-device-serial>
setlocal
cd /d "%~dp0\.."

set "SERIAL="
if "%~1"=="--" if not "%~2"=="" set "SERIAL=-s %~2"

call npm run android:apk
if errorlevel 1 exit /b 1

set "APK=src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"
if not exist "%APK%" (
  echo APK not found: %APK%
  echo Run npm run android:init once if gen\android is missing.
  exit /b 1
)

adb %SERIAL% install -r "%APK%"
