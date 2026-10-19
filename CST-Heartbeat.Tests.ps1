#requires -Version 7.4
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CST-Panel.ps1')
Initialize-CstPanel

# No forms, tray icons, clipboard listeners, Desktop processes or event pumps
# are created. Blocking this thread simulates a native window move/resize loop.
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('cst-heartbeat-test-' + [Guid]::NewGuid().ToString('N'))
$heartbeat = $null; $recovering = $null
try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    $heartbeatPath = Join-Path $testRoot 'heartbeat'
    $heartbeat = [CodexSessionToTerminal.TrayHeartbeat]::new($testRoot)
    if (!(Test-Path -LiteralPath $heartbeatPath -PathType Leaf)) { throw 'Heartbeat did not start immediately.' }
    $initial = [IO.File]::GetLastWriteTimeUtc($heartbeatPath)
    $initialText = [IO.File]::ReadAllText($heartbeatPath)
    if ($initialText -cnotmatch '^\d{4}-\d{2}-\d{2}T.*Z$') { throw 'Heartbeat did not use UTC.' }

    $failed = $false
    try { [CodexSessionToTerminal.TrayHeartbeat]::new('relative') | Out-Null } catch { $failed = $true }
    if (!$failed) { throw 'Relative heartbeat directory was accepted.' }
    # A transient missing directory must not crash a background timer callback.
    $recoveringDirectory = Join-Path $testRoot 'recovering'
    $recovering = [CodexSessionToTerminal.TrayHeartbeat]::new($recoveringDirectory)
    if (Test-Path -LiteralPath $recoveringDirectory) { throw 'Heartbeat unexpectedly created another directory.' }
    [void][IO.Directory]::CreateDirectory($recoveringDirectory)

    [Threading.Thread]::Sleep(2300)
    $latest = [IO.File]::GetLastWriteTimeUtc($heartbeatPath)
    if ($latest -le $initial -or [IO.File]::ReadAllText($heartbeatPath) -ceq $initialText) { throw 'Heartbeat stalled while the UI thread was blocked.' }
    if (([DateTime]::UtcNow - $latest).TotalSeconds -ge 8) { throw 'Terminal lease would incorrectly expire while the UI thread was blocked.' }
    if (!(Test-Path -LiteralPath (Join-Path $recoveringDirectory 'heartbeat') -PathType Leaf)) { throw 'Heartbeat did not recover from a transient directory failure.' }

    $heartbeat.Dispose(); $recovering.Dispose()
    $stopped = [IO.File]::GetLastWriteTimeUtc($heartbeatPath)
    $recoveredStopped = [IO.File]::GetLastWriteTimeUtc((Join-Path $recoveringDirectory 'heartbeat'))
    [Threading.Thread]::Sleep(2300)
    if ([IO.File]::GetLastWriteTimeUtc($heartbeatPath) -ne $stopped -or
        [IO.File]::GetLastWriteTimeUtc((Join-Path $recoveringDirectory 'heartbeat')) -ne $recoveredStopped) { throw 'Disposed heartbeat continued writing.' }
    # Dispose is safe from both normal exit and a finally cleanup path.
    $heartbeat.Dispose(); $recovering.Dispose()
} finally {
    if ($heartbeat) { $heartbeat.Dispose() }
    if ($recovering) { $recovering.Dispose() }
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ([IO.Path]::GetDirectoryName($resolved).Equals($parent, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolved) -match '^cst-heartbeat-test-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
'CST heartbeat: updates during blocked UI, transient failure recovery and synchronized disposal passed; no UI launched.'
