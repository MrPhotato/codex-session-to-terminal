#requires -Version 5.1
[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin'))
$ErrorActionPreference = 'Stop'
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compilerPath -PathType Leaf)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
if (![IO.Path]::IsPathRooted($OutputDirectory)) { throw 'Pipe build output must be an absolute directory.' }
[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
if ((Get-Item -LiteralPath $OutputDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Pipe build output cannot be a link.' }
$outputPath = Join-Path $OutputDirectory 'Desktop-Pipe.exe'
if ((Test-Path -LiteralPath $outputPath) -and ((Get-Item -LiteralPath $outputPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Pipe output cannot be a link.' }
& $compilerPath /nologo /target:exe /platform:x64 /optimize+ /main:CstDesktopPipe.Program ("/out:$outputPath") (Join-Path $PSScriptRoot 'Desktop-Navigation.cs') (Join-Path $PSScriptRoot 'Desktop-Pipe.cs')
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw 'Could not compile the Desktop pipe helper.' }
$check = (& $outputPath --check | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $check.version -ne 1 -or !$check.ready) { throw 'Pipe helper self-check failed.' }
$outputPath
