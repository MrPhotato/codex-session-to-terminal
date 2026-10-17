# The ordinary entry point prepares before launching, without stopping any app.
function Assert-SessionBridgeDesktopClosed {
    param([AllowEmptyCollection()][object[]]$RunningDesktop)
    if ($RunningDesktop.Count -gt 0) {
        throw 'ChatGPT is already running. Finish its current tasks, exit ChatGPT, then open Codex Session to Terminal again. No app was stopped and no connection settings were changed.'
    }
}

function Invoke-SessionBridgeStart {
    param(
        [Parameter(Mandatory)][scriptblock]$GetRunningDesktop,
        [Parameter(Mandatory)][scriptblock]$Prepare,
        [Parameter(Mandatory)][scriptblock]$Launch
    )
    Assert-SessionBridgeDesktopClosed -RunningDesktop @(& $GetRunningDesktop)
    & $Prepare
    & $Launch
}
