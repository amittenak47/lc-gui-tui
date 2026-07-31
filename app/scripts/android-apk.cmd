@echo off
REM Debug APK (universal). Output: src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
cd /d "%~dp0\.."
call npm run android:apk
