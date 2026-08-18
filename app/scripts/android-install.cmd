@echo off
REM Renamed: this build is now called Practice. Forwards to
REM android-install-practice.cmd. Kept so existing shortcuts keep working;
REM it will be deleted once the new name is the one in everyone's history.
call "%~dp0android-install-practice.cmd" %*
