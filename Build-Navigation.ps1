#requires -Version 5.1
[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin'))
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'Desktop-Navigation.cs'
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compilerPath -PathType Leaf)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
if (![IO.Path]::IsPathRooted($OutputDirectory)) { throw 'Navigation build output must be an absolute directory.' }
[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
if ((Get-Item -LiteralPath $OutputDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Navigation build output cannot be a link.' }
$outputPath = Join-Path $OutputDirectory 'Desktop-Navigation.exe'
if ((Test-Path -LiteralPath $outputPath) -and ((Get-Item -LiteralPath $outputPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Navigation output cannot be a link.' }
& $compilerPath /nologo /target:exe /platform:x64 /optimize+ ("/out:$outputPath") $sourcePath
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw 'Could not compile the Desktop navigation helper.' }
# This mode performs no window access or app dispatch.
$check = (& $outputPath --check | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $check.version -ne 1 -or !$check.ready) { throw 'Navigation helper self-check failed.' }
$outputPath
