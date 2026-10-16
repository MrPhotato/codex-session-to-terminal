@echo off
powershell.exe -NoProfile -File "%~dp0bootstrap.ps1" -Action Launch
if errorlevel 1 pause
