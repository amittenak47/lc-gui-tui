@echo off
REM Hot-reload on USB device. First run generates src-tauri\gen\android if missing.
REM   android-dev.cmd
REM   android-dev.cmd <your-device-serial>
REM
REM Do NOT pass the serial as Tauri's DEVICE arg — Tauri matches DEVICE against
REM the device name ("Magic Note Pad"), not the USB serial. We only use the
REM serial to verify adb sees the tablet; Tauri then auto-picks the connected device.
setlocal
cd /d "%~dp0\.."

if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not defined ANDROID_SDK_ROOT set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
if not defined ANDROID_NDK_HOME (
  for /d %%D in ("%ANDROID_HOME%\ndk\*") do set "ANDROID_NDK_HOME=%%~fD"
)
set "PATH=%PATH%;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator"
REM Same Unix tools as android-install.cmd — libffi-sys needs cp/sh/make.
set "UNIX_ROOT=%~dp0..\..\.tmp-unix"
if exist "%ProgramFiles%\Git\usr\bin\sh.exe" (
  if not exist "%UNIX_ROOT%\git-usr" (
    mkdir "%UNIX_ROOT%" 2>nul
    mklink /J "%UNIX_ROOT%\git-usr" "%ProgramFiles%\Git\usr" >nul
  )
  set "PATH=%UNIX_ROOT%\git-usr\bin;%PATH%"
)
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links" set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
where make >nul 2>&1
if errorlevel 1 (
  echo android-dev: `make` not on PATH. Bundled libffi-sys needs it.
  echo Install: winget install -e --id ezwinports.make
  exit /b 1
)

set "SERIAL="
if "%~1"=="--" (
  if not "%~2"=="" set "SERIAL=%~2"
) else if not "%~1"=="" (
  set "SERIAL=%~1"
)

call node scripts\android-overlay.mjs
if errorlevel 1 exit /b 1

if defined SERIAL (
  adb -s %SERIAL% get-state >nul 2>&1
  if errorlevel 1 (
    echo Device %SERIAL% not connected. Run: adb devices
    exit /b 1
  )
  echo Using device: %SERIAL%
  set "ANDROID_SERIAL=%SERIAL%"
)

call npx tauri android dev
