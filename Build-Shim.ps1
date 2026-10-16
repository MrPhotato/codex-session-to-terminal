#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RealCliPath,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
if (![IO.Path]::IsPathFullyQualified($RealCliPath) -or !(Test-Path -LiteralPath $RealCliPath -PathType Leaf)) {
    throw 'The native fallback must be an existing absolute executable path.'
}
if (![IO.Path]::IsPathFullyQualified($OutputDirectory) -or !(Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    throw 'Build output must be an existing absolute directory; Prepare protects its permissions first.'
}
# This contains a local executable path only, never a token or user configuration.
# Embedding it preserves native forwarding if a child filters the config variable.
$escapedPath = $RealCliPath.Replace('"', '""')
$sourcePath = Join-Path $OutputDirectory 'ShimPaths.generated.cs'
('internal static class SharedShimPaths { internal const string Cli = @"' + $escapedPath + '"; }') |
    Set-Content -LiteralPath $sourcePath -Encoding utf8
$shimPath = Join-Path $OutputDirectory 'CodexSharedShim.exe'
& (Get-SessionBridgeCompiler) /nologo /target:exe /optimize+ /r:System.Web.Extensions.dll ("/out:$shimPath") (Join-Path $PSScriptRoot 'CodexSharedShim.cs') $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the native shared-session shim.' }
$shimPath
