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
    Copy-Item -LiteralPath (Join-Path $repo 'protocol-schema') -Destination $fixtureRepo -Recurse
    # Installer tests use an inert build fixture. Production compiles the reviewed
    # native source; no native window or application code runs in this suite.
    Write-FixtureFile (Join-Path $fixtureRepo 'Build-Navigation.ps1') @'
param([string]$OutputDirectory)
[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
[IO.File]::WriteAllBytes((Join-Path $OutputDirectory 'Desktop-Navigation.exe'), [byte[]](77,90,0,0))
'@
    Write-FixtureFile (Join-Path $fixtureRepo 'Build-Context.ps1') @'
param([string]$OutputDirectory)
[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
[IO.File]::WriteAllBytes((Join-Path $OutputDirectory 'Desktop-Context.exe'), [byte[]](77,90,0,0))
'@
    Write-FixtureFile (Join-Path $fixtureRepo 'Build-Pipe.ps1') @'
param([string]$OutputDirectory)
[void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
[IO.File]::WriteAllBytes((Join-Path $OutputDirectory 'Desktop-Pipe.exe'), [byte[]](77,90,0,0))
'@
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
    foreach ($navigationFile in @('Desktop-Pipe.cs', 'Build-Pipe.ps1', 'bin\Desktop-Pipe.exe', 'Desktop-Navigation.cs', 'Build-Navigation.ps1', 'bin\Desktop-Navigation.exe', 'Desktop-Context.cs', 'Build-Context.ps1', 'bin\Desktop-Context.exe', 'desktop-title-context.mjs', 'cloud-title-selection.mjs', 'cloud-identity-links.mjs')) {
        if (!$include.Contains($navigationFile) -or !(Test-Path -LiteralPath (Join-Path $payload $navigationFile))) { throw "Native navigation file missing: $navigationFile" }
    }
    if ((Get-Content -LiteralPath (Join-Path $payload 'licenses\INNO-SETUP-LICENSE.txt') -Raw).Trim() -cne 'compiler-license-sentinel') {
        throw 'The original compiler license was not preserved.'
    }
    if ((Get-Content -LiteralPath (Join-Path $payload 'runtime\node\LICENSE') -Raw).Trim() -cne 'runtime-license-sentinel') {
        throw 'Bundled runtime files were changed.'
    }
    if (!$include.Contains('Start.cmd') -or !$include.Contains('Dependencies.ps1') -or !$include.Contains('Execution-Policy.ps1') -or !$include.Contains('check-startup.mjs')) { throw 'First-start entry files are missing.' }
    foreach ($newFile in @('Start-CST.cmd','CST-Tray.ps1','CST-Panel.ps1','CST-Panel.cs', 'CST-TrayMenu.cs','CST-Presence.ps1','cst-presence.mjs','desktop-ipc.mjs','desktop-pipe-proxy.ps1','cst-terminal.mjs','cst-state.mjs','cst-transport.mjs','cst-queue.mjs','LEGACY.md')) {
        if (!$include.Contains($newFile)) { throw "Independent mode or rollback file missing: $newFile" }
    }
    foreach ($nativeFile in @('cst-native-terminal.mjs','native-cli-bridge.mjs','readonly-metadata.mjs','desktop-control.mjs','desktop-events.mjs','snapshot-history.mjs','lazy-history.mjs','protocol-validation.mjs','protocol-schema\ServerNotification.json','protocol-schema\v2\ThreadResumeResponse.json','protocol-schema\v2\ThreadTurnsListResponse.json','protocol-schema\v2\ThreadItemsListResponse.json')) {
        if (!$include.Contains($nativeFile) -or !(Test-Path -LiteralPath (Join-Path $payload $nativeFile))) { throw "Native CLI adapter file missing: $nativeFile" }
    }
    foreach ($cloudFile in @('cst-cloud-terminal.mjs','cloud-owner-activation.mjs','cloud-desktop-reader.mjs','cloud-app-tools.mjs','cloud-native-cli-bridge.mjs','cloud-native-metadata.mjs','cloud-windows-attachment.mjs','cloud-windows-cli-proxy.mjs','cloud-readonly-view.mjs','cloud-readonly-input.mjs','CLOUD-DEVELOPMENT.md','terminal-session-view.mjs','terminal-session-input.mjs','desktop-session-navigation.mjs','desktop-button-action.mjs','Focus-Desktop.ps1')) {
        if (!$include.Contains($cloudFile) -or !(Test-Path -LiteralPath (Join-Path $payload $cloudFile))) { throw "Cloud read-only file missing: $cloudFile" }
    }
    if (!$include.Contains('terminal-diagnostics.mjs') -or !(Test-Path -LiteralPath (Join-Path $payload 'terminal-diagnostics.mjs'))) { throw 'Terminal diagnostics missing.' }
    foreach ($researchFile in @('cloud-interrupt-control.mjs','cloud-interrupt-controller.mjs','cloud-history-refresh.mjs','cloud-recent-candidates.mjs')) {
        if ($include.Contains($researchFile)) { throw "Experimental cloud control entered the product: $researchFile" }
    }

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
        'FileOpenReadWrite or FileShareExclusive', 'Check: ShouldCreateDesktopShortcut',
        'function IsProductShortcut', 'procedure ConsolidateShortcuts',
        'if Trim(Shortcut.Arguments) <>', 'FileCopy(Path, BackupPath, True)')) {
        if (!$definition.Contains($required)) { throw "Installer constraint missing: $required" }
    }
    $iconsBlock = [regex]::Match($definition, '(?s)\[Icons\](.*?)\[UninstallDelete\]').Groups[1].Value
    $icons = @($iconsBlock -split '\r?\n' | Where-Object { $_ -match '^Name:' })
    if ($icons.Count -ne 2 -or @($icons | Where-Object { $_ -notmatch 'Filename: "\{app\}\\Start-CST\.cmd"' }).Count -ne 0 -or
        $iconsBlock.Contains(' - Independent') -or $iconsBlock.Contains(' - Legacy Shared Startup')) {
        throw 'Installation must expose only the standard product entry targeting the current tray.'
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
# Expected native failures above must not become the CI shell's final exit code.
$global:LASTEXITCODE = 0
