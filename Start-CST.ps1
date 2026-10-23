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
foreach ($name in @('CST-Tray.ps1','CST-Panel.ps1','CST-Panel.cs', 'CST-TrayMenu.cs','CST-Presence.ps1','cst-presence.mjs','cst-terminal.mjs','cst-native-terminal.mjs','native-cli-bridge.mjs','readonly-metadata.mjs','desktop-control.mjs','desktop-events.mjs','snapshot-history.mjs','lazy-history.mjs','protocol-validation.mjs','protocol-schema/ServerNotification.json','protocol-schema/v2/ThreadResumeResponse.json','protocol-schema/v2/ThreadTurnsListResponse.json','protocol-schema/v2/ThreadItemsListResponse.json','Thread-Link.ps1','Terminal-Focus.ps1','Watch-Chat-Link.ps1')) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) { throw "Codex Session to Terminal is incomplete: $name is missing." }
}
$policy = Get-SessionBridgeRuntimePolicy -RuntimePath $runtime
$processPolicy = Get-SessionBridgeProcessPolicy -Scopes $policy.Scopes -EffectivePolicy $policy.EffectivePolicy
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$expectedCli = $manifest.dependencies.'@openai/codex'
foreach ($name in @('cst-cloud-terminal.mjs', 'cloud-desktop-reader.mjs', 'cloud-app-tools.mjs', 'cloud-native-cli-bridge.mjs', 'cloud-native-metadata.mjs', 'cloud-windows-attachment.mjs', 'cloud-windows-cli-proxy.mjs', 'cloud-readonly-view.mjs', 'cloud-readonly-input.mjs', 'desktop-title-context.mjs', 'cloud-title-selection.mjs')) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) { throw "Codex Session to Terminal is incomplete: $name is missing." }
}
foreach ($name in @('terminal-session-view.mjs', 'terminal-session-input.mjs', 'desktop-session-navigation.mjs', 'desktop-button-action.mjs', 'Focus-Desktop.ps1')) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) { throw "Codex Session to Terminal is incomplete: $name is missing." }
}
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
