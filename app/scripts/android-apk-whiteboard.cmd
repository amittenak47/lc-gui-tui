@echo off
REM Whiteboard-only debug APK (no Practice, no RustPython). First run generates gen\android if missing.
REM Output: src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
cd /d "%~dp0\.."
call npm run android:apk:whiteboard
