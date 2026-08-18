@echo off
REM Practice debug APK (the default build). First run generates src-tauri\gen\android if missing.
REM Output: src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
cd /d "%~dp0\.."
call npm run android:apk:practice
