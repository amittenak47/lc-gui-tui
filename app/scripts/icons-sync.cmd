@echo off
REM Regenerate Tauri/desktop/Android icons from docs/icons/tauri.manifest.json
cd /d "%~dp0\.."
call npm run icons:sync
