@echo off
REM Pads-only debug APK + adb install -r. From repo root or app\:
REM   app\scripts\android-install-pads.cmd
REM   app\scripts\android-install-pads.cmd <your-device-serial>
REM First run generates src-tauri\gen\android (not in git) if missing.
setlocal
cd /d "%~dp0\.."

if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not defined ANDROID_SDK_ROOT set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
set "PATH=%PATH%;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator"

set "SERIAL="
if "%~1"=="--" (
  if not "%~2"=="" set "SERIAL=%~2"
) else if not "%~1"=="" (
  set "SERIAL=%~1"
)

call npm run android:apk:pads
if errorlevel 1 exit /b 1

set "APK=src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"
if not exist "%APK%" (
  echo APK not found: %APK%
  echo Build failed, or gen\android was not generated. From app/: npm run android:init
  echo Needs Android SDK, NDK, and JDK 17+.
  exit /b 1
)

if defined SERIAL (
  adb -s %SERIAL% install -r "%APK%"
) else (
  adb install -r "%APK%"
)
