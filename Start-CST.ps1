#requires -Version 5.1
[CmdletBinding()]
param([switch]$Check)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
. (Join-Path $PSScriptRoot 'Execution-Policy.ps1')
$runtime = Get-SessionBridgePowerShell
$node = Get-SessionBridgeNode
foreach ($name in @('CST-Tray.ps1','CST-Panel.ps1','CST-Panel.cs','CST-Presence.ps1','cst-presence.mjs','cst-terminal.mjs','Thread-Link.ps1','Terminal-Focus.ps1','Watch-Chat-Link.ps1')) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) { throw "CST is incomplete: $name is missing." }
}
$policy = Get-SessionBridgeRuntimePolicy -RuntimePath $runtime
$processPolicy = Get-SessionBridgeProcessPolicy -Scopes $policy.Scopes -EffectivePolicy $policy.EffectivePolicy
if ($Check) {
    [pscustomobject]@{ ready = $true; powershell = $runtime; node = $node; desktopChanged = $false } | ConvertTo-Json -Compress
    exit 0
}
# Only our tray is launched. Desktop is discovered after it is already running.
$arguments = @('-NoLogo','-NoProfile','-STA','-WindowStyle','Hidden')
if ($processPolicy) { $arguments += @('-ExecutionPolicy', $processPolicy) }
$arguments += @('-File', ('"' + (Join-Path $PSScriptRoot 'CST-Tray.ps1') + '"'), '-NodePath', ('"' + $node + '"'))
Start-Process -FilePath $runtime -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
exit 0
