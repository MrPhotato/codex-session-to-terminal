$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent $PSScriptRoot
$workParent = Join-Path $repo '.test-work'
$work = Join-Path $workParent ('installer-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $work -Force)
$build = Join-Path $PSScriptRoot 'Build-Installer.ps1'

function Write-FixtureFile([string]$Path, [string]$Text = 'fixture') {
    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force)
    Set-Content -LiteralPath $Path -Value $Text -Encoding utf8
}
function Write-FixtureExecutable([string]$Path, [uint16]$Machine = 0x8664) {
    [void](New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force)
    $bytes = [byte[]]::new(128)
    $bytes[0] = 0x4d; $bytes[1] = 0x5a; $bytes[0x3c] = 64
    $bytes[64] = 0x50; $bytes[65] = 0x45
    [BitConverter]::GetBytes($Machine).CopyTo($bytes, 68)
    [IO.File]::WriteAllBytes($Path, $bytes)
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message -like $Pattern) { return }
        throw
    }
    throw "Expected rejection: $Pattern"
}

try {
    $fixtureRepo = Join-Path $work 'source'
    [void](New-Item -ItemType Directory -Path $fixtureRepo)
    Get-ChildItem -LiteralPath $repo -File | Copy-Item -Destination $fixtureRepo
    Copy-Item -LiteralPath (Join-Path $repo 'assets') -Destination $fixtureRepo -Recurse
    Write-FixtureFile (Join-Path $fixtureRepo 'auth.json') 'DO-NOT-PACK-test-sentinel'
    Write-FixtureFile (Join-Path $fixtureRepo '.env') 'DO-NOT-PACK-test-sentinel'
    Write-FixtureFile (Join-Path $fixtureRepo 'node_modules\private-state.json') 'DO-NOT-PACK-test-sentinel'

    $payload = Join-Path $work 'payload'
    Write-FixtureExecutable (Join-Path $payload 'runtime\node\node.exe')
    Write-FixtureExecutable (Join-Path $payload 'runtime\powershell\pwsh.exe')
    Write-FixtureFile (Join-Path $payload 'runtime\node\npm.cmd')
    Write-FixtureFile (Join-Path $payload 'runtime\node\node_modules\npm\bin\npm-cli.js')
    Write-FixtureFile (Join-Path $payload 'runtime\node\LICENSE') 'runtime-license-sentinel'
    $compiler = Join-Path $work 'compiler\ISCC.exe'
    Write-FixtureFile $compiler
    Write-FixtureFile (Join-Path $work 'compiler\LICENSE.TXT') 'compiler-license-sentinel'
    $parameters = @{ PayloadDirectory = $payload; RepoRoot = $fixtureRepo; CompilerPath = $compiler; OutputDirectory = (Join-Path $work 'out'); ValidateOnly = $true }
    $result = & $build @parameters
    $include = Get-Content -LiteralPath $result.IncludePath -Raw
    foreach ($privateName in @('auth.json', '.env', 'private-state.json')) {
        if ($include.Contains($privateName) -or (Test-Path -LiteralPath (Join-Path $payload $privateName))) {
            throw "Private source file entered the payload: $privateName"
        }
    }
    if (Test-Path -LiteralPath (Join-Path $payload 'node_modules')) { throw 'Developer dependencies were copied.' }
    if ((Get-Content -LiteralPath (Join-Path $payload 'licenses\INNO-SETUP-LICENSE.txt') -Raw).Trim() -cne 'compiler-license-sentinel') {
        throw 'The original compiler license was not preserved.'
    }
    if ((Get-Content -LiteralPath (Join-Path $payload 'runtime\node\LICENSE') -Raw).Trim() -cne 'runtime-license-sentinel') {
        throw 'Bundled runtime files were changed.'
    }
    if (!$include.Contains('Start.cmd') -or !$include.Contains('Dependencies.ps1') -or !$include.Contains('Execution-Policy.ps1')) { throw 'First-start entry files are missing.' }

    # A tiny command fixture has no PE version resource. Its supported version
    # response must pass; a different version or failed probe must still fail.
    $compilerFixture = Join-Path $work 'compiler\compiler-fixture.cmd'
    $compileParameters = $parameters.Clone()
    $compileParameters.ValidateOnly = $false
    $compileParameters.CompilerPath = $compilerFixture
    Write-FixtureFile $compilerFixture "@echo off`r`nif `"%~1`"==`"--version`" (`r`n  echo 7.1.0`r`n  exit /b 0`r`n)`r`nexit /b 37"
    Assert-Throws { & $build @compileParameters } '*compilation failed with exit code 37*'
    Write-FixtureFile $compilerFixture "@echo off`r`necho 7.1.1`r`nexit /b 0"
    Assert-Throws { & $build @compileParameters } '*requires the pinned Inno Setup compiler version 7.1.0*'
    Write-FixtureFile $compilerFixture "@echo off`r`necho 7.1.0`r`nexit /b 3"
    Assert-Throws { & $build @compileParameters } '*requires the pinned Inno Setup compiler version 7.1.0*'

    Write-FixtureExecutable (Join-Path $payload 'runtime\node\node.exe') -Machine 0x014c
    Assert-Throws { & $build @parameters } '*not Windows x64*'
    Write-FixtureExecutable (Join-Path $payload 'runtime\node\node.exe')
    Assert-Throws { & $build -PayloadDirectory $fixtureRepo -RepoRoot $fixtureRepo -ValidateOnly } '*separate build directory*'
    Assert-Throws { & $build -PayloadDirectory $payload -RepoRoot $fixtureRepo -OutputDirectory (Join-Path $payload 'out') -ValidateOnly } '*outside PayloadDirectory*'
    Remove-Item -LiteralPath (Join-Path $fixtureRepo 'Dependencies.ps1')
    Assert-Throws { & $build @parameters } '*Missing source file: Dependencies.ps1*'

    $definition = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SessionBridge.iss') -Raw
    foreach ($required in @('PrivilegesRequired=lowest', 'CloseApplications=no', 'RestartApplications=no',
        'ArchitecturesAllowed=x64os', 'UsePreviousAppDir=no', 'function InitializeUninstall',
        'function PrepareToInstall', 'CompareText(AppDirectory, ExpectedDirectory)', 'AttributeReparsePoint',
        'FileOpenReadWrite or FileShareExclusive', 'Check: DesktopShortcutAvailable')) {
        if (!$definition.Contains($required)) { throw "Installer constraint missing: $required" }
    }
    if ($definition -match '(?im)^\[(Run|UninstallRun|InstallDelete)\]') { throw 'The installer must not execute application actions.' }
    $deleteEntries = @($definition -split '\r?\n' | Where-Object { $_ -match '^Type:.*Name:' })
    if ($deleteEntries.Count -ne 1 -or $deleteEntries[0] -cne 'Type: filesandordirs; Name: "{app}\node_modules"') {
        throw 'Uninstall cleanup must be limited to the fixed application dependency directory.'
    }
    'Installer staging, x64 checks, private-file exclusion, license preservation, compiler-version guards, and lifecycle constraints passed. No real compiler, installer, or application was run.'
} finally {
    $resolvedWork = [IO.Path]::GetFullPath($work)
    $resolvedParent = [IO.Path]::GetFullPath($workParent).TrimEnd('\') + '\'
    if (!$resolvedWork.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unexpected test cleanup path.' }
    if (Test-Path -LiteralPath $resolvedWork) { Remove-Item -LiteralPath $resolvedWork -Recurse -Force }
}
