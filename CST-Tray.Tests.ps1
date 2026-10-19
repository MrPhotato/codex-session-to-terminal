$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CST-Tray.ps1') -DefinitionsOnly

# Definition loading and native compilation do not create a window/listener,
# query Desktop, read the clipboard or register any key.
$native = Get-CstClipboardListenerSource -Path (Join-Path $PSScriptRoot 'Watch-Chat-Link.ps1')
if (!('CodexSharedSession.ClipboardLinkListener' -as [type])) { Add-Type -TypeDefinition $native }
$proxyTokens = $null; $proxyErrors = $null
$proxyAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'desktop-pipe-proxy.ps1'), [ref]$proxyTokens, [ref]$proxyErrors)
if ($proxyErrors.Count) { throw 'Desktop pipe proxy has syntax errors.' }
$proxySource = @($proxyAst.FindAll({ param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.Contains('public static class CstVerifiedPipe') }, $true))
if ($proxySource.Count -ne 1) { throw 'Desktop pipe proxy source was not found.' }
# Compile the identity checks and Identification-level pipe constructor only.
# Do not call Run or connect to any real or synthetic Desktop pipe here.
if (!('CstVerifiedPipe' -as [type])) { Add-Type -TypeDefinition $proxySource[0].Value }

$package = Join-Path ([IO.Path]::GetTempPath()) 'cst-package-fixture'
$official = Join-Path $package 'app\ChatGPT.exe'
$records = @(
    [pscustomobject]@{ Id = 1; StartTicks = 100; WindowHandle = 20; Path = $official }
    [pscustomobject]@{ Id = 2; StartTicks = 200; WindowHandle = 30; Path = $official }
    [pscustomobject]@{ Id = 3; StartTicks = 300; WindowHandle = 0; Path = $official }
    [pscustomobject]@{ Id = 4; StartTicks = 400; WindowHandle = 40; Path = (Join-Path $package 'other\ChatGPT.exe') }
)
if ((Select-CstDesktopProcess -Processes $records -PackageLocations @($package)).Id -ne 2) { throw 'Newest official main process was not selected.' }
if ((Select-CstDesktopProcess -Processes $records -PackageLocations @($package) -PreferredPid 1).Id -ne 1) { throw 'Existing main process binding was not preserved.' }
if ((Select-CstDesktopProcess -Processes $records -PackageLocations @($package) -PreferredPid 1 -ForegroundPid 2).Id -ne 2) { throw 'Foreground official main process was not preferred.' }
if ($null -ne (Select-CstDesktopProcess -Processes $records -PackageLocations @())) { throw 'Unverified application was accepted.' }
if ($null -ne (Select-CstDesktopProcess -Processes @($records[2],$records[3]) -PackageLocations @($package))) { throw 'Child or unrelated process was accepted.' }

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('cst-tray-test-' + [Guid]::NewGuid().ToString('N'))
try {
    $first = New-CstRunDirectory -RuntimeRoot $testRoot
    Stop-CstRun -ControlDirectory $first
    $second = New-CstRunDirectory -RuntimeRoot $testRoot
    if ($first -eq $second -or !(Test-Path -LiteralPath (Join-Path $first 'stop.flag')) -or (Test-Path -LiteralPath (Join-Path $second 'stop.flag'))) { throw 'Restart reused a generation or removed an old stop signal.' }
    $args = @(Get-CstTerminalArguments -ThreadId '12345678-1234-4234-9234-123456789abc' -ControlDirectory $second -PowerShellPath 'C:\a b\pwsh.exe' -BackendPath 'C:\official package\codex.exe')
    if ($args.Count -ne 9 -or $args[2] -cne '12345678-1234-4234-9234-123456789abc' -or $args[4] -ne $second -or $args[6] -ne 'C:\a b\pwsh.exe' -or $args[8] -ne 'C:\official package\codex.exe') { throw 'Terminal arguments were not preserved as separate values.' }
    # Malformed reusable code must fail closed without evaluating expressions.
    $fixture = Join-Path $testRoot 'bad-listener.ps1'
    [IO.File]::WriteAllText($fixture, '$nativeSource = (throw "must not execute")')
    $failed = $false
    try { Get-CstClipboardListenerSource -Path $fixture | Out-Null } catch { $failed = $true }
    if (!$failed) { throw 'Nonliteral listener source was accepted.' }
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ([IO.Path]::GetDirectoryName($resolved).Equals($parent, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^cst-tray-test-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
'Independent CST tray: native source, process identity selection, per-run shutdown and literal arguments passed; no UI launched.'
