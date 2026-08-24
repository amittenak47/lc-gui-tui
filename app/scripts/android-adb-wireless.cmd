@echo off
REM Wireless adb: pair / connect / rebuild+install to the tablet.
REM Magic Note Pad is Android 14 — use Developer options → Wireless debugging.
cd /d "%~dp0\.."
node scripts\android-adb-wireless.mjs %*
