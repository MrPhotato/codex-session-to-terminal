$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'CST-Presence.ps1')

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('cst-presence-test-' + [Guid]::NewGuid().ToString('N'))
$sessions = Join-Path $testRoot 'sessions'
$now = [DateTime]::Parse('2026-10-19T12:00:00Z').ToUniversalTime()
$threadA = '12345678-1234-4234-9234-123456789abc'
$threadB = '12345678-1234-4234-9234-123456789abd'
function New-PresenceFixture {
    param([hashtable]$Overrides = @{}, [string]$Filename)
    $fixture = [ordered]@{
        schema = 1
        instanceId = [Guid]::NewGuid().ToString('D')
        threadId = $threadA
        pid = 123
        title = 'Current session'
        phase = 'ready'
        activeTurn = $false
        updatedAt = $now.AddSeconds(-1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        openedAt = $now.AddMinutes(-1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    }
    foreach ($key in $Overrides.Keys) { $fixture[$key] = $Overrides[$key] }
    if (!$Filename) { $Filename = $fixture.instanceId + '.json' }
    [IO.File]::WriteAllText((Join-Path $sessions $Filename), ($fixture | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    return $fixture
}
function Clear-PresenceFixtures {
    Get-ChildItem -LiteralPath $sessions -File | Remove-Item -Force
}
function Read-PresenceFixtures {
    @(Get-CstSessionRows -ControlDirectory $testRoot -Now $now -ProcessAlive { param($id) $id -eq 123 })
}
function Assert-Presence {
    param([bool]$Condition, [string]$Message)
    if (!$Condition) { throw $Message }
}
try {
    [void][IO.Directory]::CreateDirectory($sessions)
    Assert-Presence (@(Get-CstSessionRows -ControlDirectory 'relative').Count -eq 0) 'Relative control directory was accepted.'
    Assert-Presence (@(Read-PresenceFixtures).Count -eq 0) 'Empty directory produced a row.'
    [void](New-PresenceFixture @{ activeTurn = $true })
    $rows = @(Read-PresenceFixtures)
    Assert-Presence ($rows.Count -eq 1 -and $rows[0].Phase -ceq 'ready' -and $rows[0].ActiveTurn -and $rows[0].TerminalCount -eq 1) 'Fresh live ready session was not represented.'
    Assert-Presence (($rows[0].PSObject.Properties.Name -join ',') -ceq 'ThreadId,Title,Phase,ActiveTurn,TerminalCount') 'Reader leaked internal fields.'

    foreach ($case in @(
        @{ age = 8; expected = 'ready'; count = 1 },
        @{ age = 8.001; expected = 'disconnected'; count = 1 },
        @{ age = 30; expected = 'disconnected'; count = 1 },
        @{ age = 30.001; expected = ''; count = 0 }
    )) {
        Clear-PresenceFixtures
        [void](New-PresenceFixture @{ updatedAt = $now.AddSeconds(-$case.age).ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); activeTurn = $true })
        $rows = @(Read-PresenceFixtures)
        Assert-Presence ($rows.Count -eq $case.count) "Unexpected presence count at age $($case.age)."
        if ($case.count) {
            Assert-Presence ($rows[0].Phase -ceq $case.expected -and $rows[0].ActiveTurn -eq ($case.expected -ceq 'ready')) "Unexpected stale status at age $($case.age)."
        }
    }

    $invalid = @(
        @{ schema = 2 }, @{ schema = '1' }, @{ schema = 1.5 },
        @{ pid = 0 }, @{ pid = -1 }, @{ pid = '123' }, @{ pid = 1.25 }, @{ pid = 2147483648 }, @{ pid = 124 },
        @{ threadId = 'bad' }, @{ threadId = $null },
        @{ title = 123 }, @{ activeTurn = 'true' }, @{ activeTurn = 1 }, @{ phase = 'READY' }, @{ phase = 'arbitrary' },
        @{ updatedAt = 123 }, @{ openedAt = 'yesterday' }, @{ updatedAt = '2026-02-30T12:00:00Z' },
        @{ updatedAt = $now.AddSeconds(6).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') },
        @{ updatedAt = '2026-10-19T12:00:00+00:00' }, @{ openedAt = '1999-10-19T12:00:00Z' },
        @{ openedAt = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
    )
    foreach ($fields in $invalid) {
        Clear-PresenceFixtures
        [void](New-PresenceFixture $fields)
        Assert-Presence (@(Read-PresenceFixtures).Count -eq 0) ('Invalid presence was accepted: ' + ($fields | ConvertTo-Json -Compress))
    }
    Clear-PresenceFixtures
    [void](New-PresenceFixture @{} 'not-a-guid.json')
    [void](New-PresenceFixture @{} ([Guid]::NewGuid().ToString('D') + '.json'))
    [IO.File]::WriteAllText((Join-Path $sessions ([Guid]::NewGuid().ToString('D') + '.json')), '{broken')
    [IO.File]::WriteAllText((Join-Path $sessions ([Guid]::NewGuid().ToString('D') + '.json')), (' ' * 16385))
    [IO.File]::WriteAllText((Join-Path $sessions ([Guid]::NewGuid().ToString('D') + '.json')), '[]')
    Assert-Presence (@(Read-PresenceFixtures).Count -eq 0) 'Malformed, oversized, or mismatched file was accepted.'

    Clear-PresenceFixtures
    [void](New-PresenceFixture @{ title = "safe`n$([char]0x202e)title" + ([char]::ConvertFromUtf32(0x1F680) * 210); phase = 'syncing' })
    $row = @(Read-PresenceFixtures)[0]
    Assert-Presence ($row.Phase -ceq 'connecting' -and !$row.ActiveTurn) 'Syncing was reported as connected.'
    Assert-Presence ($row.Title.StartsWith('safetitle') -and $row.Title.Length -eq 391 -and ![char]::IsHighSurrogate($row.Title[$row.Title.Length - 1])) 'Unicode title was not sanitized and truncated at 200 code points.'

    Clear-PresenceFixtures
    [void](New-PresenceFixture @{ threadId = $threadB; title = 'Second'; openedAt = $now.AddMinutes(-2).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') })
    [void](New-PresenceFixture @{ title = 'Older title'; phase = 'ready'; activeTurn = $true; updatedAt = $now.AddSeconds(-10).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') })
    [void](New-PresenceFixture @{ title = ''; phase = 'ready'; activeTurn = $false })
    [void](New-PresenceFixture @{ title = 'Newest title'; phase = 'discovering'; updatedAt = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') })
    $rows = @(Read-PresenceFixtures)
    Assert-Presence ($rows.Count -eq 2 -and $rows[0].ThreadId -ceq $threadB -and $rows[1].Title -ceq 'Newest title' -and $rows[1].TerminalCount -eq 3 -and $rows[1].Phase -ceq 'ready' -and !$rows[1].ActiveTurn) 'Grouping, title preference, ordering, or fresh readiness was incorrect.'
    Assert-Presence (@(Get-CstSessionRows -ControlDirectory $testRoot -Now $now -ProcessAlive { throw 'injected process lookup failure' }).Count -eq 0) 'Process lookup error escaped or produced a row.'

    Clear-PresenceFixtures
    $own = New-PresenceFixture @{ pid = $PID }
    Assert-Presence (@(Get-CstSessionRows -ControlDirectory $testRoot -Now $now).Count -eq 1) 'Default process check rejected this live test process.'
    $lockedPath = Join-Path $sessions ($own.instanceId + '.json')
    $lock = [IO.File]::Open($lockedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Assert-Presence (@(Get-CstSessionRows -ControlDirectory $testRoot -Now $now).Count -eq 0) 'Locked file was not ignored.' }
    finally { $lock.Dispose() }
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ([IO.Path]::GetDirectoryName($resolved).Equals($parent, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -match '^cst-presence-test-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
'CST presence: real freshness, process liveness, grouping, safe titles and invalid-file isolation passed.'
