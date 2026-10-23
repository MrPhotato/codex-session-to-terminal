#requires -Version 5.1
[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin'))
$ErrorActionPreference = 'Stop'
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compilerPath = Join-Path $frameworkRoot 'csc.exe'
if (!(Test-Path -LiteralPath $compilerPath -PathType Leaf)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
if (![IO.Path]::IsPathRooted($OutputDirectory)) { throw 'Context build output must be an absolute directory.' }
[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
if ((Get-Item -LiteralPath $OutputDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Context build output cannot be a link.' }
$outputPath = Join-Path $OutputDirectory 'Desktop-Context.exe'
if ((Test-Path -LiteralPath $outputPath) -and ((Get-Item -LiteralPath $outputPath).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Context output cannot be a link.' }
$references = @('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll') | ForEach-Object {
    $referencePath = Join-Path (Join-Path $frameworkRoot 'WPF') $_
    if (!(Test-Path -LiteralPath $referencePath -PathType Leaf)) { throw 'Windows UI Automation framework is unavailable.' }
    "/reference:$referencePath"
}
& $compilerPath /nologo /target:exe /platform:x64 /optimize+ /main:CstDesktopContext.Program ("/out:$outputPath") @references (Join-Path $PSScriptRoot 'Desktop-Navigation.cs') (Join-Path $PSScriptRoot 'Desktop-Context.cs')
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw 'Could not compile the Desktop context helper.' }
# This mode performs no native window or UI Automation access.
$check = (& $outputPath --check | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $check.version -ne 1 -or !$check.ready) { throw 'Context helper self-check failed.' }
$outputPath
