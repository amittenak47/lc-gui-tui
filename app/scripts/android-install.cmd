@echo off
REM Windows: build debug APK and adb install -r. From repo root or app\:
REM   app\scripts\android-install.cmd
REM   app\scripts\android-install.cmd <your-device-serial>
REM First run generates src-tauri\gen\android (not in git) if missing.
REM Linux: app/scripts/android-install.sh — do not run this .cmd there.
setlocal
cd /d "%~dp0\.."

if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not defined ANDROID_SDK_ROOT set "ANDROID_SDK_ROOT=%ANDROID_HOME%"
if not defined ANDROID_NDK_HOME (
  for /d %%D in ("%ANDROID_HOME%\ndk\*") do set "ANDROID_NDK_HOME=%%~fD"
)
set "PATH=%PATH%;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator"
REM libffi-sys bundled build needs Unix cp/sh/make (RustPython ctypes).
REM Git lives under "Program Files"; libtool bakes that path into the
REM Makefile and sh splits on the space. Junction has no spaces.
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
  echo android-install: `make` not on PATH. Bundled libffi-sys needs it.
  echo Install: winget install -e --id ezwinports.make
  echo Then open a new shell and retry.
  exit /b 1
)

set "SERIAL="
if "%~1"=="--" (
  if not "%~2"=="" set "SERIAL=%~2"
) else if not "%~1"=="" (
  set "SERIAL=%~1"
)

REM Practice APK is aarch64 only (rustpython 0.5 does not compile for 32-bit Android).
call npm run android:apk
if errorlevel 1 exit /b 1

set "APK=src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"
if not exist "%APK%" set "APK=src-tauri\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk"
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
