@echo off
REM Loopback-only daemon (desktop Tauri default: http://127.0.0.1:7878).
cd /d "%~dp0\.."
cargo run -- serve --port 7878 %*
