#requires -Version 7.4
param([Parameter(Mandatory)][string]$InstallerPath)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true') { throw 'This install/uninstall smoke test runs only on a disposable GitHub runner.' }
$app = Join-Path $env:LOCALAPPDATA 'Programs\Codex Session to Terminal'
$privateRoot = Join-Path $env:LOCALAPPDATA 'SessionBridge'
if ((Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $privateRoot)) { throw 'Smoke test requires a clean runner profile.' }
$logs = Join-Path (Split-Path $PSScriptRoot -Parent) '.build\smoke'
[void](New-Item -ItemType Directory -Path $logs -Force)
function Invoke-InstallerProcess([string]$Path, [string]$LogName, [string[]]$ExtraArguments = @()) {
    $arguments = @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',('/LOG="' + (Join-Path $logs $LogName) + '"')) + $ExtraArguments
    $process = Start-Process -FilePath $Path -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    return $process.ExitCode
}
if ((Invoke-InstallerProcess $InstallerPath 'install.log' @('/TASKS="desktopicon"')) -ne 0) { throw 'Silent installation failed.' }
foreach ($relative in @('Start.cmd','Dependencies.ps1','runtime\node\node.exe','runtime\powershell\pwsh.exe','runtime\node\LICENSE','runtime\powershell\LICENSE.txt','runtime\powershell\ThirdPartyNotices.txt','licenses\INNO-SETUP-LICENSE.txt','unins000.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $app $relative) -PathType Leaf)) { throw "Installed file is missing: $relative" }
}
if ((Test-Path -LiteralPath (Join-Path $app 'node_modules')) -or (Test-Path -LiteralPath $privateRoot)) { throw 'Installation unexpectedly initialized dependencies or private state.' }
$shell = New-Object -ComObject WScript.Shell
$links = @(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Session to Terminal\Codex Session to Terminal.lnk')
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Session to Terminal.lnk')
)
foreach ($link in $links) {
    if (!(Test-Path -LiteralPath $link)) { throw "Shortcut missing: $link" }
    $shortcut = $shell.CreateShortcut($link)
    if ($shortcut.TargetPath -ine (Join-Path $app 'Start.cmd')) { throw 'Shortcut does not target the installed entry point.' }
}
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{47CC0037-E859-49AB-A98E-D5251553C264}_is1'
if (!(Test-Path -LiteralPath $registryPath)) { throw 'Current-user uninstall registration missing.' }
if ((Get-ItemProperty -LiteralPath $registryPath).DisplayName -cne 'Codex Session to Terminal') { throw 'Wrong installed product name.' }

# A machine without Desktop must fail before changing connection state or downloading dependencies.
if (Get-AppxPackage -Name OpenAI.Codex) { throw 'Smoke runner must not have a real Desktop account/application.' }
$startInfo = [Diagnostics.ProcessStartInfo]::new((Join-Path $env:WINDIR 'System32\cmd.exe'))
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.Arguments = '/d /s /c ""' + (Join-Path $app 'Start.cmd') + '""'
[void]$startInfo.Environment.Remove('PSExecutionPolicyPreference')
$startProcess = [Diagnostics.Process]::Start($startInfo)
try {
    $startProcess.StandardInput.Close()
    $outTask = $startProcess.StandardOutput.ReadToEndAsync()
    $errTask = $startProcess.StandardError.ReadToEndAsync()
    if (!$startProcess.WaitForExit(60000)) { $startProcess.Kill($true); throw 'Installed Start entry did not return.' }
    $startLog = $outTask.Result + $errTask.Result
    $startLog | Set-Content -LiteralPath (Join-Path $logs 'start-without-desktop.log')
    if ($startProcess.ExitCode -eq 0 -or $startLog -notmatch 'ChatGPT Desktop is not installed') { throw 'Installed Start entry did not reach the missing-Desktop guard.' }
} finally { $startProcess.Dispose() }
if ((Test-Path -LiteralPath $privateRoot) -or (Test-Path -LiteralPath (Join-Path $app 'node_modules'))) { throw 'Missing-Desktop guard changed state.' }

# Exercise the same first-start download helper with the installed bundled npm.
. (Join-Path $app 'Dependencies.ps1')
$expectedCli = (Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).dependencies.'@openai/codex'
$node = Join-Path $app 'runtime\node\node.exe'
Initialize-SessionBridgeDependencies -TestReady { Test-SessionBridgeDependencies -ApplicationRoot $app -ExpectedCliVersion $expectedCli } -Install { Install-SessionBridgeDependencies -ApplicationRoot $app -NodePath $node }
Initialize-SessionBridgeDependencies -TestReady { Test-SessionBridgeDependencies -ApplicationRoot $app -ExpectedCliVersion $expectedCli } -Install { throw 'Ready dependencies should not download again.' }
$cli = Join-Path $app 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
if ((& $cli --version) -cne ('codex-cli ' + $expectedCli) -or $LASTEXITCODE -ne 0) { throw 'Downloaded CLI version mismatch.' }

# Upgrade/uninstall must decline locked program files rather than close a process.
$uninstaller = Join-Path $app 'unins000.exe'
$lock = [IO.File]::Open($node, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    if ((Invoke-InstallerProcess $InstallerPath 'blocked-upgrade.log') -eq 0) { throw 'Upgrade accepted a locked runtime.' }
    if ((Invoke-InstallerProcess $uninstaller 'blocked-uninstall.log') -eq 0) { throw 'Uninstall accepted a locked runtime.' }
    if (!(Test-Path -LiteralPath $node)) { throw 'Locked runtime was removed.' }
} finally { $lock.Dispose() }

[void](New-Item -ItemType Directory -Path $privateRoot)
$retainedFile = Join-Path $privateRoot 'smoke-retain.txt'
'private-state-placeholder' | Set-Content -LiteralPath $retainedFile
if ((Invoke-InstallerProcess $uninstaller 'uninstall.log') -ne 0) { throw 'Normal uninstall failed.' }
foreach ($managed in @((Join-Path $app 'Start.cmd'),(Join-Path $app 'runtime'),(Join-Path $app 'node_modules'),$registryPath) + $links) {
    if (Test-Path -LiteralPath $managed) { throw "Uninstall left a managed item: $managed" }
}
if ((Get-Content -LiteralPath $retainedFile -Raw).Trim() -cne 'private-state-placeholder') { throw 'Uninstall modified private user state.' }
'Installer smoke passed: runtime and shortcuts installed, missing Desktop refused, locked dependencies downloaded once, locked files blocked, uninstall removed managed files and retained private state.'
