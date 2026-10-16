@echo off
powershell.exe -NoProfile -File "%~dp0bootstrap.ps1" -Action StopShortcut
if errorlevel 1 pause
