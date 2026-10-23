function ConvertFrom-CodexLocalThreadLink {
    <#
    .SYNOPSIS
    Parse an exact local Codex thread link without retaining its source text.
    .OUTPUTS
    System.Guid for a supported link; no output for any other input.
    #>
    [CmdletBinding()]
    param([AllowNull()][object]$Text)

    # Do not trim, decode, or use URI normalization: clipboard prose, remote
    # hosts, encoded delimiters, and trailing commands must never become input.
    if ($Text -isnot [string] -or $Text.Length -gt 65) { return }
    $match = [regex]::Match(
        $Text,
        '\Acodex://threads/(?<thread>[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})(?:\?hostId=local)?\z',
        [Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
    if (!$match.Success) { return }

    $threadGuid = [Guid]::Empty
    if ([Guid]::TryParseExact($match.Groups['thread'].Value, 'D', [ref]$threadGuid)) {
        return $threadGuid
    }
}

function ConvertFrom-CodexThreadLink {
    <#
    .SYNOPSIS
    Parse an exact native local or durable Codex thread link.
    .OUTPUTS
    A thread GUID and literal host identity; no output for unsupported input.
    #>
    [CmdletBinding()]
    param([AllowNull()][object]$Text)

    # Native durable links carry their host explicitly. Never normalize other
    # URLs or treat a ChatGPT frontend conversation ID as a native thread ID.
    if ($Text -isnot [string] -or $Text.Length -gt 67) { return }
    $match = [regex]::Match(
        $Text,
        '\Acodex://threads/(?<thread>[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})(?:\?hostId=(?<host>local|durable))?\z',
        [Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
    if (!$match.Success) { return }

    $threadGuid = [Guid]::Empty
    if (![Guid]::TryParseExact($match.Groups['thread'].Value, 'D', [ref]$threadGuid) -or $threadGuid -eq [Guid]::Empty) { return }
    $hostId = if ($match.Groups['host'].Success) { $match.Groups['host'].Value } else { 'local' }
    [pscustomobject]@{ ThreadId = $threadGuid; HostId = $hostId }
}
