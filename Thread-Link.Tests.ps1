$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Thread-Link.ps1')

$testThreadId = '12345678-1234-4234-9234-123456789abc'
$localLink = 'codex://threads/' + $testThreadId
$accepted = @(
    $localLink
    ('codex://threads/' + $testThreadId.ToUpperInvariant())
    ($localLink + '?hostId=local')
)

foreach ($testInput in $accepted) {
    $parsed = ConvertFrom-CodexLocalThreadLink -Text $testInput
    if ($parsed -isnot [Guid] -or $parsed.ToString('D') -cne $testThreadId) {
        throw 'A supported local thread link did not produce the expected GUID.'
    }
}

$rejected = @(
    $null
    ''
    42
    ,@($localLink, $localLink)
    @{ text = $localLink }
    (' ' + $localLink)
    ($localLink + ' ')
    ($localLink + "`n")
    ($localLink + "`r`n")
    ($localLink + [char]0)
    ('Open this chat: ' + $localLink)
    ('<' + $localLink + '>')
    ('[chat](' + $localLink + ')')
    ($localLink + '/extra')
    ($localLink + '/')
    ($localLink + '?hostId=remote')
    ($localLink + '?hostId=LOCAL')
    ($localLink + '?hostId=%6cocal')
    ($localLink + '?hostId=local&hostId=remote')
    ($localLink + '?hostId=local&view=review')
    ($localLink + '?view=review')
    ($localLink + '?prompt=hello')
    ($localLink + '#fragment')
    ($localLink + '; whoami')
    ('CODEX://threads/' + $testThreadId)
    ('codex://Threads/' + $testThreadId)
    ('codex://threads:80/' + $testThreadId)
    ('codex://user@threads/' + $testThreadId)
    ('codex://threads.evil/' + $testThreadId)
    ('codex://threads/%30' + $testThreadId.Substring(1))
    ('codex://threads/../threads/' + $testThreadId)
    ('https://threads/' + $testThreadId)
    ('codex:\\threads\' + $testThreadId)
    ('codex://threads/{' + $testThreadId + '}')
    ('codex://threads/' + $testThreadId.Replace('-', ''))
    'codex://threads/new'
    'codex://threads/12345678-1234-4234-9234-123456789abz'
    ('x' * 100000)
)

foreach ($testInput in $rejected) {
    $parsed = ConvertFrom-CodexLocalThreadLink -Text $testInput
    if ($null -ne $parsed) {
        throw 'Unsupported input was accepted as a thread link.'
    }
}

'Thread link parser: {0} accepted cases and {1} rejected cases passed.' -f $accepted.Count, $rejected.Count
