#requires -Version 5.1
param([ValidateSet('Start','Prepare','Launch','Check','Status','OpenCli','StopShortcut')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
. (Join-Path $PSScriptRoot 'Execution-Policy.ps1')
$runtime = Get-SessionBridgePowerShell
# PowerShell 7 can have different persistent policy settings from Windows
# PowerShell. Read them before loading any application script in that host.
$policy = Get-SessionBridgeRuntimePolicy -RuntimePath $runtime
$processPolicy = Get-SessionBridgeProcessPolicy -Scopes $policy.Scopes -EffectivePolicy $policy.EffectivePolicy
$runtimeArguments = @('-NoProfile')
if ($processPolicy) { $runtimeArguments += @('-ExecutionPolicy', $processPolicy) }
$runtimeArguments += @('-File', (Join-Path $PSScriptRoot 'production.ps1'), '-Action', $Action)
& $runtime @runtimeArguments
exit $LASTEXITCODE
