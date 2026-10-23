#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$testParent = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.test-work'))
$testDirectory = Join-Path $testParent ('context-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $testDirectory -Force)
try {
    $testExe = Join-Path $testDirectory 'Context-Fixtures.exe'
    $frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
    $compilerPath = Join-Path $frameworkRoot 'csc.exe'
    $references = @('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll') | ForEach-Object {
        '/reference:' + (Join-Path (Join-Path $frameworkRoot 'WPF') $_)
    }
    & $compilerPath /nologo /target:exe /platform:x64 /optimize+ /main:CstDesktopContext.Tests.EntryPoint ("/out:$testExe") @references (Join-Path $PSScriptRoot 'Desktop-Navigation.cs') (Join-Path $PSScriptRoot 'Desktop-Context.cs') (Join-Path $PSScriptRoot 'Desktop-Context.Tests.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Desktop context fixtures did not compile.' }
    # All operations are injected pure fixtures, with no native/UIA calls.
    & $testExe
    if ($LASTEXITCODE -ne 0) { throw 'Desktop context fixtures failed.' }
} finally {
    $resolvedTest = (Resolve-Path -LiteralPath $testDirectory).Path
    if (!$resolvedTest.StartsWith($testParent + '\', [StringComparison]::OrdinalIgnoreCase) -or
        (Get-Item -LiteralPath $resolvedTest).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected fixture cleanup path.' }
    Remove-Item -LiteralPath $resolvedTest -Recurse -Force
}
