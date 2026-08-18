@echo off
REM Renamed: "pads-only" is now called Whiteboard-only. Forwards to
REM android-install-whiteboard.cmd. Kept so existing shortcuts keep working;
REM it will be deleted once the new name is the one in everyone's history.
call "%~dp0android-install-whiteboard.cmd" %*
