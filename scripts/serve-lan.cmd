@echo off
REM LAN whiteboard daemon — tablet pairing (Host / Port / 6-digit Code on banner).
REM Stop any running lc.exe first if cargo install reports "Access is denied".
cd /d "%~dp0\.."
cargo run --release -- serve --lan %*
