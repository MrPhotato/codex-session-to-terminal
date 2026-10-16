#requires -Version 5.1
param([ValidateSet('Prepare','Launch','Status','OpenCli','StopShortcut')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$command = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$candidates = @(
    $(if ($command) { $command.Source })
    (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe')
    (Join-Path $env:LOCALAPPDATA 'Microsoft\PowerShell\7\pwsh.exe')
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique
foreach ($candidate in $candidates) {
    $versionText = & $candidate -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
    $version = $null
    if ($LASTEXITCODE -eq 0 -and [Version]::TryParse(($versionText | Out-String).Trim(), [ref]$version) -and $version -ge [Version]'7.4') {
        & $candidate -NoProfile -File (Join-Path $PSScriptRoot 'production.ps1') -Action $Action
        exit $LASTEXITCODE
    }
}
throw 'PowerShell 7.4 or newer was not found. Install PowerShell 7 and retry.'
