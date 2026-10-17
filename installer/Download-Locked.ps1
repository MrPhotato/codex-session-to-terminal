# Build-time downloads only. Hashes are reviewed and committed with the source.
function Get-LockedDownload {
    param([Parameter(Mandatory)]$Entry, [Parameter(Mandatory)][string]$CacheDirectory)
    $cache = [IO.Path]::GetFullPath($CacheDirectory)
    [void](New-Item -ItemType Directory -Path $cache -Force)
    if ([IO.Path]::GetFileName($Entry.file) -cne $Entry.file) { throw 'Download filename must be a leaf name.' }
    $destination = Join-Path $cache $Entry.file
    if (!(Test-Path -LiteralPath $destination -PathType Leaf)) {
        $temporary = $destination + '.partial'
        Invoke-WebRequest -Uri $Entry.url -OutFile $temporary -MaximumRetryCount 3 -RetryIntervalSec 3
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ine $Entry.sha256) {
            throw "SHA256 mismatch for $($Entry.file); the download will not be used."
        }
        Move-Item -LiteralPath $temporary -Destination $destination
    }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ine $Entry.sha256) {
        throw "SHA256 mismatch for cached $($Entry.file)."
    }
    return $destination
}
