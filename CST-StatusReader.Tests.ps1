#requires -Version 7.4
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CST-Tray.ps1') -DefinitionsOnly

# All scans below use injected fixtures in a private runspace. No form,
# Desktop process, clipboard listener, real session or foreground API is used.
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('cst-status-reader-test-' + [Guid]::NewGuid().ToString('N'))
$reader = $null

function Wait-CstStatusCheckpoint {
    param([Parameter(Mandatory)][scriptblock]$Condition, [Parameter(Mandatory)][string]$Description)
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (!(& $Condition)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out: $Description" }
        Start-Sleep -Milliseconds 10
    }
}

try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    $reader = New-CstStatusReader -Script @'
param($Root, $ControlDirectory, $PreferredPid)
$ErrorActionPreference = 'Stop'
[IO.File]::AppendAllText((Join-Path $ControlDirectory 'starts'), "started`n")
[IO.File]::WriteAllText((Join-Path $ControlDirectory 'entered'), 'ready')
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (![IO.File]::Exists((Join-Path $ControlDirectory 'release'))) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Fixture was never released.' }
    Start-Sleep -Milliseconds 10
}
'incidental output'
[pscustomobject]@{ Root = $Root; Directory = $ControlDirectory; Preferred = $PreferredPid; Thread = [Threading.Thread]::CurrentThread.ManagedThreadId }
'@
    $startClock = [Diagnostics.Stopwatch]::StartNew()
    if (!(Start-CstStatusRead -Reader $reader -ControlDirectory $testRoot -PreferredPid 42)) { throw 'First scan did not start.' }
    $startClock.Stop()
    if ($startClock.ElapsedMilliseconds -ge 1000) { throw 'Starting a slow scan blocked the caller.' }
    Wait-CstStatusCheckpoint -Condition { [IO.File]::Exists((Join-Path $testRoot 'entered')) } -Description 'slow scan entered'

    $pending = $reader.Pending
    $pollClock = [Diagnostics.Stopwatch]::StartNew()
    for ($index = 0; $index -lt 50; $index++) {
        if ($null -ne (Receive-CstStatusRead -Reader $reader)) { throw 'An unfinished scan produced a snapshot.' }
        if (Start-CstStatusRead -Reader $reader -ControlDirectory $testRoot -PreferredPid 99) { throw 'An overlapping scan was started.' }
    }
    $pollClock.Stop()
    if ($pollClock.ElapsedMilliseconds -ge 1000) { throw 'Polling an unfinished scan blocked the caller.' }
    if (![Object]::ReferenceEquals($pending, $reader.Pending)) { throw 'Polling or a duplicate start replaced the pending scan.' }
    if ([IO.File]::ReadAllLines((Join-Path $testRoot 'starts')).Count -ne 1) { throw 'More than one scan ran before completion.' }

    [IO.File]::WriteAllText((Join-Path $testRoot 'release'), 'go')
    Wait-CstStatusCheckpoint -Condition { $reader.Pending.IsCompleted } -Description 'slow scan completed'
    if (Start-CstStatusRead -Reader $reader -ControlDirectory $testRoot) { throw 'An unread completed snapshot was overwritten.' }
    $snapshot = Receive-CstStatusRead -Reader $reader
    if (!$snapshot -or $snapshot.Root -cne $PSScriptRoot -or $snapshot.Directory -cne $testRoot -or $snapshot.Preferred -ne 42) { throw 'The final snapshot or scan arguments were not preserved.' }
    if ($snapshot.Thread -eq [Threading.Thread]::CurrentThread.ManagedThreadId) { throw 'The scan ran on the caller thread.' }
    if ($null -ne $reader.Pending -or $null -ne (Receive-CstStatusRead -Reader $reader)) { throw 'The completed scan was not consumed exactly once.' }

    # A failed/empty scan must release its slot, suppress a partial result, and
    # leave the same reader able to deliver a later healthy snapshot.
    foreach ($failureScript in @(
        "throw 'injected terminating scan failure'",
        "Write-Error 'injected nonterminating scan failure'; [pscustomobject]@{ InvalidPartialSnapshot = 1 }",
        '$null'
    )) {
        $reader.Script = $failureScript
        if (!(Start-CstStatusRead -Reader $reader -ControlDirectory $testRoot)) { throw 'A completed reader could not be reused.' }
        Wait-CstStatusCheckpoint -Condition { $reader.Pending.IsCompleted } -Description 'failed/empty scan completed'
        if ($null -ne (Receive-CstStatusRead -Reader $reader) -or $null -ne $reader.Pending) { throw 'A failed/empty scan leaked a result or retained its slot.' }
        $reader.Script = "[pscustomobject]@{ Healthy = 'recovered' }"
        if (!(Start-CstStatusRead -Reader $reader -ControlDirectory $testRoot)) { throw 'The reader could not restart after a failed/empty scan.' }
        Wait-CstStatusCheckpoint -Condition { $reader.Pending.IsCompleted } -Description 'recovery scan completed'
        $recovered = Receive-CstStatusRead -Reader $reader
        if (!$recovered -or $recovered.Healthy -cne 'recovered') { throw 'An earlier error poisoned a healthy scan.' }
    }

    # An absent optional resource is an ordinary waiting state. SilentlyContinue
    # can set PowerShell.HadErrors even when it emits no error record.
    $reader.Script = @'
param($Root, $ControlDirectory, $PreferredPid)
$null = Get-Item -LiteralPath (Join-Path $ControlDirectory 'optional-resource-not-present') -ErrorAction SilentlyContinue
[pscustomobject]@{ Desktop = $null; Healthy = 'waiting' }
'@
    if (!(Start-CstStatusRead -Reader $reader -ControlDirectory $testRoot)) { throw 'The optional-resource fixture did not start.' }
    Wait-CstStatusCheckpoint -Condition { $reader.Pending.IsCompleted } -Description 'optional-resource scan completed'
    if (!$reader.Worker.HadErrors -or $reader.Worker.Streams.Error.Count -ne 0) { throw 'The fixture did not reproduce a handled silent lookup failure.' }
    $waiting = Receive-CstStatusRead -Reader $reader
    if (!$waiting -or $waiting.Healthy -cne 'waiting' -or $null -ne $waiting.Desktop) { throw 'A handled missing optional resource suppressed its normal waiting snapshot.' }

    # Cancellation must run the worker's cleanup and close only this reader;
    # no visible application or external process is started or stopped.
    $reader.Script = @'
param($Root, $ControlDirectory, $PreferredPid)
try {
    [IO.File]::WriteAllText((Join-Path $ControlDirectory 'cancel-entered'), 'ready')
    while ($true) { Start-Sleep -Milliseconds 50 }
} finally {
    [IO.File]::WriteAllText((Join-Path $ControlDirectory 'cancel-cleaned'), 'done')
}
'@
    if (!(Start-CstStatusRead -Reader $reader -ControlDirectory $testRoot)) { throw 'The cancellation fixture did not start.' }
    Wait-CstStatusCheckpoint -Condition { [IO.File]::Exists((Join-Path $testRoot 'cancel-entered')) } -Description 'cancellation fixture entered'
    Close-CstStatusReader -Reader $reader
    if (!$reader.Closed -or $null -ne $reader.Pending -or ![IO.File]::Exists((Join-Path $testRoot 'cancel-cleaned'))) { throw 'Closing a busy reader did not clean its pending scan.' }
    if ($reader.Runspace.RunspaceStateInfo.State -ne [Management.Automation.Runspaces.RunspaceState]::Closed) { throw 'The private runspace was not closed.' }
    Close-CstStatusReader -Reader $reader
    if ((Start-CstStatusRead -Reader $reader -ControlDirectory $testRoot) -or $null -ne (Receive-CstStatusRead -Reader $reader)) { throw 'A closed reader accepted more work.' }

    $idle = New-CstStatusReader -Script "'unused'"
    try {
        Close-CstStatusReader -Reader $idle
        Close-CstStatusReader -Reader $idle
        if (!$idle.Closed -or $idle.Runspace.RunspaceStateInfo.State -ne [Management.Automation.Runspaces.RunspaceState]::Closed) { throw 'Closing an idle reader did not release its private runspace.' }
    } finally { Close-CstStatusReader -Reader $idle }

    # Exercise the same WinForms message loop/timer arrangement without creating
    # a Form or NotifyIcon. The worker cannot finish until UI ticks release it.
    Add-Type -AssemblyName System.Windows.Forms
    $loopReader = $null; $context = $null; $timer = $null
    $loopState = @{ PendingTicks = 0; Completed = $false; Error = $null; Deadline = [DateTime]::UtcNow.AddSeconds(10) }
    try {
        $loopReader = New-CstStatusReader -Script @'
param($Root, $ControlDirectory, $PreferredPid)
[IO.File]::WriteAllText((Join-Path $ControlDirectory 'loop-entered'), 'ready')
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while (![IO.File]::Exists((Join-Path $ControlDirectory 'loop-release'))) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'UI timer did not release the slow scan.' }
    Start-Sleep -Milliseconds 10
}
[pscustomobject]@{ Healthy = 'message-loop' }
'@
        $context = [Windows.Forms.ApplicationContext]::new()
        $timer = [Windows.Forms.Timer]::new()
        $timer.Interval = 10
        if (!(Start-CstStatusRead -Reader $loopReader -ControlDirectory $testRoot)) { throw 'Message loop fixture did not start.' }
        $timer.add_Tick({
            try {
                if ([DateTime]::UtcNow -ge $loopState.Deadline) { throw 'The hidden message loop did not complete.' }
                $snapshot = Receive-CstStatusRead -Reader $loopReader
                if ($snapshot) {
                    if ($snapshot.Healthy -cne 'message-loop') { throw 'The hidden message loop received the wrong snapshot.' }
                    $loopState.Completed = $true
                    $timer.Stop(); $context.ExitThread()
                    return
                }
                if ([IO.File]::Exists((Join-Path $testRoot 'loop-entered')) -and $loopReader.Pending -and !$loopReader.Pending.IsCompleted) {
                    $loopState.PendingTicks++
                    if ($loopState.PendingTicks -ge 5) {
                        [IO.File]::WriteAllText((Join-Path $testRoot 'loop-release'), 'go')
                    }
                }
            } catch {
                $loopState.Error = $_
                $timer.Stop(); $context.ExitThread()
            }
        })
        $timer.Start()
        [Windows.Forms.Application]::Run($context)
        if ($loopState.Error) { throw $loopState.Error }
        if (!$loopState.Completed -or $loopState.PendingTicks -lt 5) { throw 'A slow scan prevented the UI message loop from processing timer ticks.' }
    } finally {
        if ($timer) { $timer.Stop(); $timer.Dispose() }
        if ($context) { $context.Dispose() }
        if ($loopReader) { Close-CstStatusReader -Reader $loopReader }
    }
} finally {
    if ($reader) { Close-CstStatusReader -Reader $reader }
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ([IO.Path]::GetDirectoryName($resolved).Equals($parent, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^cst-status-reader-test-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
'Background status reader: nonblocking start/poll, single in-flight scan, snapshot arguments, error recovery, idle/busy cleanup and hidden UI message-loop responsiveness passed; no window launched.'
