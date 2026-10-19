#requires -Version 7.4
param(
    [ValidateSet('Start','Prepare','Launch','Check','Status','OpenCli','StopShortcut')]
    [string]$Action = 'Status',
    [string]$ThreadId
)
$ErrorActionPreference = 'Stop'
if (!$IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'This release supports Windows x64 only.' }
$privateRoot = Join-Path $env:LOCALAPPDATA 'SessionBridge'
$configFile = Join-Path $privateRoot 'config.json'
$launchFile = Join-Path $privateRoot 'desktop.json'
$expectedClientCli = '0.163.0-alpha.10.2'
$pwshPath = Join-Path $PSHOME 'pwsh.exe'
. (Join-Path $PSScriptRoot 'Launcher-Environment.ps1')
. (Join-Path $PSScriptRoot 'Discovery.ps1')
. (Join-Path $PSScriptRoot 'Start-Flow.ps1')
. (Join-Path $PSScriptRoot 'Dependencies.ps1')

function Read-PrivateConfig {
    if (!(Test-Path -LiteralPath $configFile)) { throw 'Run Prepare first.' }
    Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json -AsHashtable
}
function Test-OwnedProcess($record) {
    if (!$record) { return $false }
    $process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    return $process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.startedTicks
}
function Get-DesktopRecord {
    if (Test-Path -LiteralPath $launchFile) { Get-Content -LiteralPath $launchFile -Raw | ConvertFrom-Json -AsHashtable }
}
function Get-NormalDesktop {
    @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object {
        # An unreadable command line is not proof that no main process exists.
        !$_.CommandLine -or $_.CommandLine -notmatch '--type='
    })
}
function Get-Port {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
function Get-CurrentPackage {
    $package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
    if (!$package) { throw 'ChatGPT Desktop is not installed for this Windows user.' }
    if (!(Test-Path -LiteralPath (Join-Path $package.InstallLocation 'app\ChatGPT.exe') -PathType Leaf)) { throw 'The installed Desktop package has an unsupported application layout.' }
    $package
}
function Get-CurrentCompatibility {
    $package = Get-CurrentPackage
    $realCli = Get-SessionBridgeInstalledCli -PackageInstallLocation $package.InstallLocation
    $fullCli = Join-Path $PSScriptRoot 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
    $backend = Assert-SessionBridgeCliCapabilities -Path $realCli -Role Backend
    $client = Assert-SessionBridgeCliCapabilities -Path $fullCli -Role Client
    @{ Package=$package; Backend=$backend; Client=$client }
}
function Native-Args($values) {
    @($values | ForEach-Object { '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' })
}

switch ($Action) {
    'Start' {
        $launcherScript = $PSCommandPath
        Invoke-SessionBridgeStart -GetRunningDesktop { Get-NormalDesktop } `
            -Prepare {
                [void](Get-CurrentPackage)
                Initialize-SessionBridgeDependencies `
                    -TestReady { Test-SessionBridgeDependencies -ApplicationRoot $PSScriptRoot -ExpectedCliVersion $expectedClientCli } `
                    -Install { Install-SessionBridgeDependencies -ApplicationRoot $PSScriptRoot -NodePath (Get-SessionBridgeNode) }
            } `
            -Launch { & $launcherScript -Action Launch }
    }
    'Check' {
        $compatibility = Get-CurrentCompatibility
        [pscustomobject]@{
            compatible=$true; desktopVersion=$compatibility.Package.Version.ToString()
            backendVersion=$compatibility.Backend.Version; clientVersion=$compatibility.Client.Version
            backendPath=$compatibility.Backend.Path; clientPath=$compatibility.Client.Path
            checks=@('backend-websocket-options','client-remote-options')
            protocolVerified=$false
        } | ConvertTo-Json -Depth 3
    }
    'Prepare' {
        Assert-SessionBridgeDesktopClosed -RunningDesktop @(Get-NormalDesktop)
        if (Test-OwnedProcess (Get-DesktopRecord)) { throw 'The shared Desktop is still running; its launcher and connection settings will not be changed.' }
        $compatibility = Get-CurrentCompatibility
        $package = $compatibility.Package
        $realCli = $compatibility.Backend.Path
        $nodePath = Get-SessionBridgeNode
        $fullCli = $compatibility.Client.Path
        # Recheck after the bounded probes, before touching any live settings.
        Assert-SessionBridgeDesktopClosed -RunningDesktop @(Get-NormalDesktop)
        [void](New-Item -ItemType Directory -Path $privateRoot -Force)
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        & icacls.exe $privateRoot '/inheritance:r' '/grant:r' ('*'+$sid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not protect the local connection settings.' }
        $bin = Join-Path $privateRoot 'bin'
        [void](New-Item -ItemType Directory -Path $bin -Force)
        $shim = & (Join-Path $PSScriptRoot 'Build-Shim.ps1') -RealCliPath $realCli -OutputDirectory $bin
        if (!(Test-Path -LiteralPath $configFile)) {
            $tokenFile = Join-Path $privateRoot 'connection.token'
            [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) | Set-Content -LiteralPath $tokenFile -NoNewline
            @{
                schemaVersion=1; root=$privateRoot; home=(Join-Path $env:USERPROFILE '.codex')
                realCliPath=$realCli; cliPath=$fullCli; nodePath=$nodePath
                shimPath=$shim; bridgePath=(Join-Path $PSScriptRoot 'bridge-shim.mjs')
                desktopPath=(Join-Path $package.InstallLocation 'app\ChatGPT.exe')
                backendPort=(Get-Port); backendTokenFile=$tokenFile
                runtimeFile=(Join-Path $privateRoot 'runtime.json'); interceptOriginator='Codex Desktop'
                desktopVersion=$package.Version.ToString(); cliVersion=$compatibility.Client.Version
                backendVersion=$compatibility.Backend.Version
            } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configFile -Encoding utf8
        } else {
            $config = Read-PrivateConfig
            $backup = Join-Path $privateRoot ('config.before-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmssfff') + '.json')
            Copy-Item -LiteralPath $configFile -Destination $backup
            $config.realCliPath = $realCli
            $config.cliPath = $fullCli
            $config.nodePath = $nodePath
            $config.shimPath = $shim
            $config.bridgePath = Join-Path $PSScriptRoot 'bridge-shim.mjs'
            $config.desktopPath = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
            $config.desktopVersion = $package.Version.ToString()
            $config.cliVersion = $compatibility.Client.Version
            $config.backendVersion = $compatibility.Backend.Version
            $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configFile -Encoding utf8
        }
        Write-Output 'Prepared. The running Desktop, normal profile, and system launch settings have not changed.'
    }
    'Launch' {
        Assert-SessionBridgeDesktopClosed -RunningDesktop @(Get-NormalDesktop)
        # Daily Desktop updates may move both executables. Refresh the paths and
        # the native forwarding fallback after verifying capabilities each time.
        & $PSCommandPath -Action Prepare
        Assert-SessionBridgeDesktopClosed -RunningDesktop @(Get-NormalDesktop)
        $config = Read-PrivateConfig
        $stopFlag = Join-Path $privateRoot 'stop.flag'
        if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag }
        $generation = [Guid]::NewGuid().ToString()
        # Use the normal profile and history. Do not pass --user-data-dir or a profile override.
        $environment = New-CodexSharedDesktopEnvironment -Config $config -ConfigFile $configFile -Generation $generation
        $desktop = Start-Process -FilePath $config.desktopPath -WorkingDirectory $env:USERPROFILE -WindowStyle Hidden -Environment $environment -PassThru
        $record = @{pid=$desktop.Id; startedTicks=$desktop.StartTime.ToUniversalTime().Ticks.ToString(); generation=$generation}
        $record | ConvertTo-Json | Set-Content -LiteralPath $launchFile -Encoding utf8
        $healthOutput = & $config.nodePath (Join-Path $PSScriptRoot 'check-startup.mjs') --config $configFile --generation $generation --timeout-ms 60000
        if ($LASTEXITCODE -ne 0) { throw 'The shared connection did not become ready. Desktop has been left running; the shortcut listener was not started.' }
        $watchArgs = @('-NoProfile','-STA','-File',(Join-Path $PSScriptRoot 'Watch-Chat-Link.ps1'),'-DesktopPid',$record.pid.ToString(),'-DesktopStartTicks',$record.startedTicks,'-ControlDirectory',$privateRoot)
        $watcher = Start-Process -FilePath $pwshPath -ArgumentList (Native-Args $watchArgs) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
        @{pid=$watcher.Id; startedTicks=$watcher.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $privateRoot 'watcher.json') -Encoding utf8
        Write-Output 'Opened the normal ChatGPT profile. In a local chat, Ctrl+Alt+L opens that chat in a separate terminal once the shared backend is ready.'
    }
    'Status' {
        $config = Read-PrivateConfig
        $record = Get-DesktopRecord
        $desktopAlive = Test-OwnedProcess $record
        $watcherFile = Join-Path $privateRoot 'watcher.json'
        $watcherRecord = if (Test-Path -LiteralPath $watcherFile) { Get-Content -LiteralPath $watcherFile -Raw | ConvertFrom-Json -AsHashtable }
        $watcherAlive = Test-OwnedProcess $watcherRecord
        $runtimeExists = Test-Path -LiteralPath $config.runtimeFile
        [pscustomobject]@{prepared=$true; normalDesktopStartedByLauncher=$desktopAlive; runtimeStatePresent=$runtimeExists; shortcutEnabled=($desktopAlive -and $watcherAlive -and !(Test-Path -LiteralPath (Join-Path $privateRoot 'stop.flag'))); desktopVersion=$config.desktopVersion} | ConvertTo-Json
    }
    'OpenCli' {
        $config = Read-PrivateConfig
        if (!$ThreadId) {
            . (Join-Path $PSScriptRoot 'Thread-Link.ps1')
            $parsed = ConvertFrom-CodexLocalThreadLink -Text (Get-Clipboard -Raw)
            if (!$parsed) { throw 'Copy the current local chat link in ChatGPT with Ctrl+Alt+L first.' }
            $ThreadId = $parsed.ToString()
        }
        $threadGuid = [Guid]::Empty
        if (![Guid]::TryParseExact($ThreadId,'D',[ref]$threadGuid)) { throw 'Invalid local chat ID.' }
        if (!(Test-OwnedProcess (Get-DesktopRecord))) { throw 'The normal Desktop is not running in shared mode. Finish active tasks, exit it, and use the shared launcher.' }
        & $config.nodePath (Join-Path $PSScriptRoot 'check-live.mjs') --config $configFile --thread $threadGuid.ToString()
        if ($LASTEXITCODE -ne 0) { throw 'The shared backend is not ready for this chat; no second agent was started.' }
        $psi = [Diagnostics.ProcessStartInfo]::new($config.cliPath)
        $psi.UseShellExecute = $false
        $psi.WorkingDirectory = $env:USERPROFILE
        $psi.Environment['CODEX_HOME'] = $config.home
        $psi.Environment['CODEX_CLI_PATH'] = $config.realCliPath
        $psi.Environment['CODEX_SHARED_SESSION_TOKEN'] = (Get-Content -LiteralPath $config.backendTokenFile -Raw).Trim()
        [void]$psi.Environment.Remove('CODEX_THREAD_ID')
        [void]$psi.Environment.Remove('CODEX_SESSION_ID')
        $psi.Environment['TERM'] = 'xterm-256color'
        foreach ($arg in @('--remote',('ws://127.0.0.1:'+$config.backendPort),'--remote-auth-token-env','CODEX_SHARED_SESSION_TOKEN','resume',$threadGuid.ToString())) { $psi.ArgumentList.Add($arg) }
        $cli = [Diagnostics.Process]::Start($psi)
        $cli.WaitForExit()
        exit $cli.ExitCode
    }
    'StopShortcut' {
        [void](New-Item -ItemType File -Path (Join-Path $privateRoot 'stop.flag') -Force)
        Write-Output 'Shortcut listener stopped. Existing chats and terminals continue running.'
    }
}
