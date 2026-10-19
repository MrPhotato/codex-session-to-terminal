#requires -Version 5.1
[CmdletBinding()]
param([switch]$Check)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
. (Join-Path $PSScriptRoot 'Execution-Policy.ps1')
$runtime = Get-SessionBridgePowerShell
$node = Get-SessionBridgeNode
foreach ($name in @('CST-Tray.ps1','cst-terminal.mjs','Thread-Link.ps1','Terminal-Focus.ps1','Watch-Chat-Link.ps1')) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) { throw "CST is incomplete: $name is missing." }
}
$policyProbe = '$ErrorActionPreference="Stop"; [pscustomobject]@{ EffectivePolicy=(Get-ExecutionPolicy).ToString(); Scopes=@(Get-ExecutionPolicy -List | ForEach-Object { [pscustomobject]@{ Scope=$_.Scope.ToString(); ExecutionPolicy=$_.ExecutionPolicy.ToString() } }) } | ConvertTo-Json -Depth 3 -Compress'
$policyText = & $runtime -NoProfile -NonInteractive -Command $policyProbe
if ($LASTEXITCODE -ne 0) { throw 'Could not verify PowerShell policy. CST was not started.' }
$policy = ($policyText | Out-String) | ConvertFrom-Json
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
