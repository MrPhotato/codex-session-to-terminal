#requires -Version 7.4
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
$testParent = Join-Path $PSScriptRoot '.test-work'
$testRoot = Join-Path $testParent ('cli compatibility ' + [Guid]::NewGuid().ToString('N'))
$originalHome = $env:CODEX_HOME
$originalCli = $env:CODEX_CLI_PATH
$originalFixtureHome = $env:SESSION_BRIDGE_FIXTURE_HOME
$originalFixtureLog = $env:SESSION_BRIDGE_FIXTURE_LOG
[void](New-Item -ItemType Directory -Path $testRoot -Force)
function Assert-CompatibilityFailure([scriptblock]$Action, [string]$Expected) {
    $failure = ''
    try { & $Action | Out-Null } catch { $failure = $_.Exception.Message }
    if ($failure -notlike $Expected) { throw "Expected compatibility failure '$Expected', received '$failure'." }
}
try {
    $source = Join-Path $testRoot 'ProbeFixture.cs'
    $fixture = Join-Path $testRoot 'probe-fixture.exe'
    @'
using System;
using System.IO;
using System.Threading;
public static class ProbeFixture {
    public static int Main(string[] args) {
        string executable = Environment.GetCommandLineArgs()[0];
        string mode = new DirectoryInfo(Path.GetDirectoryName(executable)).Name;
        string home = Environment.GetEnvironmentVariable("CODEX_HOME");
        if (String.IsNullOrEmpty(home) || home == Environment.GetEnvironmentVariable("SESSION_BRIDGE_FIXTURE_HOME")) return 40;
        if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("CODEX_CLI_PATH"))) return 41;
        if (Environment.CurrentDirectory != home) return 42;
        File.AppendAllText(Environment.GetEnvironmentVariable("SESSION_BRIDGE_FIXTURE_LOG"), home + Environment.NewLine);
        File.WriteAllText(Path.Combine(home, "probe-only.txt"), "fixture");
        if (mode == "timeout") { Thread.Sleep(10000); return 0; }
        if (mode == "failure") return 43;
        if (Array.IndexOf(args, "--version") >= 0) {
            Console.WriteLine(mode == "client" ? "codex-cli 0.163.0-alpha.10.2" : "codex-cli 9.9.9-future");
            return 0;
        }
        if (mode == "lookalike") {
            Console.WriteLine("  --listen-extra URL\n  --ws-auth TYPE\n  --ws-token-file PATH\n  --remote-extra URL\n  --remote-auth-token-env NAME");
        } else if (mode == "missing") {
            Console.WriteLine("  --listen URL\n  --remote URL");
        } else if (args.Length == 2 && args[0] == "app-server" && args[1] == "--help") {
            Console.WriteLine("  --listen [URL]\n  --ws-auth TYPE\n  --ws-token-file PATH");
        } else if (args.Length == 1 && args[0] == "--help") {
            Console.WriteLine("  --remote URL\n  --remote-auth-token-env NAME");
        } else { return 44; }
        return 0;
    }
}
'@ | Set-Content -LiteralPath $source -Encoding utf8
    & (Get-SessionBridgeCompiler) /nologo /target:exe ("/out:$fixture") $source
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the inert CLI fixture.' }
    $env:CODEX_HOME = Join-Path $testRoot 'normal home'
    $env:CODEX_CLI_PATH = 'must-not-be-inherited'
    $env:SESSION_BRIDGE_FIXTURE_HOME = $env:CODEX_HOME
    $env:SESSION_BRIDGE_FIXTURE_LOG = Join-Path $testRoot 'probe-homes.txt'
    $paths = @{}
    foreach ($mode in @('backend','client','lookalike','missing','failure','timeout')) {
        $directory = Join-Path $testRoot $mode
        [void](New-Item -ItemType Directory -Path $directory)
        $paths[$mode] = Join-Path $directory 'codex.exe'
        Copy-Item -LiteralPath $fixture -Destination $paths[$mode]
    }
    $backend = Assert-SessionBridgeCliCapabilities -Path $paths.backend -Role Backend
    $client = Assert-SessionBridgeCliCapabilities -Path $paths.client -Role Client
    if ($backend.Version -cne '9.9.9-future' -or $client.Version -cne '0.163.0-alpha.10.2') {
        throw 'Capabilities must allow different backend/client versions and preserve their reported versions.'
    }
    foreach ($role in @('Backend','Client')) {
        Assert-CompatibilityFailure { Assert-SessionBridgeCliCapabilities -Path $paths.missing -Role $role } '*lacks required option*'
        Assert-CompatibilityFailure { Assert-SessionBridgeCliCapabilities -Path $paths.lookalike -Role $role } '*lacks required option*'
    }
    Assert-CompatibilityFailure { Assert-SessionBridgeCliCapabilities -Path $paths.failure -Role Backend } '*exited with code 43*'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Assert-CompatibilityFailure { Assert-SessionBridgeCliCapabilities -Path $paths.timeout -Role Backend -TimeoutMilliseconds 200 } '*timed out*'
    if ($clock.Elapsed.TotalSeconds -ge 5) { throw 'The capability probe did not enforce its timeout.' }

    # Discovery must choose the executable in the selected package, independent
    # of cached directory names and CLI version strings.
    $packageRoot = Join-Path $testRoot 'package 26.9999.1234.0'
    $packageResources = Join-Path $packageRoot 'app\resources'
    [void](New-Item -ItemType Directory -Path $packageResources -Force)
    $packageCli = Join-Path $packageResources 'codex.exe'
    Copy-Item -LiteralPath $fixture -Destination $packageCli
    if ((Get-SessionBridgeInstalledCli -PackageInstallLocation $packageRoot) -cne $packageCli) { throw 'Discovery did not use the selected package backend.' }
    Assert-CompatibilityFailure { Get-SessionBridgeInstalledCli -PackageInstallLocation (Join-Path $testRoot 'missing package') } '*backend layout needs compatibility review*'

    if (Test-Path -LiteralPath $env:CODEX_HOME) { throw 'A probe touched the normal Codex home.' }
    $homes = @(Get-Content -LiteralPath $env:SESSION_BRIDGE_FIXTURE_LOG | Select-Object -Unique)
    if ($homes.Count -lt 10) { throw 'The expected isolated probes did not run.' }
    foreach ($probeHome in $homes) {
        if (Test-Path -LiteralPath $probeHome) { throw 'A completed or timed-out probe left its temporary home behind.' }
    }
    'CLI compatibility checks passed: package-owned discovery; independent versions; exact required flags; missing/failed/hung probes; isolated and cleaned temporary homes. Fake executables only.'
} finally {
    $env:CODEX_HOME = $originalHome
    $env:CODEX_CLI_PATH = $originalCli
    $env:SESSION_BRIDGE_FIXTURE_HOME = $originalFixtureHome
    $env:SESSION_BRIDGE_FIXTURE_LOG = $originalFixtureLog
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    $expectedPrefix = [IO.Path]::GetFullPath($testParent).TrimEnd('\') + '\'
    if (!$resolvedRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup is outside its temporary directory.' }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
    if ((Test-Path -LiteralPath $testParent) -and !(Get-ChildItem -LiteralPath $testParent -Force)) { Remove-Item -LiteralPath $testParent }
}
$global:LASTEXITCODE = 0
