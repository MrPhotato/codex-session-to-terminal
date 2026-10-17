#requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$CompilerDirectory)
$ErrorActionPreference = 'Stop'
# This installs a build tool only on the disposable GitHub runner, never on the user's PC.
if ($env:GITHUB_ACTIONS -cne 'true') { throw 'Compiler setup is restricted to the disposable CI runner. Pass an existing ISCC.exe for local builds.' }
. (Join-Path $PSScriptRoot 'Download-Locked.ps1')
$repository = Split-Path $PSScriptRoot -Parent
$entry = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json).innoSetup
$installer = Get-LockedDownload -Entry $entry -CacheDirectory (Join-Path $repository '.build\downloads')
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Pyrsys B\.V\.') { throw 'Inno Setup publisher verification failed.' }
$destination = [IO.Path]::GetFullPath($CompilerDirectory)
if (Test-Path -LiteralPath $destination) { throw 'Compiler destination must not already exist.' }
$process = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER','/NOICONS','/SP-',('/DIR="' + $destination + '"')) -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Compiler setup failed: $($process.ExitCode)" }
$compiler = Join-Path $destination 'ISCC.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'ISCC.exe was not installed.' }
$compiler
