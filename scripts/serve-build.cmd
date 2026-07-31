@echo off
REM Build release lc binary (install separately — close running lc.exe first).
cd /d "%~dp0\.."
cargo build --release
