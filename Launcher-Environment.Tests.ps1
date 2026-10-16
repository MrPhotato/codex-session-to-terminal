$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Launcher-Environment.ps1')

# Pure regression tests: no environment changes, files, processes, or services.
$config = @{
    home = 'C:\Users\Example\.codex'
    shimPath = 'C:\Tools With Spaces\CodexSharedShim.exe'
    desktopPath = 'C:\Program Files\WindowsApps\Example\ChatGPT.exe'
    cloudSettings = @{ hostId = 'durable'; connection = 'managed-cloud' }
    backendPort = 54321
}
$configFile = 'C:\Users\Example\AppData\Local\SessionBridge\config.json'
$generation = [Guid]'12345678-1234-4234-9234-123456789abc'
$beforeConfig = $config | ConvertTo-Json -Depth 5 -Compress
$environment = New-CodexSharedDesktopEnvironment -Config $config -ConfigFile $configFile -Generation $generation

foreach ($entry in @{
    CODEX_HOME = $config.home
    CODEX_CLI_PATH = $config.shimPath
    CODEX_SHARED_SESSION_CONFIG = $configFile
    CODEX_SHARED_SESSION_GENERATION = $generation.ToString('D')
}.GetEnumerator()) {
    if ($environment[$entry.Key] -cne $entry.Value) { throw "Incorrect launcher value: $($entry.Key)" }
}

# Presence with null is intentional: omission would leave a stale inherited
# FORCE_CLI=1 active, and the string '0' is not a reliable way to remove it.
foreach ($key in @('CODEX_APP_SERVER_FORCE_CLI', 'CODEX_APP_SERVER_WS_URL', 'CODEX_ELECTRON_USER_DATA_PATH', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID')) {
    if (!$environment.ContainsKey($key) -or $null -ne $environment[$key]) {
        throw "The inherited override must be explicitly removed: $key"
    }
}

# Model Start-Process's environment overlay without changing this process.
# Existing cloud/remote settings must survive; no cloud host is rewritten local.
$inherited = @{
    CODEX_APP_SERVER_FORCE_CLI = '1'
    CODEX_APP_SERVER_WS_URL = 'ws://127.0.0.1:12345/old-test'
    CODEX_ELECTRON_USER_DATA_PATH = 'C:\Old Test Profile'
    CODEX_HOME = 'C:\Old Test Home'
    CLOUD_CONNECTION_SENTINEL = 'managed-cloud'
    REMOTE_CONNECTION_SENTINEL = 'ssh-existing-host'
}
$effective = $inherited.Clone()
foreach ($entry in $environment.GetEnumerator()) {
    if ($null -eq $entry.Value) { $effective.Remove($entry.Key) }
    else { $effective[$entry.Key] = $entry.Value }
}
if ($effective.ContainsKey('CODEX_APP_SERVER_FORCE_CLI') -or $effective.ContainsKey('CODEX_APP_SERVER_WS_URL')) {
    throw 'A stale global transport override survived the environment overlay.'
}
if ($effective.CLOUD_CONNECTION_SENTINEL -cne 'managed-cloud' -or $effective.REMOTE_CONNECTION_SENTINEL -cne 'ssh-existing-host') {
    throw 'Unrelated cloud or remote connection settings were rewritten.'
}
if (($config | ConvertTo-Json -Depth 5 -Compress) -cne $beforeConfig) { throw 'The launcher modified the supplied configuration.' }
if ($inherited.CODEX_APP_SERVER_FORCE_CLI -cne '1') { throw 'The launcher modified the inherited-environment test input.' }

$second = New-CodexSharedDesktopEnvironment -Config $config -ConfigFile $configFile -Generation $generation
$environment.CODEX_HOME = 'changed-only-in-first-result'
if ($second.CODEX_HOME -cne $config.home) { throw 'Environment results share mutable state.' }

'Launcher environment regression checks passed: inherited transport overrides removed; normal home and shim retained; unrelated cloud/remote settings unchanged.'
