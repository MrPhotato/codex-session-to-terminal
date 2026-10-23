#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$testParent = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.test-work'))
$testDirectory = Join-Path $testParent ('navigation-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $testDirectory -Force)
try {
    $testExe = Join-Path $testDirectory 'Navigation-Fixtures.exe'
    $compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compilerPath /nologo /target:exe /platform:x64 /optimize+ /main:CstDesktopNavigation.Tests.EntryPoint ("/out:$testExe") (Join-Path $PSScriptRoot 'Desktop-Navigation.cs') (Join-Path $PSScriptRoot 'Desktop-Navigation.Tests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Native navigation fixtures did not compile.' }
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw 'Native navigation fixtures failed.' }
    if ($PSVersionTable.PSVersion.Major -ge 7) {
        # Pure object comparison with the working PS7 serializer. Loading the
        # fixture bytes runs no entry point and leaves the executable unlocked.
        $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($testExe))
        $fixtures = $assembly.GetType('CstDesktopNavigation.Tests.Fixtures', $true)
        $target = $fixtures.GetMethod('Target').Invoke($null, @())
        $navigation = $assembly.GetType('CstDesktopNavigation.Navigation', $true)
        $serialize = [Diagnostics.ProcessStartInfo].GetMethod('BuildArguments', [Reflection.BindingFlags]'Instance,NonPublic')
        if (!$serialize) { throw 'The PS7 argument serializer is unavailable for parity verification.' }
        foreach ($hostId in @('local', 'durable')) {
            $uri = 'codex://threads/11111111-2222-4333-8444-555555555555?hostId=' + $hostId
            $legacy = [Diagnostics.ProcessStartInfo]::new()
            $legacy.ArgumentList.Add('--single-argument')
            $legacy.ArgumentList.Add($uri)
            $serialized = $serialize.Invoke($legacy, @())
            $native = $navigation.GetMethod('CreateStartInfo').Invoke($null, @($target, $uri))
            if ($native.Arguments -cne $serialized -or $serialized -cne ('--single-argument ' + $uri)) {
                throw 'Native raw command line differs from the working PS7 protocol dispatch.'
            }
        }
        Write-Output 'PASS native dispatch matches actual PS7 ArgumentList serialization without launching an app'
    }
} finally {
    $resolvedTest = (Resolve-Path -LiteralPath $testDirectory).Path
    if (!$resolvedTest.StartsWith($testParent + '\', [StringComparison]::OrdinalIgnoreCase) -or
        (Get-Item -LiteralPath $resolvedTest).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected fixture cleanup path.' }
    Remove-Item -LiteralPath $resolvedTest -Recurse -Force
}
