function New-CodexSharedDesktopEnvironment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Config,
        [Parameter(Mandatory)][string]$ConfigFile,
        [Parameter(Mandatory)][Guid]$Generation
    )

    # Start-Process removes an inherited environment variable when its override
    # is null. Do not force a transport globally: Desktop selects its own local,
    # cloud, and remote connections. Only the local CLI launch uses our shim.
    return @{
        CODEX_HOME = $Config.home
        CODEX_CLI_PATH = $Config.shimPath
        CODEX_SHARED_SESSION_CONFIG = $ConfigFile
        CODEX_SHARED_SESSION_GENERATION = $Generation.ToString('D')
        CODEX_APP_SERVER_FORCE_CLI = $null
        CODEX_APP_SERVER_WS_URL = $null
        CODEX_ELECTRON_USER_DATA_PATH = $null
        CODEX_THREAD_ID = $null
        CODEX_SESSION_ID = $null
    }
}
