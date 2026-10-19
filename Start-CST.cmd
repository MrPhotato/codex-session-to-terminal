@echo off
setlocal
title Codex Session to Terminal
set "CST_ENTRY_ROOT=%~dp0"
rem Honor configured PowerShell policies; only resolve the Windows default in this process.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'); $policies=@(Get-ExecutionPolicy -List); if (@($policies | Where-Object { $_.ExecutionPolicy.ToString() -in @('Restricted','AllSigned') }).Count) { throw 'CST is blocked by a configured PowerShell execution policy. No policies were changed.' }; if ((Get-ExecutionPolicy).ToString() -eq 'Restricted' -and @($policies | Where-Object { $_.ExecutionPolicy.ToString() -ne 'Undefined' }).Count -eq 0) { Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force }; & (Join-Path $env:CST_ENTRY_ROOT 'Start-CST.ps1'); exit $LASTEXITCODE"
set "startExit=%ERRORLEVEL%"
if not "%startExit%"=="0" pause
exit /b %startExit%
