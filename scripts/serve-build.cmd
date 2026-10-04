@echo off
REM Build release lc maintenance binary (install separately — close running lc.exe first).
cd /d "%~dp0\.."
cargo build --release
