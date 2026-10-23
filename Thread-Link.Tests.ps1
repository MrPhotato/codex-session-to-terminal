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
    ($localLink + '?hostId=durable')
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

$nativeAccepted = @(
    @{ Text = $localLink; HostId = 'local' }
    @{ Text = ('codex://threads/' + $testThreadId.ToUpperInvariant()); HostId = 'local' }
    @{ Text = ($localLink + '?hostId=local'); HostId = 'local' }
    @{ Text = ($localLink + '?hostId=durable'); HostId = 'durable' }
    @{ Text = ('codex://threads/' + $testThreadId.ToUpperInvariant() + '?hostId=durable'); HostId = 'durable' }
)
foreach ($testCase in $nativeAccepted) {
    $parsed = ConvertFrom-CodexThreadLink -Text $testCase.Text
    if ($parsed -isnot [pscustomobject] -or $parsed.ThreadId -isnot [Guid] -or
        $parsed.ThreadId.ToString('D') -cne $testThreadId -or $parsed.HostId -cne $testCase.HostId -or
        @($parsed.PSObject.Properties).Count -ne 2) {
        throw 'A supported native thread link did not preserve its exact thread and host identity.'
    }
}

$nativeRejected = @($rejected | Where-Object { $_ -isnot [string] -or $_ -cne ($localLink + '?hostId=durable') }) + @(
    ($localLink + '?hostId=DURABLE')
    ($localLink + '?hostId=%64urable')
    ($localLink + '?hostId=durable&hostId=local')
    ($localLink + '?hostId=local&hostId=durable')
    ($localLink + '?hostId=durable&view=review')
    ($localLink + '?hostId=durable&threadAccess=shared')
    ($localLink + '?hostId=durable#fragment')
    ($localLink + '?hostId=durable ')
    ($localLink + '?hostId=durable' + "`n")
    ($localLink + '?hostId=durable' + [char]0)
    ('https://chatgpt.com/c/' + $testThreadId)
    'codex://threads/00000000-0000-0000-0000-000000000000'
    'codex://threads/00000000-0000-0000-0000-000000000000?hostId=local'
    'codex://threads/00000000-0000-0000-0000-000000000000?hostId=durable'
)
foreach ($testInput in $nativeRejected) {
    if ($null -ne (ConvertFrom-CodexThreadLink -Text $testInput)) {
        throw 'Unsupported input was accepted as a native thread link.'
    }
}

# Keep the old shared-launcher parser's return type and acceptance unchanged.
if ((ConvertFrom-CodexLocalThreadLink -Text 'codex://threads/00000000-0000-0000-0000-000000000000') -ne [Guid]::Empty -or
    $null -ne (ConvertFrom-CodexLocalThreadLink -Text ($localLink + '?hostId=durable'))) {
    throw 'The legacy local parser changed its compatibility behavior.'
}

'Native thread link parser: {0} accepted cases and {1} rejected cases passed; legacy local-only behavior preserved.' -f $nativeAccepted.Count, $nativeRejected.Count
