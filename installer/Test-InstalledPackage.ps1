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
foreach ($relative in @('Start.cmd','Start-CST.cmd','CST-Tray.ps1','CST-Panel.ps1','CST-Panel.cs', 'CST-TrayMenu.cs','CST-Presence.ps1','cst-presence.mjs','desktop-pipe-proxy.ps1','desktop-ipc.mjs','cst-terminal.mjs','LEGACY.md','Dependencies.ps1','runtime\node\node.exe','runtime\powershell\pwsh.exe','runtime\node\LICENSE','runtime\powershell\LICENSE.txt','runtime\powershell\ThirdPartyNotices.txt','licenses\INNO-SETUP-LICENSE.txt','unins000.exe')) {
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
    if ($shortcut.TargetPath -ine (Join-Path $app 'Start-CST.cmd')) { throw 'Shortcut does not target the current tray entry point.' }
}
$shortcutRoots = @(
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Session to Terminal')
    ([Environment]::GetFolderPath('Desktop'))
)
$retiredLinks = @(foreach ($root in $shortcutRoots) {
    foreach ($name in @('Codex Session to Terminal - Independent','Codex Session to Terminal - Legacy Shared Startup')) {
        Join-Path $root ($name + '.lnk')
    }
})
foreach ($link in $retiredLinks) {
    if (Test-Path -LiteralPath $link) { throw "Fresh installation exposed a retired entry: $link" }
}
# The read-only check reports missing dependencies without installing anything.
& (Join-Path $app 'runtime\powershell\pwsh.exe') -NoProfile -File (Join-Path $app 'Start-CST.ps1') -Check
if ($LASTEXITCODE -ne 1 -or (Test-Path -LiteralPath (Join-Path $app 'node_modules'))) { throw 'Independent bootstrap did not report missing dependencies without installing them.' }
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
    if ($startProcess.ExitCode -eq 0 -or $startLog -notmatch 'ChatGPT Desktop is not installed') {
        Write-Host $startLog
        throw 'Installed Start entry did not reach the missing-Desktop guard.'
    }
} finally { $startProcess.Dispose() }
if ((Test-Path -LiteralPath $privateRoot) -or (Test-Path -LiteralPath (Join-Path $app 'node_modules'))) { throw 'Missing-Desktop guard changed state.' }

# Exercise the same first-start download helper with the installed bundled npm.
. (Join-Path $app 'Dependencies.ps1')
$expectedCli = (Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).dependencies.'@openai/codex'
$node = Join-Path $app 'runtime\node\node.exe'
Initialize-SessionBridgeDependencies -TestReady { Test-SessionBridgeDependencies -ApplicationRoot $app -ExpectedCliVersion $expectedCli } -Install { Install-SessionBridgeDependencies -ApplicationRoot $app -NodePath $node }
Initialize-SessionBridgeDependencies -TestReady { Test-SessionBridgeDependencies -ApplicationRoot $app -ExpectedCliVersion $expectedCli } -Install { throw 'Ready dependencies should not download again.' }
& (Join-Path $app 'runtime\powershell\pwsh.exe') -NoProfile -File (Join-Path $app 'Start-CST.ps1') -Check
if ($LASTEXITCODE -ne 0) { throw 'Independent bootstrap check failed after dependency setup.' }
$cli = Join-Path $app 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
if ((& $cli --version) -cne ('codex-cli ' + $expectedCli) -or $LASTEXITCODE -ne 0) { throw 'Downloaded CLI version mismatch.' }

# Upgrade a recognized old installation even when no desktop task is selected.
# Only shortcuts are fixtures: no application target is started by these checks.
function Write-TestShortcut([string]$Path, [string]$Target, [string]$Arguments = '') {
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Target
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = Split-Path -Parent $Target
    $shortcut.Save()
}
foreach ($link in $links) { Write-TestShortcut $link (Join-Path $app 'Enable-Normal-Desktop.cmd') }
foreach ($link in $retiredLinks) { Write-TestShortcut $link (Join-Path $app 'Start.cmd') }
if ((Invoke-InstallerProcess $InstallerPath 'migrate-shortcuts.log' @('/TASKS=""')) -ne 0) { throw 'Recognized shortcut migration failed.' }
foreach ($link in $links) {
    if ($shell.CreateShortcut($link).TargetPath -ine (Join-Path $app 'Start-CST.cmd')) { throw 'Upgrade left the standard shortcut on the legacy entry.' }
}
foreach ($link in $retiredLinks) {
    if (Test-Path -LiteralPath $link) { throw 'Upgrade kept a retired recognized shortcut.' }
}
$shortcutBackups = @(Get-ChildItem -LiteralPath (Join-Path $privateRoot 'shortcut-backups') -Filter '*.lnk' -Recurse -File)
if ($shortcutBackups.Count -lt 6) { throw 'Upgrade did not preserve all six replaced or removed shortcuts.' }

# A prior desktop alias must become the standard icon even when that icon did
# not exist and the optional task for new desktop icons is not selected.
$desktopAlias = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Session to Terminal - Independent.lnk'
Remove-Item -LiteralPath $links[1]
Write-TestShortcut $desktopAlias (Join-Path $app 'Start-CST.cmd')
if ((Invoke-InstallerProcess $InstallerPath 'migrate-only-desktop-alias.log' @('/TASKS=""')) -ne 0) { throw 'Desktop alias-only migration failed.' }
if (!(Test-Path -LiteralPath $links[1]) -or $shell.CreateShortcut($links[1]).TargetPath -ine (Join-Path $app 'Start-CST.cmd') -or
    (Test-Path -LiteralPath $desktopAlias)) { throw 'Upgrade removed the sole desktop alias without a standard replacement.' }

# Same names with unknown targets or customized arguments must be left intact.
$unknownStandard = $links[1]
$unknownAlias = $retiredLinks[0]
$customAlias = $retiredLinks[1]
Write-TestShortcut $unknownStandard (Join-Path $env:WINDIR 'notepad.exe')
Write-TestShortcut $unknownAlias (Join-Path $env:WINDIR 'notepad.exe')
Write-TestShortcut $customAlias (Join-Path $app 'Start.cmd') '--custom-launch'
Write-TestShortcut $desktopAlias (Join-Path $app 'Start-CST.cmd')
$protected = @($unknownStandard,$unknownAlias,$customAlias)
$beforeHashes = @{}
foreach ($link in $protected) { $beforeHashes[$link] = (Get-FileHash -LiteralPath $link).Hash }
if ((Invoke-InstallerProcess $InstallerPath 'preserve-custom-shortcuts.log' @('/TASKS="desktopicon"')) -ne 0) { throw 'Upgrade with custom shortcut names failed.' }
foreach ($link in $protected) {
    if ((Get-FileHash -LiteralPath $link).Hash -cne $beforeHashes[$link]) { throw "Upgrade changed a custom shortcut: $link" }
}
if (Test-Path -LiteralPath $desktopAlias) { throw 'Upgrade retained the recognized desktop alias beside a protected custom standard name.' }
# Restore only these disposable fixtures before testing normal uninstall.
Write-TestShortcut $unknownStandard (Join-Path $app 'Start-CST.cmd')
Remove-Item -LiteralPath $unknownAlias,$customAlias

# Upgrade/uninstall must decline locked program files rather than close a process.
$uninstaller = Join-Path $app 'unins000.exe'
$lock = [IO.File]::Open($node, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    if ((Invoke-InstallerProcess $InstallerPath 'blocked-upgrade.log') -eq 0) { throw 'Upgrade accepted a locked runtime.' }
    if ((Invoke-InstallerProcess $uninstaller 'blocked-uninstall.log') -eq 0) { throw 'Uninstall accepted a locked runtime.' }
    if (!(Test-Path -LiteralPath $node)) { throw 'Locked runtime was removed.' }
} finally { $lock.Dispose() }

[void](New-Item -ItemType Directory -Path $privateRoot -Force)
$retainedFile = Join-Path $privateRoot 'smoke-retain.txt'
'private-state-placeholder' | Set-Content -LiteralPath $retainedFile
if ((Invoke-InstallerProcess $uninstaller 'uninstall.log') -ne 0) { throw 'Normal uninstall failed.' }
foreach ($managed in @((Join-Path $app 'Start.cmd'),(Join-Path $app 'runtime'),(Join-Path $app 'node_modules'),$registryPath) + $links) {
    if (Test-Path -LiteralPath $managed) { throw "Uninstall left a managed item: $managed" }
}
if ((Get-Content -LiteralPath $retainedFile -Raw).Trim() -cne 'private-state-placeholder') { throw 'Uninstall modified private user state.' }
'Installer smoke passed: standard entries installed, legacy shortcuts migrated and backed up, custom targets preserved, missing Desktop refused, dependencies downloaded once, locked files blocked, uninstall removed managed files and retained private state.'
