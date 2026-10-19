function Get-CstSessionRows {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ControlDirectory,
        [DateTime]$Now = [DateTime]::UtcNow,
        [scriptblock]$ProcessAlive = {
            param([int]$ProcessId)
            $process = $null
            try {
                $process = [Diagnostics.Process]::GetProcessById($ProcessId)
                return !$process.HasExited
            } catch { return $false }
            finally { if ($process) { $process.Dispose() } }
        }
    )

    # Presence is disposable metadata. Unreadable or invalid files must never
    # prevent the tray from running or expose other fields from a chat payload.
    if (![IO.Path]::IsPathRooted($ControlDirectory)) { return }
    try {
        $directory = [IO.DirectoryInfo]::new((Join-Path $ControlDirectory 'sessions'))
        if (!$directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
        $files = $directory.GetFiles('*.json', [IO.SearchOption]::TopDirectoryOnly)
    } catch { return }
    $utcNow = $Now.ToUniversalTime()
    $dateParameters = @{}
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $dateParameters.DateKind = 'String' }
    $records = [Collections.Generic.List[object]]::new()
    $processCache = @{}
    $phases = @('idle', 'connecting', 'initializing', 'discovering', 'syncing', 'owner-unavailable', 'ready', 'disconnected', 'closed')
    $progressPhases = @('idle', 'connecting', 'initializing', 'discovering', 'syncing')
    $datePattern = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$'
    foreach ($file in $files) {
        try {
            $fileId = [Guid]::Empty
            if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 16384 -or $file.Length -eq 0 -or ![Guid]::TryParseExact($file.BaseName, 'D', [ref]$fileId)) { continue }
            # Bound the read itself as well as the initial length check: an
            # unrelated writer could replace a file between those operations.
            $stream = $null
            try {
                $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
                $buffer = [byte[]]::new(16385)
                $length = 0
                while ($length -lt $buffer.Length) {
                    $read = $stream.Read($buffer, $length, $buffer.Length - $length)
                    if (!$read) { break }
                    $length += $read
                }
            } finally { if ($stream) { $stream.Dispose() } }
            if (!$length -or $length -gt 16384) { continue }
            $json = [Text.UTF8Encoding]::new($false, $true).GetString($buffer, 0, $length).TrimStart([char]0xFEFF)
            if (!$json.TrimStart().StartsWith('{')) { continue }
            $record = ConvertFrom-Json -InputObject $json @dateParameters -ErrorAction Stop
            if ($record -isnot [pscustomobject]) { continue }
            if (($record.schema -isnot [long] -and $record.schema -isnot [int]) -or $record.schema -ne 1) { continue }
            if ($record.instanceId -isnot [string] -or $record.threadId -isnot [string]) { continue }
            $instanceId = [Guid]::Empty; $threadId = [Guid]::Empty
            if (![Guid]::TryParseExact($record.instanceId, 'D', [ref]$instanceId) -or $instanceId -ne $fileId -or ![Guid]::TryParseExact($record.threadId, 'D', [ref]$threadId)) { continue }
            if (($record.pid -isnot [long] -and $record.pid -isnot [int]) -or $record.pid -le 0 -or $record.pid -gt [int]::MaxValue) { continue }
            if ($record.title -isnot [string] -or $record.phase -isnot [string] -or $phases -cnotcontains $record.phase -or $record.activeTurn -isnot [bool]) { continue }
            if ($record.updatedAt -isnot [string] -or $record.openedAt -isnot [string] -or $record.updatedAt -cnotmatch $datePattern -or $record.openedAt -cnotmatch $datePattern) { continue }
            $updated = [DateTimeOffset]::MinValue; $opened = [DateTimeOffset]::MinValue
            $dateStyle = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
            if (![DateTimeOffset]::TryParse($record.updatedAt, [Globalization.CultureInfo]::InvariantCulture, $dateStyle, [ref]$updated) -or ![DateTimeOffset]::TryParse($record.openedAt, [Globalization.CultureInfo]::InvariantCulture, $dateStyle, [ref]$opened)) { continue }
            if ($opened.Year -lt 2000 -or $opened -gt $updated -or $updated.UtcDateTime -gt $utcNow.AddSeconds(5)) { continue }
            $age = ($utcNow - $updated.UtcDateTime).TotalSeconds
            if ($age -gt 30) { continue }
            $processId = [int]$record.pid
            if (!$processCache.ContainsKey($processId)) {
                $alive = & $ProcessAlive $processId
                $processCache[$processId] = $alive -is [bool] -and $alive
            }
            if (!$processCache[$processId]) { continue }
            $plainTitle = [regex]::Replace($record.title, '[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]', '').Trim()
            $title = [Text.StringBuilder]::new()
            $points = 0
            for ($index = 0; $index -lt $plainTitle.Length -and $points -lt 200; $index++) {
                $character = $plainTitle[$index]
                if ([char]::IsHighSurrogate($character)) {
                    if ($index + 1 -ge $plainTitle.Length -or ![char]::IsLowSurrogate($plainTitle[$index + 1])) { continue }
                    [void]$title.Append($character).Append($plainTitle[++$index])
                } elseif ([char]::IsLowSurrogate($character)) { continue }
                else { [void]$title.Append($character) }
                $points++
            }
            $records.Add([pscustomobject]@{
                ThreadId = $threadId.ToString('D')
                Title = $title.ToString()
                Phase = $(if ($age -le 8) { $record.phase } else { 'disconnected' })
                ActiveTurn = $age -le 8 -and $record.phase -ceq 'ready' -and $record.activeTurn
                UpdatedAt = $updated.UtcDateTime
                OpenedAt = $opened.UtcDateTime
                InstanceId = $instanceId.ToString('D')
            })
        } catch { continue }
    }
    $rows = foreach ($group in ($records | Group-Object ThreadId)) {
        $ordered = @($group.Group | Sort-Object UpdatedAt, InstanceId -Descending)
        $ready = @($ordered | Where-Object Phase -CEQ 'ready')
        $progress = @($ordered | Where-Object { $progressPhases -ccontains $_.Phase })
        $latestTitle = $ordered | Where-Object { ![string]::IsNullOrWhiteSpace($_.Title) } | Select-Object -First 1
        [pscustomobject]@{
            ThreadId = $group.Name
            Title = $(if ($latestTitle) { $latestTitle.Title } else { '' })
            Phase = $(if ($ready.Count) { 'ready' } elseif ($progress.Count) { 'connecting' } else { 'disconnected' })
            ActiveTurn = @($ready | Where-Object ActiveTurn).Count -gt 0
            TerminalCount = $ordered.Count
            OpenedAt = ($ordered | Sort-Object OpenedAt | Select-Object -First 1).OpenedAt
        }
    }
    $rows | Sort-Object OpenedAt, ThreadId | Select-Object ThreadId, Title, Phase, ActiveTurn, TerminalCount
}
