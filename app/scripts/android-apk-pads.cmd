@echo off
REM Renamed: "pads-only" is now called Whiteboard-only. Forwards to
REM android-apk-whiteboard.cmd. Kept so existing shortcuts keep working.
call "%~dp0android-apk-whiteboard.cmd" %*
