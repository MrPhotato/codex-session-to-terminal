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
$children = @()

function Wait-CstTestFile {
    param([Parameter(Mandatory)][string]$Path)
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (!(Test-Path -LiteralPath ($Path + '.published'))) {
        foreach ($child in $children) {
            if ($child.HasExited -and $child.ExitCode -ne 0) {
                throw ('Isolated instance exited before its checkpoint: ' + $child.StandardError.ReadToEnd())
            }
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for the isolated instance test: $([IO.Path]::GetFileName($Path))" }
        Start-Sleep -Milliseconds 20
    }
}

function Start-CstHiddenTestProcess {
    param([Parameter(Mandatory)][string]$Code)
    $info = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code)))) {
        $info.ArgumentList.Add($argument)
    }
    return [Diagnostics.Process]::Start($info)
}

try {
    $first = New-CstRunDirectory -RuntimeRoot $testRoot
    Stop-CstRun -ControlDirectory $first
    $second = New-CstRunDirectory -RuntimeRoot $testRoot
    if ($first -eq $second -or !(Test-Path -LiteralPath (Join-Path $first 'stop.flag')) -or (Test-Path -LiteralPath (Join-Path $second 'stop.flag'))) { throw 'Restart reused a generation or removed an old stop signal.' }
    $args = @(Get-CstTerminalArguments -ThreadId '12345678-1234-4234-9234-123456789abc' -ControlDirectory $second -PowerShellPath 'C:\a b\pwsh.exe' -BackendPath 'C:\official package\codex.exe')
    if ($args.Count -ne 9 -or $args[2] -cne '12345678-1234-4234-9234-123456789abc' -or $args[4] -ne $second -or $args[6] -ne 'C:\a b\pwsh.exe' -or $args[8] -ne 'C:\official package\codex.exe') { throw 'Terminal arguments were not preserved as separate values.' }
    if ([IO.Path]::GetFileName($args[0]) -cne 'cst-native-terminal.mjs') { throw 'Independent must launch the official CLI wrapper.' }
    # Malformed reusable code must fail closed without evaluating expressions.
    $fixture = Join-Path $testRoot 'bad-listener.ps1'
    [IO.File]::WriteAllText($fixture, '$nativeSource = (throw "must not execute")')
    $failed = $false
    try { Get-CstClipboardListenerSource -Path $fixture | Out-Null } catch { $failed = $true }
    if (!$failed) { throw 'Nonliteral listener source was accepted.' }

    # Exercise the actual ownership/event helpers in two hidden OS processes.
    # A mock presenter counts requests without creating a form, clipboard
    # listener, hotkey or any foreground-window operation.
    $instanceName = 'Local\CSTActivationTest-' + [Guid]::NewGuid().ToString('N')
    $childTemplate = @'
$ErrorActionPreference = 'Stop'
. __TRAY_SOURCE__ -DefinitionsOnly
$root = __TEST_ROOT__
$instanceName = __INSTANCE_NAME__
$slot = __SLOT__
$instance = $null
function Publish([string]$name, [string]$text) {
    $destination = Join-Path $root $name
    [IO.File]::WriteAllText($destination, $text)
    [IO.File]::WriteAllText(($destination + '.published'), 'ready')
}
function Wait-File([string]$name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (!(Test-Path -LiteralPath (Join-Path $root $name))) {
        if ([DateTime]::UtcNow -ge $deadline) { throw "Child timed out: $name" }
        Start-Sleep -Milliseconds 20
    }
}
try {
    Publish ('ready-' + $slot) 'ready'
    Wait-File 'race-start'
    $instance = New-CstTrayInstance -Name $instanceName
    Publish ('role-' + $slot + '.json') (@{ owner = $instance.OwnsMutex } | ConvertTo-Json -Compress)
    if ($instance.OwnsMutex) {
        $presenter = [pscustomobject]@{ Count = 0 }
        $presenter | Add-Member -MemberType ScriptMethod -Name ShowPanel -Value { $this.Count++ }
        # Do not consume the event until the duplicate has exited. This models
        # slow native/UI initialization and catches lost startup activations.
        Wait-File 'consume-first'
        Show-CstRequestedPanel -Instance $instance -Panel $presenter -Initial
        Show-CstRequestedPanel -Instance $instance -Panel $presenter
        Show-CstRequestedPanel -Instance $instance -Panel $presenter
        Publish 'consumed-first' ([string]$presenter.Count)
        Wait-File 'consume-second'
        Show-CstRequestedPanel -Instance $instance -Panel $presenter
        Show-CstRequestedPanel -Instance $instance -Panel $presenter
        Publish 'consumed-second' ([string]$presenter.Count)
        Wait-File 'stop-owner'
    }
} finally {
    if ($instance) { Close-CstTrayInstance -Instance $instance }
}
'@
    $sourceLiteral = "'" + (Join-Path $PSScriptRoot 'CST-Tray.ps1').Replace("'", "''") + "'"
    $rootLiteral = "'" + $testRoot.Replace("'", "''") + "'"
    foreach ($slot in @('one', 'two')) {
        $code = $childTemplate.Replace('__TRAY_SOURCE__', $sourceLiteral).Replace('__TEST_ROOT__', $rootLiteral).Replace('__INSTANCE_NAME__', ("'" + $instanceName + "'")).Replace('__SLOT__', ("'" + $slot + "'"))
        $children += Start-CstHiddenTestProcess -Code $code
    }
    foreach ($slot in @('one', 'two')) { Wait-CstTestFile -Path (Join-Path $testRoot ('ready-' + $slot)) }
    [IO.File]::WriteAllText((Join-Path $testRoot 'race-start'), 'go')
    foreach ($slot in @('one', 'two')) { Wait-CstTestFile -Path (Join-Path $testRoot ('role-' + $slot + '.json')) }
    $roles = @(foreach ($slot in @('one', 'two')) { Get-Content -LiteralPath (Join-Path $testRoot ('role-' + $slot + '.json')) -Raw | ConvertFrom-Json })
    if (@($roles | Where-Object owner).Count -ne 1) { throw 'Competing processes did not elect exactly one tray owner.' }
    $duplicateIndex = if ($roles[0].owner) { 1 } else { 0 }
    if (!$children[$duplicateIndex].WaitForExit(5000) -or $children[$duplicateIndex].ExitCode -ne 0) { throw 'The duplicate instance did not signal and exit successfully.' }
    [IO.File]::WriteAllText((Join-Path $testRoot 'consume-first'), 'go')
    Wait-CstTestFile -Path (Join-Path $testRoot 'consumed-first')
    if ([IO.File]::ReadAllText((Join-Path $testRoot 'consumed-first')) -ne '2') { throw 'First launch or activation during initialization was lost/repeated.' }

    # Signals after consumption must work again. Multiple requests while hidden
    # may coalesce into one show request, never an additional tray owner.
    foreach ($attempt in 1..2) {
        $duplicate = New-CstTrayInstance -Name $instanceName
        try { if ($duplicate.OwnsMutex) { throw 'A later launch replaced the live tray owner.' } }
        finally { Close-CstTrayInstance -Instance $duplicate }
    }
    [IO.File]::WriteAllText((Join-Path $testRoot 'consume-second'), 'go')
    Wait-CstTestFile -Path (Join-Path $testRoot 'consumed-second')
    if ([IO.File]::ReadAllText((Join-Path $testRoot 'consumed-second')) -ne '3') { throw 'Repeated launch did not reactivate once after the previous request was consumed.' }
    [IO.File]::WriteAllText((Join-Path $testRoot 'stop-owner'), 'stop')
    foreach ($child in $children) {
        if (!$child.WaitForExit(5000) -or $child.ExitCode -ne 0) { throw 'An isolated tray instance did not exit cleanly.' }
        if ($child.StandardError.ReadToEnd()) { throw 'An isolated tray instance reported an error.' }
    }
    $replacement = New-CstTrayInstance -Name $instanceName
    try {
        if (!$replacement.OwnsMutex -or $replacement.Activation.WaitOne(0)) { throw 'Owner shutdown did not release its handles or left a stale activation.' }
    } finally { Close-CstTrayInstance -Instance $replacement }
} finally {
    foreach ($child in $children) {
        if (!$child.HasExited) { $child.Kill(); [void]$child.WaitForExit(5000) }
        $child.Dispose()
    }
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ([IO.Path]::GetDirectoryName($resolved).Equals($parent, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^cst-tray-test-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
'Independent CST tray: native source, process selection, per-run shutdown, literal arguments and two-process startup/reactivation passed; no UI launched.'
