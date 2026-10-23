$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Dependencies.ps1')

$cases = @(
    @{ Name = 'Complete dependencies skip download'; Ready = @($true); Fails = $false; Calls = 'check'; Error = '' }
    @{ Name = 'First start downloads then checks'; Ready = @($false, $true); Fails = $false; Calls = 'check,install,check'; Error = '' }
    @{ Name = 'Download failure is propagated'; Ready = @($false); Fails = $true; Calls = 'check,install'; Error = '*fixture download failed*' }
    @{ Name = 'Incomplete download fails closed'; Ready = @($false, $false); Fails = $false; Calls = 'check,install,check'; Error = '*did not produce the required versions*' }
)
foreach ($case in $cases) {
    $calls = [Collections.Generic.List[string]]::new()
    $ready = [Collections.Generic.Queue[bool]]::new()
    foreach ($value in $case.Ready) { $ready.Enqueue($value) }
    $caught = ''
    try {
        Initialize-SessionBridgeDependencies -TestReady {
            $calls.Add('check')
            return $ready.Dequeue()
        } -Install {
            $calls.Add('install')
            if ($case.Fails) { throw 'fixture download failed' }
        } | Out-Null
    } catch { $caught = $_.ToString() }
    if (($calls -join ',') -cne $case.Calls) { throw "Dependency setup order failed: $($case.Name)." }
    if (($case.Error -eq '' -and $caught -ne '') -or ($case.Error -ne '' -and $caught -notlike $case.Error)) {
        throw "Dependency failure propagation failed: $($case.Name)."
    }
}

$testParent = Join-Path $PSScriptRoot '.test-work'
$testRoot = Join-Path $testParent ('dependency-fixture-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $testRoot -Force)
try {
    $expectedVersion = '0.163.0-alpha.10.2'
    if (Test-SessionBridgeDependencies -ApplicationRoot $testRoot -ExpectedCliVersion $expectedVersion) { throw 'Empty dependencies were accepted.' }
    $fixtures = @{
        'package.json' = '{"dependencies":{"ws":"8.22.0","ajv":"8.17.1","node-pty":"1.1.0","@xterm/headless":"6.0.0"}}'
        'node_modules\@openai\codex\package.json' = '{"version":"0.163.0-alpha.10.2"}'
        'node_modules\@openai\codex-win32-x64\package.json' = '{"version":"0.163.0-alpha.10.2-win32-x64"}'
        'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe' = 'inert file; never executable'
        'node_modules\ws\package.json' = '{"version":"8.22.0"}'
        'node_modules\ws\index.js' = '// inert dependency fixture'
        'node_modules\ajv\package.json' = '{"version":"8.17.1"}'
        'node_modules\ajv\dist\ajv.js' = '// inert dependency fixture'
        'node_modules\node-pty\package.json' = '{"version":"1.1.0"}'
        'node_modules\node-pty\lib\index.js' = '// inert fixture'
        'node_modules\node-pty\prebuilds\win32-x64\conpty.node' = 'inert fixture'
        'node_modules\node-pty\prebuilds\win32-x64\conpty\conpty.dll' = 'inert fixture'
        'node_modules\node-pty\prebuilds\win32-x64\conpty\OpenConsole.exe' = 'inert fixture'
        'node_modules\@xterm\headless\package.json' = '{"version":"6.0.0"}'
        'node_modules\@xterm\headless\lib-headless\xterm-headless.js' = '// inert fixture'
    }
    foreach ($entry in $fixtures.GetEnumerator()) {
        $path = Join-Path $testRoot $entry.Key
        [void](New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force)
        $entry.Value | Set-Content -LiteralPath $path -Encoding utf8
    }
    if (!(Test-SessionBridgeDependencies -ApplicationRoot $testRoot -ExpectedCliVersion $expectedVersion)) { throw 'Matching fixture dependencies were rejected.' }
    '{"version":"0.0.0"}' | Set-Content -LiteralPath (Join-Path $testRoot 'node_modules\ajv\package.json') -Encoding utf8
    if (Test-SessionBridgeDependencies -ApplicationRoot $testRoot -ExpectedCliVersion $expectedVersion) { throw 'Mismatched protocol validator was accepted.' }
    '{"version":"8.17.1"}' | Set-Content -LiteralPath (Join-Path $testRoot 'node_modules\ajv\package.json') -Encoding utf8
    '{"version":"0.0.0-win32-x64"}' | Set-Content -LiteralPath (Join-Path $testRoot 'node_modules\@openai\codex-win32-x64\package.json') -Encoding utf8
    if (Test-SessionBridgeDependencies -ApplicationRoot $testRoot -ExpectedCliVersion $expectedVersion) { throw 'Mismatched native CLI dependencies were accepted.' }
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    $expectedPrefix = [IO.Path]::GetFullPath($testParent).TrimEnd('\') + '\'
    if (!$resolvedRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test cleanup target is outside its temporary directory.' }
    if (Test-Path -LiteralPath $resolvedRoot) { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force }
    if ((Test-Path -LiteralPath $testParent) -and !(Get-ChildItem -LiteralPath $testParent -Force)) { Remove-Item -LiteralPath $testParent }
}

'Dependency checks passed: complete installs skip download; failed or incomplete setup stops; exact versions are required. No network or executable dependencies used.'
