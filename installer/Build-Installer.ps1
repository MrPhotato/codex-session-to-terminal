#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PayloadDirectory,
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$CompilerPath,
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'output\installer'),
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$')]
    [string]$Version = '0.1.0-preview.1',
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Copy only reviewed application files. Secrets, generated private state, tests,
# .git, and a developer's node_modules are not part of the installer payload.
$sourceFiles = @(
    'Start.cmd', 'Start-Flow.ps1', 'Dependencies.ps1', 'Execution-Policy.ps1', 'bootstrap.ps1', 'production.ps1',
    'Discovery.ps1', 'Build-Shim.ps1', 'CodexSharedShim.cs',
    'Launcher-Environment.ps1', 'Watch-Chat-Link.ps1', 'Terminal-Focus.ps1',
    'Thread-Link.ps1', 'bridge-shim.mjs', 'rpc-client.mjs', 'check-live.mjs',
    'Enable-Normal-Desktop.cmd', 'Open-Current-Chat.cmd', 'Prepare.cmd',
    'Status.cmd', 'Stop-Shortcut.cmd', 'package.json', 'package-lock.json',
    'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'assets\icon.ico', 'assets\icon.png'
)
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path.TrimEnd('\')
$payload = [IO.Path]::GetFullPath($PayloadDirectory).TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if ($payload -ieq $repo -or $repo.StartsWith($payload + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'PayloadDirectory must be a separate build directory, not the source directory or its parent.'
}
if ($output -ieq $payload -or $output.StartsWith($payload + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be outside PayloadDirectory.'
}
if (!(Test-Path -LiteralPath $payload -PathType Container)) { throw 'Prepare the runtime payload directory first.' }
if ((Get-Item -LiteralPath $payload).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PayloadDirectory must not be a link.' }
$runtime = Join-Path $payload 'runtime'
if (!(Test-Path -LiteralPath $runtime -PathType Container)) { throw 'The bundled runtime directory is missing.' }
$runtimeEntries = @(Get-Item -LiteralPath $runtime) + @(Get-ChildItem -LiteralPath $runtime -Recurse -Force)
foreach ($entry in $runtimeEntries) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Runtime links are not allowed: $($entry.Name)" }
}
foreach ($relative in @('runtime\node\node.exe', 'runtime\node\npm.cmd',
    'runtime\node\node_modules\npm\bin\npm-cli.js', 'runtime\powershell\pwsh.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $payload $relative) -PathType Leaf)) { throw "Missing runtime file: $relative" }
}
foreach ($relative in @('runtime\node\node.exe', 'runtime\powershell\pwsh.exe')) {
    $stream = [IO.File]::OpenRead((Join-Path $payload $relative))
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D -or $stream.Length -lt 64) { throw "Invalid Windows runtime: $relative" }
        $stream.Position = 0x3c
        $headerOffset = $reader.ReadUInt32()
        if ($headerOffset -gt ($stream.Length - 6)) { throw "Invalid PE header: $relative" }
        $stream.Position = $headerOffset
        if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw "Runtime is not Windows x64: $relative" }
    } finally { $reader.Dispose(); $stream.Dispose() }
}

foreach ($relative in $sourceFiles) {
    $source = Join-Path $repo $relative
    if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing source file: $relative" }
    if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Source links are not allowed: $relative" }
    $destination = Join-Path $payload $relative
    $destinationParent = Split-Path -Parent $destination
    if (Test-Path -LiteralPath $destinationParent) {
        if ((Get-Item -LiteralPath $destinationParent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Payload links are not allowed: $relative" }
    } else { [void](New-Item -ItemType Directory -Path $destinationParent) }
    if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Payload links are not allowed: $relative"
    }
    Copy-Item -LiteralPath $source -Destination $destination -Force
}
if (!$CompilerPath -or !(Test-Path -LiteralPath $CompilerPath -PathType Leaf)) { throw 'Pass the path to the verified Inno Setup 7.1.0 ISCC.exe.' }
$compiler = (Resolve-Path -LiteralPath $CompilerPath).Path
$compilerLicense = Join-Path (Split-Path -Parent $compiler) 'LICENSE.TXT'
if (!(Test-Path -LiteralPath $compilerLicense -PathType Leaf)) { throw 'The official Inno Setup license must accompany ISCC.exe.' }
$licensesDirectory = Join-Path $payload 'licenses'
if ((Test-Path -LiteralPath $licensesDirectory) -and ((Get-Item -LiteralPath $licensesDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The payload licenses directory must not be a link.'
}
[void](New-Item -ItemType Directory -Path $licensesDirectory -Force)
$licenseDestination = Join-Path $licensesDirectory 'INNO-SETUP-LICENSE.txt'
if ((Test-Path -LiteralPath $licenseDestination) -and ((Get-Item -LiteralPath $licenseDestination).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The payload license file must not be a link.'
}
Copy-Item -LiteralPath $compilerLicense -Destination $licenseDestination -Force
[void](New-Item -ItemType Directory -Path $output -Force)
$includePath = Join-Path $output "payload-files-$Version.iss"
$includeLines = foreach ($relative in ($sourceFiles + 'licenses\INNO-SETUP-LICENSE.txt')) {
    $subdirectory = Split-Path -Parent $relative
    $destination = if ($subdirectory) { '{app}\' + $subdirectory } else { '{app}' }
    'Source: "{#PayloadRoot}\' + $relative + '"; DestDir: "' + $destination + '"; Flags: ignoreversion'
}
Set-Content -LiteralPath $includePath -Value $includeLines -Encoding utf8
if ($ValidateOnly) {
    return [pscustomobject]@{ PayloadDirectory = $payload; SourceFileCount = $sourceFiles.Count; Version = $Version; IncludePath = $includePath }
}
# --version queries the loaded compiler engine. The ISCC PE file resource is
# not the supported engine-version interface (Inno 7.1.0, Projects/ISCC.dpr).
$compilerVersion = (& $compiler --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $compilerVersion -cne '7.1.0') {
    throw 'The installer build requires the pinned Inno Setup compiler version 7.1.0.'
}
$compilerArguments = @('/Qp', "/DAppVersion=$Version", "/DPayloadRoot=$payload", "/DPayloadFilesInclude=$includePath",
    "/DBuildOutput=$output", (Join-Path $PSScriptRoot 'SessionBridge.iss'))
& $compiler @compilerArguments
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed with exit code $LASTEXITCODE." }
$installer = Join-Path $output "Codex-Session-to-Terminal-$Version-windows-x64-setup.exe"
if (!(Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'The compiler did not create the expected installer.' }
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($installer + '.sha256') -Value ($hash + '  ' + [IO.Path]::GetFileName($installer)) -Encoding ascii
[pscustomobject]@{ Installer = $installer; SHA256 = $hash; Version = $Version }
