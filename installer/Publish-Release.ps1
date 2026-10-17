#requires -Version 7.4
param(
    [Parameter(Mandatory)][ValidatePattern('^v\d+\.\d+\.\d+-preview\.\d+$')][string]$Tag,
    [Parameter(Mandatory)][string]$AssetsDirectory
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true') { throw 'Publication runs only in the release workflow.' }
$repository = $env:GITHUB_REPOSITORY
$version = (Get-Content (Join-Path (Split-Path $PSScriptRoot -Parent) 'package.json') -Raw | ConvertFrom-Json).version
if ($Tag -cne "v$version") { throw 'Tag/package version mismatch.' }
git merge-base --is-ancestor HEAD origin/main
if ($LASTEXITCODE -ne 0) { throw 'Release commit must belong to main.' }
$localCommit = (git rev-parse HEAD).Trim()
$remoteCommit = gh api "repos/$repository/commits/$Tag" --jq .sha
if ($LASTEXITCODE -ne 0 -or $remoteCommit -cne $localCommit) { throw 'Remote tag does not resolve to the tested commit.' }
$files = @(Get-ChildItem -LiteralPath $AssetsDirectory -File)
if ($files.Count -ne 2) { throw 'Expected installer and SHA256 file.' }
$installer = @($files | Where-Object Name -Like '*-setup.exe')
$checksum = @($files | Where-Object Name -Like '*-setup.exe.sha256')
if ($installer.Count -ne 1 -or $checksum.Count -ne 1) { throw 'Unexpected release files.' }
$expected = ((Get-Content $checksum[0].FullName -Raw).Trim() -split '\s+')[0]
if ((Get-FileHash $installer[0].FullName -Algorithm SHA256).Hash -ine $expected) { throw 'Artifact checksum mismatch.' }
# The REST tag endpoint only finds published releases. gh release view also
# resolves drafts, after which the numeric REST endpoint includes asset digests.
$releaseJson = gh release view $Tag --repo $repository --json databaseId,isDraft,tagName 2>$null
$releaseIdentity = if ($LASTEXITCODE -eq 0) { $releaseJson | ConvertFrom-Json } else { $null }
if ($releaseIdentity -and (!$releaseIdentity.isDraft -or $releaseIdentity.tagName -cne $Tag)) { throw 'An existing public release will not be overwritten.' }
if (!$releaseIdentity) {
    gh release create $Tag --verify-tag --draft --prerelease --title "Codex Session to Terminal $Tag" --notes-file (Join-Path $PSScriptRoot 'RELEASE_NOTES.md')
    if ($LASTEXITCODE -ne 0) { throw 'Draft release creation failed.' }
    $releaseJson = gh release view $Tag --repo $repository --json databaseId,isDraft,tagName
    if ($LASTEXITCODE -ne 0) { throw 'Created draft identity readback failed.' }
    $releaseIdentity = $releaseJson | ConvertFrom-Json
}
if (!$releaseIdentity.isDraft -or $releaseIdentity.tagName -cne $Tag -or [long]$releaseIdentity.databaseId -le 0) { throw 'Draft release identity readback failed.' }
$releaseId = [long]$releaseIdentity.databaseId
$release = gh api "repos/$repository/releases/$releaseId" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or !$release.draft -or $release.tag_name -cne $Tag -or $release.id -ne $releaseId) { throw 'Draft release readback failed before upload.' }
gh release upload $Tag @($files.FullName) --clobber
if ($LASTEXITCODE -ne 0) { throw 'Draft asset upload failed; rerun this workflow to recover the draft.' }

function Assert-ReleaseAssets($Release, [bool]$ExpectDraft) {
    if ($Release.id -ne $releaseId -or $Release.draft -ne $ExpectDraft -or !$Release.prerelease -or $Release.tag_name -cne $Tag) { throw 'Release state readback failed.' }
    if (@($Release.assets).Count -ne $files.Count) { throw 'Unexpected release assets.' }
    foreach ($file in $files) {
        $asset = @($Release.assets | Where-Object name -CEQ $file.Name)
        $digest = 'sha256:' + (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($asset.Count -ne 1 -or $asset[0].size -ne $file.Length -or $asset[0].digest -cne $digest -or $asset[0].state -cne 'uploaded') {
            throw "Uploaded asset checksum/readback mismatch: $($file.Name)"
        }
    }
}
$release = gh api "repos/$repository/releases/$releaseId" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Draft release readback failed.' }
Assert-ReleaseAssets $release $true
gh release edit $Tag --draft=false
if ($LASTEXITCODE -ne 0) { throw 'Release publication failed.' }
$release = gh api "repos/$repository/releases/$releaseId" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Published release readback failed.' }
Assert-ReleaseAssets $release $false
$release.html_url
