#requires -Version 7.4
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
$testParent = Join-Path $PSScriptRoot '.test-work'
$testRoot = Join-Path $testParent ([Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $testRoot -Force)
try {
    # This executable only echoes its arguments. No real CLI or Desktop is used.
    $fixtureSource = Join-Path $testRoot 'Fixture.cs'
    $fixtureExe = Join-Path $testRoot 'fixture cli with spaces.exe'
    @'
using System;
using System.Web.Script.Serialization;
public static class Fixture {
    public static int Main(string[] args) {
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { args = args, cli = Environment.GetEnvironmentVariable("CODEX_CLI_PATH") }));
        return 0;
    }
}
'@ | Set-Content -LiteralPath $fixtureSource -Encoding utf8
    & (Get-SessionBridgeCompiler) /nologo /target:exe /r:System.Web.Extensions.dll ("/out:$fixtureExe") $fixtureSource
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the isolated test fixture.' }
    $shim = & (Join-Path $PSScriptRoot 'Build-Shim.ps1') -RealCliPath $fixtureExe -OutputDirectory $testRoot
    foreach ($arguments in @(
        ,@('--version')
        ,@('app-server','--help')
        ,@('app-server','--listen','stdio://')
        ,@('exec','value with spaces','quote"inside','trailing\')
    )) {
        $start = [Diagnostics.ProcessStartInfo]::new($shim)
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.Environment['CODEX_INTERNAL_ORIGINATOR_OVERRIDE'] = 'Codex Desktop'
        $start.Environment['CODEX_CLI_PATH'] = $shim
        [void]$start.Environment.Remove('CODEX_SHARED_SESSION_CONFIG')
        [void]$start.Environment.Remove('CODEX_SHARED_SESSION_GENERATION')
        foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
        $process = [Diagnostics.Process]::Start($start)
        try {
            $output = $process.StandardOutput.ReadToEnd()
            $errorText = $process.StandardError.ReadToEnd()
            if (!$process.WaitForExit(5000)) { $process.Kill($true); throw 'Isolated native forwarding timed out.' }
            if ($process.ExitCode -ne 0 -or $errorText) { throw 'Isolated native forwarding failed.' }
            $result = $output | ConvertFrom-Json
            if (($result.args | ConvertTo-Json -Compress) -cne ($arguments | ConvertTo-Json -Compress)) { throw 'Native argument quoting changed an argument.' }
            if ($result.cli -cne $fixtureExe) { throw 'Native fallback did not restore the real CLI path.' }
        } finally { $process.Dispose() }
    }
    'Native generated-fallback and Windows argument-quoting checks passed (fake executable only).'
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    $expectedPrefix = [IO.Path]::GetFullPath($testParent).TrimEnd('\') + '\'
    if (!$resolvedRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup target is outside its temporary directory.' }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
    if ((Test-Path -LiteralPath $testParent) -and !(Get-ChildItem -LiteralPath $testParent -Force)) { Remove-Item -LiteralPath $testParent }
}
