#requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PayloadDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Download-Locked.ps1')
$repository = Split-Path $PSScriptRoot -Parent
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
$payload = [IO.Path]::GetFullPath($PayloadDirectory)
$runtime = Join-Path $payload 'runtime'
if (Test-Path -LiteralPath $runtime) { throw 'The payload runtime directory must not already exist.' }
$cache = Join-Path $repository '.build\downloads'
$nodeZip = Get-LockedDownload -Entry $lock.node -CacheDirectory $cache
$powerShellZip = Get-LockedDownload -Entry $lock.powershell -CacheDirectory $cache
$scratch = Join-Path $repository ('.build\node-extract-' + [Guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $nodeZip -DestinationPath $scratch
$nodeSource = Join-Path $scratch ('node-v' + $lock.node.version + '-win-x64')
if (!(Test-Path -LiteralPath (Join-Path $nodeSource 'node.exe') -PathType Leaf)) { throw 'Unexpected Node archive layout.' }
$nodeDestination = Join-Path $runtime 'node'
[void](New-Item -ItemType Directory -Path $nodeDestination -Force)
Get-ChildItem -LiteralPath $nodeSource -Force | Copy-Item -Destination $nodeDestination -Recurse
$powerShellDestination = Join-Path $runtime 'powershell'
Expand-Archive -LiteralPath $powerShellZip -DestinationPath $powerShellDestination
foreach ($required in @('runtime\node\LICENSE','runtime\node\node_modules\npm\bin\npm-cli.js','runtime\powershell\LICENSE.txt','runtime\powershell\ThirdPartyNotices.txt')) {
    if (!(Test-Path -LiteralPath (Join-Path $payload $required) -PathType Leaf)) { throw "Runtime license or component missing: $required" }
}
$nodeVersion = & (Join-Path $nodeDestination 'node.exe') --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -cne ('v' + $lock.node.version)) { throw 'Bundled Node version mismatch.' }
$powerShellVersion = & (Join-Path $powerShellDestination 'pwsh.exe') -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
if ($LASTEXITCODE -ne 0 -or $powerShellVersion -cne $lock.powershell.version) { throw 'Bundled PowerShell version mismatch.' }
[pscustomobject]@{payload=$payload;node=$nodeVersion;powershell=$powerShellVersion;sha256Verified=$true}
