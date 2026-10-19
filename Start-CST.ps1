#requires -Version 5.1
[CmdletBinding()]
param([switch]$Check)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
. (Join-Path $PSScriptRoot 'Execution-Policy.ps1')
. (Join-Path $PSScriptRoot 'Dependencies.ps1')
$runtime = Get-SessionBridgePowerShell
$node = Get-SessionBridgeNode
foreach ($name in @('CST-Tray.ps1','CST-Panel.ps1','CST-Panel.cs','CST-Presence.ps1','cst-presence.mjs','cst-terminal.mjs','cst-native-terminal.mjs','native-cli-bridge.mjs','readonly-metadata.mjs','desktop-control.mjs','desktop-events.mjs','snapshot-history.mjs','protocol-validation.mjs','protocol-schema/ServerNotification.json','protocol-schema/v2/ThreadResumeResponse.json','protocol-schema/v2/ThreadTurnsListResponse.json','protocol-schema/v2/ThreadItemsListResponse.json','Thread-Link.ps1','Terminal-Focus.ps1','Watch-Chat-Link.ps1')) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) { throw "CST is incomplete: $name is missing." }
}
$policy = Get-SessionBridgeRuntimePolicy -RuntimePath $runtime
$processPolicy = Get-SessionBridgeProcessPolicy -Scopes $policy.Scopes -EffectivePolicy $policy.EffectivePolicy
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$expectedCli = $manifest.dependencies.'@openai/codex'
if ($Check) {
    $ready = Test-SessionBridgeDependencies -ApplicationRoot $PSScriptRoot -ExpectedCliVersion $expectedCli
    [pscustomobject]@{ ready = $ready; powershell = $runtime; node = $node; terminal = 'official-codex-cli'; cliVersion = $expectedCli; desktopChanged = $false } | ConvertTo-Json -Compress
    if (!$ready) { exit 1 }
    exit 0
}
Initialize-SessionBridgeDependencies -TestReady {
    Test-SessionBridgeDependencies -ApplicationRoot $PSScriptRoot -ExpectedCliVersion $expectedCli
} -Install {
    Install-SessionBridgeDependencies -ApplicationRoot $PSScriptRoot -NodePath $node
}
# Only our tray is launched. Desktop is discovered after it is already running.
$arguments = @('-NoLogo','-NoProfile','-STA','-WindowStyle','Hidden')
if ($processPolicy) { $arguments += @('-ExecutionPolicy', $processPolicy) }
$arguments += @('-File', ('"' + (Join-Path $PSScriptRoot 'CST-Tray.ps1') + '"'), '-NodePath', ('"' + $node + '"'))
Start-Process -FilePath $runtime -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
exit 0
