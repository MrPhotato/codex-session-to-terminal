#requires -Version 7.4
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
$actualRuntime = Get-SessionBridgePowerShell
$actualNode = Get-SessionBridgeNode
$legacyShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$testParent = Join-Path $PSScriptRoot '.test-work'
$testName = 'policy fixture ' + [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path $testParent $testName
[void](New-Item -ItemType Directory -Path $testRoot -Force)

function Invoke-PolicyTestHost {
    param([string]$Script, [hashtable]$Environment = @{})
    $info = [Diagnostics.ProcessStartInfo]::new($legacyShell)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $quietScript = "`$ProgressPreference='SilentlyContinue'; " + $Script
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand',
        [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($quietScript)))) { $info.ArgumentList.Add($argument) }
    foreach ($entry in $Environment.GetEnumerator()) { $info.Environment[$entry.Key] = $entry.Value }
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(15000)) { $process.Kill($true); throw 'Runtime policy test timed out.' }
        [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.GetAwaiter().GetResult().Trim(); Error = $stderr.GetAwaiter().GetResult().Trim() }
    } finally { $process.Dispose() }
}

try {
    $fixtureSource = Join-Path $testRoot 'PolicyFixture.cs'
    $fixtureExe = Join-Path $testRoot 'policy-runtime.exe'
    @'
using System;
using System.Text;
public static class PolicyFixture {
    public static int Main(string[] args) {
        int encoded = Array.IndexOf(args, "-EncodedCommand");
        int format = Array.IndexOf(args, "-OutputFormat");
        if (encoded < 0 || encoded + 1 >= args.Length || format < 0 || format + 1 >= args.Length || args[format + 1] != "Text") return 90;
        string script = Encoding.Unicode.GetString(Convert.FromBase64String(args[encoded + 1]));
        if (!script.Contains("Get-ExecutionPolicy") || !script.Contains("ConvertTo-Json")) return 91;
        string mode = Environment.GetEnvironmentVariable("CST_POLICY_TEST_MODE");
        string valid = "{\"EffectivePolicy\":\"RemoteSigned\",\"Scopes\":[{\"Scope\":\"MachinePolicy\",\"ExecutionPolicy\":\"Undefined\"},{\"Scope\":\"UserPolicy\",\"ExecutionPolicy\":\"Undefined\"},{\"Scope\":\"Process\",\"ExecutionPolicy\":\"Undefined\"},{\"Scope\":\"CurrentUser\",\"ExecutionPolicy\":\"Undefined\"},{\"Scope\":\"LocalMachine\",\"ExecutionPolicy\":\"RemoteSigned\"}]}";
        if (mode == "invalid") { Console.WriteLine("."); return 0; }
        if (mode == "contaminated") { Console.WriteLine("Unexpected diagnostic output."); Console.WriteLine(valid); return 0; }
        if (mode == "nonzero") { Console.WriteLine(valid); return 23; }
        if (mode == "incomplete") { Console.WriteLine("{\"EffectivePolicy\":\"RemoteSigned\",\"Scopes\":[]}"); return 0; }
        Console.WriteLine(valid);
        return 0;
    }
}
'@ | Set-Content -LiteralPath $fixtureSource -Encoding utf8
    & (Get-SessionBridgeCompiler) /nologo /target:exe ("/out:$fixtureExe") $fixtureSource
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the policy probe fixture.' }
    $helperPath = (Join-Path $PSScriptRoot 'Execution-Policy.ps1').Replace("'", "''")
    $fakePath = $fixtureExe.Replace("'", "''")
    $helperScript = "`$ErrorActionPreference='Stop'; . '$helperPath'; Get-SessionBridgeRuntimePolicy -RuntimePath '$fakePath' | ConvertTo-Json -Depth 4 -Compress"
    $result = Invoke-PolicyTestHost -Script $helperScript
    if ($result.ExitCode -ne 0 -or $result.Error -or ($result.Output | ConvertFrom-Json).EffectivePolicy -ne 'RemoteSigned') {
        throw "Valid policy fixture failed: exit=$($result.ExitCode); error=$($result.Error)"
    }
    foreach ($mode in @('invalid', 'contaminated', 'nonzero', 'incomplete')) {
        $result = Invoke-PolicyTestHost -Script $helperScript -Environment @{ CST_POLICY_TEST_MODE = $mode }
        if ($result.ExitCode -eq 0 -or $result.Output) { throw "Policy probe did not fail closed for $mode." }
        if ($result.Error -like '*Invalid JSON primitive*') { throw "Raw JSON parser errors leaked for $mode." }
    }

    # Exercise the real Windows PowerShell 5.1 -> PowerShell 7 boundary.
    # This is read-only: neither host execution policies nor application state change.
    $realPath = $actualRuntime.Replace("'", "''")
    $result = Invoke-PolicyTestHost -Script "`$ErrorActionPreference='Stop'; . '$helperPath'; Get-SessionBridgeRuntimePolicy -RuntimePath '$realPath' | ConvertTo-Json -Depth 4 -Compress"
    if ($result.ExitCode -ne 0 -or $result.Error) { throw "Real cross-host policy probe failed: $($result.Error)" }
    $snapshot = $result.Output | ConvertFrom-Json
    if (@($snapshot.Scopes).Count -ne 5 -or !$snapshot.EffectivePolicy) { throw 'The real runtime policy snapshot was incomplete.' }

    # Copy only entry scripts into an isolated directory. Discovery resolves the
    # actual runtimes; the legacy production script is an inert action marker.
    foreach ($name in @('Start-CST.ps1', 'bootstrap.ps1', 'Execution-Policy.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $testRoot $name)
    }
    @"
function Get-SessionBridgePowerShell { '$realPath' }
function Get-SessionBridgeNode { '$($actualNode.Replace("'", "''"))' }
"@ | Set-Content -LiteralPath (Join-Path $testRoot 'Discovery.ps1') -Encoding utf8
    foreach ($name in @('CST-Tray.ps1', 'CST-Panel.ps1', 'CST-Panel.cs', 'CST-Presence.ps1', 'cst-presence.mjs', 'cst-terminal.mjs', 'Thread-Link.ps1', 'Terminal-Focus.ps1', 'Watch-Chat-Link.ps1')) {
        '# inert test placeholder; must never execute' | Set-Content -LiteralPath (Join-Path $testRoot $name)
    }
    'param([string]$Action); "legacy-policy-ready=$Action"; exit 0' | Set-Content -LiteralPath (Join-Path $testRoot 'production.ps1')
    $newEntry = (Join-Path $testRoot 'Start-CST.ps1').Replace("'", "''")
    $result = Invoke-PolicyTestHost -Script "`$ErrorActionPreference='Stop'; & '$newEntry' -Check; exit `$LASTEXITCODE"
    if ($result.ExitCode -ne 0 -or $result.Error -or !($result.Output | ConvertFrom-Json).ready) {
        throw "Independent entry policy check failed: exit=$($result.ExitCode); error=$($result.Error)"
    }
    $oldEntry = (Join-Path $testRoot 'bootstrap.ps1').Replace("'", "''")
    $result = Invoke-PolicyTestHost -Script "`$ErrorActionPreference='Stop'; & '$oldEntry' -Action Status; exit `$LASTEXITCODE"
    if ($result.ExitCode -ne 0 -or $result.Error -or $result.Output -cne 'legacy-policy-ready=Status') {
        throw "Legacy entry policy check failed: exit=$($result.ExitCode); output=$($result.Output); error=$($result.Error)"
    }
    'Runtime policy checks passed: Windows PowerShell 5.1 to real PowerShell 7; both entry points; malformed, contaminated, nonzero and incomplete probe results rejected. No application was started and no execution policy was changed.'
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    $expectedParent = [IO.Path]::GetFullPath($testParent)
    if (![IO.Path]::GetDirectoryName($resolvedRoot).Equals($expectedParent, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedRoot) -cne $testName -or $testName -notmatch '^policy fixture [a-f0-9]{32}$') {
        throw 'Policy test cleanup target is outside its temporary directory.'
    }
    if ((Test-Path -LiteralPath $resolvedRoot) -and !((Get-Item -LiteralPath $resolvedRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
    if ((Test-Path -LiteralPath $testParent) -and !(Get-ChildItem -LiteralPath $testParent -Force)) { Remove-Item -LiteralPath $testParent }
}
