#requires -Version 7.4
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Discovery.ps1')
$compilerPath = Get-SessionBridgeCompiler
$testParent = Join-Path $PSScriptRoot '.test-work'
$testRoot = Join-Path $testParent ('runtime fixture ' + [Guid]::NewGuid().ToString('N'))
$originalPath = $env:PATH
[void](New-Item -ItemType Directory -Path $testRoot -Force)
try {
    $fixtureSource = Join-Path $testRoot 'RuntimeFixture.cs'
    $fixtureExe = Join-Path $testRoot 'runtime-fixture.exe'
    @'
using System;
using System.IO;
public static class RuntimeFixture {
    public static int Main(string[] args) {
        if (Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]) == "node") {
            if (Array.IndexOf(args, "--version") >= 0) {
                Console.WriteLine("v24.0.0");
                return 0;
            }
            Console.WriteLine("fixture-npm=" + String.Join("|", args));
            Console.WriteLine("fixture-cwd=" + Environment.CurrentDirectory);
            return 37;
        }
        if (Array.IndexOf(args, "-Command") >= 0) {
            int command = Array.IndexOf(args, "-Command");
            if (command + 1 < args.Length && args[command + 1].Contains("Get-ExecutionPolicy")) {
                string userPolicy = Environment.GetEnvironmentVariable("CST_FIXTURE_POLICY") == "AllSigned" ? "AllSigned" : "Undefined";
                Console.WriteLine("{\"EffectivePolicy\":\"Restricted\",\"Scopes\":[{\"Scope\":\"MachinePolicy\",\"ExecutionPolicy\":\"Undefined\"},{\"Scope\":\"UserPolicy\",\"ExecutionPolicy\":\"Undefined\"},{\"Scope\":\"Process\",\"ExecutionPolicy\":\"Undefined\"},{\"Scope\":\"CurrentUser\",\"ExecutionPolicy\":\"" + userPolicy + "\"},{\"Scope\":\"LocalMachine\",\"ExecutionPolicy\":\"Undefined\"}]}");
                return 0;
            }
            Console.WriteLine("7.4.9");
            return 0;
        }
        int action = Array.IndexOf(args, "-Action");
        Console.WriteLine("fixture-action=" + (action >= 0 && action + 1 < args.Length ? args[action + 1] : "missing"));
        return 37;
    }
}
'@ | Set-Content -LiteralPath $fixtureSource -Encoding utf8
    & $compilerPath /nologo /target:exe ("/out:$fixtureExe") $fixtureSource
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the fake runtime.' }
    $fixturePathDirectory = Join-Path $testRoot 'path runtimes'
    $bundlePowerShellDirectory = Join-Path $testRoot 'runtime\powershell'
    $bundleNodeDirectory = Join-Path $testRoot 'runtime\node'
    foreach ($directory in @($fixturePathDirectory, $bundlePowerShellDirectory, $bundleNodeDirectory)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }
    foreach ($destination in @(
        (Join-Path $fixturePathDirectory 'pwsh.exe'), (Join-Path $fixturePathDirectory 'node.exe'),
        (Join-Path $bundlePowerShellDirectory 'pwsh.exe'), (Join-Path $bundleNodeDirectory 'node.exe')
    )) { Copy-Item -LiteralPath $fixtureExe -Destination $destination }
    foreach ($name in @('Discovery.ps1', 'bootstrap.ps1', 'Execution-Policy.ps1', 'Start.cmd')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $testRoot $name)
    }
    $env:PATH = $fixturePathDirectory
    . (Join-Path $testRoot 'Discovery.ps1')
    if ((Get-SessionBridgePowerShell) -cne (Join-Path $bundlePowerShellDirectory 'pwsh.exe')) { throw 'Bundled PowerShell did not take precedence over PATH.' }
    if ((Get-SessionBridgeNode) -cne (Join-Path $bundleNodeDirectory 'node.exe')) { throw 'Bundled Node did not take precedence over PATH.' }

    . (Join-Path $PSScriptRoot 'Dependencies.ps1')
    $fakeNpmCli = Join-Path $bundleNodeDirectory 'node_modules\npm\bin\npm-cli.js'
    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $fakeNpmCli) -Force)
    '// inert npm fixture' | Set-Content -LiteralPath $fakeNpmCli
    $beforeLocation = (Get-Location).Path
    $npmOutput = [Collections.Generic.List[string]]::new()
    $caught = ''
    try {
        Install-SessionBridgeDependencies -ApplicationRoot $testRoot -NodePath (Join-Path $bundleNodeDirectory 'node.exe') |
            ForEach-Object { $npmOutput.Add($_.ToString()) }
    } catch { $caught = $_.ToString() }
    $expectedNpmArguments = "fixture-npm=$fakeNpmCli|ci|--ignore-scripts|--include=optional|--registry=https://registry.npmjs.org"
    if ($caught -notlike '*npm exit code 37*' -or $npmOutput.Count -ne 2 -or $npmOutput[0] -cne $expectedNpmArguments -or
        $npmOutput[1] -cne ('fixture-cwd=' + $testRoot) -or (Get-Location).Path -cne $beforeLocation) {
        throw 'Local npm invocation, failure propagation, or working-directory restoration failed.'
    }

    # Windows PowerShell 5.1 runs the real bootstrap; the selected fake pwsh only
    # echoes its action and exits 37. No production script or application runs.
    $legacyShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startInfo = [Diagnostics.ProcessStartInfo]::new($legacyShell)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-File', (Join-Path $testRoot 'bootstrap.ps1'), '-Action', 'Start')) { $startInfo.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($startInfo)
    try {
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(10000)) { $process.Kill($true); throw 'The fake-runtime bootstrap check timed out.' }
        if ($process.ExitCode -ne 37 -or $outputTask.Result.Trim() -cne 'fixture-action=Start' -or $errorTask.Result) {
            throw "Bootstrap fixture failed: exit=$($process.ExitCode); output=$($outputTask.Result.Trim()); error=$($errorTask.Result.Trim())."
        }
    } finally { $process.Dispose() }

    # The selected host's explicit AllSigned must stop bootstrap before -File,
    # even when another PowerShell host successfully loaded bootstrap itself.
    $startInfo.Environment['CST_FIXTURE_POLICY'] = 'AllSigned'
    $process = [Diagnostics.Process]::Start($startInfo)
    try {
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(10000)) { $process.Kill($true); throw 'The policy-rejection fixture timed out.' }
        if ($process.ExitCode -eq 0 -or $outputTask.Result -like '*fixture-action=*' -or
            $errorTask.Result -notlike '*blocked by a configured PowerShell execution policy*') {
            throw 'Bootstrap did not preserve the selected runtime explicit AllSigned policy.'
        }
    } finally { $process.Dispose() }

    # Exercise the actual double-click entry with a fake runtime behind it.
    # Closed stdin prevents its error pause from waiting for a person in CI.
    foreach ($restrictProcess in @($false, $true)) {
        $commandInfo = [Diagnostics.ProcessStartInfo]::new((Join-Path $env:WINDIR 'System32\cmd.exe'))
        $commandInfo.UseShellExecute = $false
        $commandInfo.CreateNoWindow = $true
        $commandInfo.RedirectStandardInput = $true
        $commandInfo.RedirectStandardOutput = $true
        $commandInfo.RedirectStandardError = $true
        foreach ($argument in @('/d', '/c', (Join-Path $testRoot 'Start.cmd'))) { $commandInfo.ArgumentList.Add($argument) }
        if ($restrictProcess) { $commandInfo.Environment['PSExecutionPolicyPreference'] = 'Restricted' }
        $process = [Diagnostics.Process]::Start($commandInfo)
        try {
            $process.StandardInput.Close()
            $outputTask = $process.StandardOutput.ReadToEndAsync()
            $errorTask = $process.StandardError.ReadToEndAsync()
            if (!$process.WaitForExit(10000)) { $process.Kill($true); throw 'The Start.cmd fixture timed out.' }
            if ($restrictProcess) {
                if ($process.ExitCode -eq 0 -or $outputTask.Result -like '*fixture-action=*' -or
                    $errorTask.Result -notlike '*blocked by a configured PowerShell execution policy*') {
                    throw 'Start.cmd did not preserve an explicit Process Restricted policy.'
                }
            } elseif ($process.ExitCode -ne 37 -or $outputTask.Result -notlike '*fixture-action=Start*') {
                throw "Start.cmd fixture failed: exit=$($process.ExitCode); error=$($errorTask.Result.Trim())."
            }
        } finally { $process.Dispose() }
    }

    # A source checkout without bundled runtimes retains the PATH fallback.
    Remove-Item -LiteralPath (Join-Path $bundlePowerShellDirectory 'pwsh.exe')
    Remove-Item -LiteralPath (Join-Path $bundleNodeDirectory 'node.exe')
    if ((Get-SessionBridgePowerShell) -cne (Join-Path $fixturePathDirectory 'pwsh.exe')) { throw 'Source PowerShell PATH fallback failed.' }
    if ((Get-SessionBridgeNode) -cne (Join-Path $fixturePathDirectory 'node.exe')) { throw 'Source Node PATH fallback failed.' }
    'Runtime checks passed: bundled/source discovery; local npm fixed arguments and failures; Windows PowerShell bootstrap plus Start.cmd action/exit forwarding; explicit policy refusal. Fake executables only.'
} finally {
    $env:PATH = $originalPath
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    $expectedPrefix = [IO.Path]::GetFullPath($testParent).TrimEnd('\') + '\'
    if (!$resolvedRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup target is outside its temporary directory.' }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
    if ((Test-Path -LiteralPath $testParent) -and !(Get-ChildItem -LiteralPath $testParent -Force)) { Remove-Item -LiteralPath $testParent }
}
