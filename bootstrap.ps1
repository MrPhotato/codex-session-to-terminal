#requires -Version 5.1
param([ValidateSet('Start','Prepare','Launch','Status','OpenCli','StopShortcut')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
. (Join-Path $PSScriptRoot 'Execution-Policy.ps1')
$runtime = Get-SessionBridgePowerShell
# PowerShell 7 can have different persistent policy settings from Windows
# PowerShell. Read them before loading any application script in that host.
$policyProbe = '$ErrorActionPreference="Stop"; [pscustomobject]@{ EffectivePolicy=(Get-ExecutionPolicy).ToString(); Scopes=@(Get-ExecutionPolicy -List | ForEach-Object { [pscustomobject]@{ Scope=$_.Scope.ToString(); ExecutionPolicy=$_.ExecutionPolicy.ToString() } }) } | ConvertTo-Json -Depth 3 -Compress'
$policyText = & $runtime -NoProfile -NonInteractive -Command $policyProbe
if ($LASTEXITCODE -ne 0) { throw 'Could not read the selected PowerShell runtime execution policy. No app was started.' }
$policy = ($policyText | Out-String) | ConvertFrom-Json
$processPolicy = Get-SessionBridgeProcessPolicy -Scopes $policy.Scopes -EffectivePolicy $policy.EffectivePolicy
$runtimeArguments = @('-NoProfile')
if ($processPolicy) { $runtimeArguments += @('-ExecutionPolicy', $processPolicy) }
$runtimeArguments += @('-File', (Join-Path $PSScriptRoot 'production.ps1'), '-Action', $Action)
& $runtime @runtimeArguments
exit $LASTEXITCODE
