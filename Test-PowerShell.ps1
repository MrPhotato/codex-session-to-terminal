#requires -Version 7.4
$ErrorActionPreference = 'Stop'
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
    $errors = $null
    $tokens = $null
    [void][Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw "PowerShell syntax failed: $($file.Name)" }
}
& (Join-Path $PSScriptRoot 'Thread-Link.Tests.ps1')
& (Join-Path $PSScriptRoot 'Launcher-Environment.Tests.ps1')
& (Join-Path $PSScriptRoot 'Terminal-Focus.Tests.ps1')
& (Join-Path $PSScriptRoot 'Build-Shim.Tests.ps1')
& (Join-Path $PSScriptRoot 'Start-Flow.Tests.ps1')
& (Join-Path $PSScriptRoot 'Dependencies.Tests.ps1')
& (Join-Path $PSScriptRoot 'Execution-Policy.Tests.ps1')
& (Join-Path $PSScriptRoot 'Runtime-Policy.Tests.ps1')
& (Join-Path $PSScriptRoot 'Runtime-Discovery.Tests.ps1')
& (Join-Path $PSScriptRoot 'Cli-Compatibility.Tests.ps1')
& (Join-Path $PSScriptRoot 'CST-Tray.Tests.ps1')
& (Join-Path $PSScriptRoot 'test\CST-Presence.Tests.ps1')
& (Join-Path $PSScriptRoot 'CST-Panel.Tests.ps1')
& (Join-Path $PSScriptRoot 'CST-Heartbeat.Tests.ps1')
'All PowerShell checks passed. No Desktop, real CLI session, profile, or credentials were used.'
