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
