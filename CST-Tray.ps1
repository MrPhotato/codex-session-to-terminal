#requires -Version 7.4
[CmdletBinding()]
param([string]$NodePath, [switch]$DefinitionsOnly)
$ErrorActionPreference = 'Stop'

function Get-CstClipboardListenerSource {
    param([Parameter(Mandatory)][string]$Path)
    # Reuse the legacy watcher's audited native listener, without executing that
    # script or its shared-launcher flow. Accept only its literal source assignment.
    $parseErrors = $null; $tokens = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw 'The clipboard listener source cannot be parsed.' }
    $assignments = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
        $node.Left.VariablePath.UserPath -ceq 'nativeSource'
    }, $false))
    if ($assignments.Count -ne 1) { throw 'The clipboard listener source has changed.' }
    $expression = $assignments[0].Right.Expression
    if ($expression -isnot [Management.Automation.Language.StringConstantExpressionAst]) { throw 'The clipboard listener must be a literal string.' }
    $value = $expression.Value
    if ($value -isnot [string] -or !$value.Contains('public sealed class ClipboardLinkListener')) { throw 'The clipboard listener source is unavailable.' }
    return $value
}

function Select-CstDesktopProcess {
    param([object[]]$Processes, [string[]]$PackageLocations, [int]$PreferredPid = 0, [uint32]$ForegroundPid = 0)
    $paths = @($PackageLocations | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $_ 'app\ChatGPT.exe')) })
    $eligible = @(foreach ($candidate in $Processes) {
        if ($candidate.Id -le 0 -or $candidate.StartTicks -le 0 -or $candidate.WindowHandle -eq 0 -or !$candidate.Path) { continue }
        foreach ($path in $paths) {
            if ($path.Equals([string]$candidate.Path, [StringComparison]::OrdinalIgnoreCase)) { $candidate; break }
        }
    })
    # Explicit comparisons avoid trusting a matching executable name alone.
    foreach ($preferred in @([int]$ForegroundPid, $PreferredPid)) {
        $match = $eligible | Where-Object Id -eq $preferred | Select-Object -First 1
        if ($match) { return $match }
    }
    return $eligible | Sort-Object StartTicks -Descending | Select-Object -First 1
}

function Get-CstRunningDesktop {
    param([int]$PreferredPid = 0)
    $locations = @(Get-AppxPackage -Name OpenAI.Codex -ErrorAction Stop | ForEach-Object InstallLocation)
    $records = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | ForEach-Object {
        try { [pscustomobject]@{ Id = $_.Id; StartTicks = $_.StartTime.ToUniversalTime().Ticks; WindowHandle = $_.MainWindowHandle.ToInt64(); Path = $_.Path } } catch { }
    })
    $selected = Select-CstDesktopProcess -Processes $records -PackageLocations $locations -PreferredPid $PreferredPid -ForegroundPid ([CodexSharedSession.ClipboardLinkListener]::ForegroundProcessId())
    if ($selected) {
        $backendPath = Join-Path ([IO.Path]::GetDirectoryName($selected.Path)) 'resources\codex.exe'
        if (!(Test-Path -LiteralPath $backendPath -PathType Leaf)) { return }
        $selected | Add-Member -NotePropertyName BackendPath -NotePropertyValue $backendPath
        return $selected
    }
}

function New-CstRunDirectory {
    param([Parameter(Mandatory)][string]$RuntimeRoot)
    $root = [IO.Path]::GetFullPath($RuntimeRoot)
    $runs = Join-Path $root 'runs'
    # Never remove a previous stop flag: a previous terminal may still be exiting.
    [void](New-Item -ItemType Directory -Path $runs -Force)
    $directory = Join-Path $runs ([Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $directory)
    return $directory
}

function Stop-CstRun {
    param([Parameter(Mandatory)][string]$ControlDirectory)
    [IO.File]::WriteAllText((Join-Path $ControlDirectory 'stop.flag'), [DateTime]::UtcNow.ToString('o'))
}

function New-CstTrayInstance {
    param([string]$Name = ('Local\CSTIndependent-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value))
    $activation = $null; $mutex = $null; $ownsMutex = $false
    try {
        # Keep the event alive before competing for ownership. A second launch
        # can then request the panel even while the first is initializing its UI.
        $activation = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, ($Name + '-Activate'))
        $mutex = [Threading.Mutex]::new($false, $Name)
        try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (!$ownsMutex) { [void]$activation.Set() }
        return [pscustomobject]@{ OwnsMutex = $ownsMutex; Mutex = $mutex; Activation = $activation }
    } catch {
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        if ($mutex) { $mutex.Dispose() }
        if ($activation) { $activation.Dispose() }
        throw
    }
}

function Close-CstTrayInstance {
    param([Parameter(Mandatory)]$Instance)
    if ($Instance.OwnsMutex) { $Instance.Mutex.ReleaseMutex() }
    $Instance.Mutex.Dispose()
    $Instance.Activation.Dispose()
}

function Show-CstRequestedPanel {
    param([Parameter(Mandatory)]$Instance, [Parameter(Mandatory)]$Panel, [switch]$Initial)
    if ($Initial -or $Instance.Activation.WaitOne(0)) { $Panel.ShowPanel() }
}

# Keep package discovery, process inspection and presence-file reads away from
# the window's message thread. Only completed snapshots are consumed by the UI.
function New-CstStatusReader {
    param([string]$Script = @'
param($Root, $ControlDirectory, $PreferredPid)
. (Join-Path $Root 'CST-Tray.ps1') -DefinitionsOnly
. (Join-Path $Root 'CST-Presence.ps1')
$desktop = $null
try { $desktop = Get-CstRunningDesktop -PreferredPid $PreferredPid } catch { }
[pscustomobject]@{
    Desktop = $desktop
    Rows = @(Get-CstSessionRows -ControlDirectory $ControlDirectory)
    Chinese = [CodexSessionToTerminal.SystemAppearance]::UiLanguage().StartsWith('zh', [StringComparison]::OrdinalIgnoreCase)
    Dark = [CodexSessionToTerminal.SystemAppearance]::IsDark()
}
'@)
    $runspace = [RunspaceFactory]::CreateRunspace()
    $runspace.ApartmentState = [Threading.ApartmentState]::MTA
    $runspace.ThreadOptions = [Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
    $runspace.Open()
    return [pscustomobject]@{ Worker = $null; Runspace = $runspace; Script = $Script; Pending = $null; Closed = $false }
}

function Start-CstStatusRead {
    param([Parameter(Mandatory)]$Reader, [Parameter(Mandatory)][string]$ControlDirectory, [int]$PreferredPid = 0)
    if ($Reader.Closed -or $Reader.Pending) { return $false }
    # Reuse the background runspace, but give each scan its own invocation and
    # output buffer so an earlier failed invocation cannot poison later scans.
    $Reader.Worker = [PowerShell]::Create()
    try {
        $Reader.Worker.Runspace = $Reader.Runspace
        [void]$Reader.Worker.AddScript($Reader.Script).AddArgument($PSScriptRoot).AddArgument($ControlDirectory).AddArgument($PreferredPid)
        $Reader.Pending = $Reader.Worker.BeginInvoke()
        return $true
    } catch {
        $Reader.Worker.Dispose()
        $Reader.Worker = $null
        throw
    }
}

function Receive-CstStatusRead {
    param([Parameter(Mandatory)]$Reader)
    if ($Reader.Closed -or !$Reader.Pending -or !$Reader.Pending.IsCompleted) { return }
    try {
        $result = @($Reader.Worker.EndInvoke($Reader.Pending))
        # Expected missing processes/files may be explicitly handled by the
        # scanner and still set HadErrors. Reject only emitted scan errors.
        if ($Reader.Worker.Streams.Error.Count -eq 0 -and $result.Count) { return $result[-1] }
    } catch { }
    finally {
        $Reader.Pending = $null
        $Reader.Worker.Dispose()
        $Reader.Worker = $null
    }
}

function Close-CstStatusReader {
    param([Parameter(Mandatory)]$Reader)
    if ($Reader.Closed) { return }
    $Reader.Closed = $true
    try {
        if ($Reader.Pending) {
            $Reader.Worker.Stop()
            try { [void]$Reader.Worker.EndInvoke($Reader.Pending) } catch { }
        }
    } finally {
        $Reader.Pending = $null
        if ($Reader.Worker) { $Reader.Worker.Dispose(); $Reader.Worker = $null }
        $Reader.Runspace.Dispose()
    }
}

function Get-CstTerminalArguments {
    param([Parameter(Mandatory)][guid]$ThreadId, [Parameter(Mandatory)][string]$ControlDirectory, [Parameter(Mandatory)][string]$PowerShellPath, [Parameter(Mandatory)][string]$BackendPath,
        [ValidateSet('local','durable')][string]$HostId = 'local')
    $entry = if ($HostId -ceq 'durable') { 'cst-cloud-terminal.mjs' } else { 'cst-native-terminal.mjs' }
    @((Join-Path $PSScriptRoot $entry), '--thread', $ThreadId.ToString('D'), '--control-directory', [IO.Path]::GetFullPath($ControlDirectory), '--powershell-path', $PowerShellPath, '--backend-path', $BackendPath)
}

function Receive-CstShortcutFallback {
    param([Parameter(Mandatory)][hashtable]$State, [long]$SourceWindow, [int]$ForegroundPid,
        [int]$DesktopPid, [long]$DesktopStartTicks, [DateTime]$Now = [DateTime]::UtcNow)
    $pending = $State.ShortcutPending
    if (!$pending) { return }
    # Cancel on any observed focus/generation change. A stalled UI must not
    # open an old request much later. No current chat is inferred here.
    $age = ($Now - $pending.At).TotalMilliseconds
    if ($SourceWindow -ne $pending.SourceWindow -or $ForegroundPid -ne $pending.DesktopPid -or
        $DesktopPid -ne $pending.DesktopPid -or $DesktopStartTicks -ne $pending.DesktopStartTicks -or
        $age -lt 0 -or $age -gt 3000) { $State.ShortcutPending = $null; return }
    if ($age -lt 900) { return }
    $State.ShortcutPending = $null
    return $pending
}

function Get-CstCloudTerminalArguments {
    param([Parameter(Mandatory)][string]$ControlDirectory, [Parameter(Mandatory)][string]$PowerShellPath, [Parameter(Mandatory)][string]$BackendPath, [string]$TitleContext)
    @((Join-Path $PSScriptRoot 'cst-cloud-terminal.mjs'), '--control-directory', [IO.Path]::GetFullPath($ControlDirectory), '--powershell-path', $PowerShellPath, '--backend-path', $BackendPath)
    if ($TitleContext) { @('--title-context', $TitleContext) }
}

function Start-CstTitleProbe {
    param([Parameter(Mandatory)]$Request)
    $probe = @{ Request=$Request; At=[DateTime]::UtcNow; Process=$null; Output=$null; Errors=$null }
    try {
        $helper = Join-Path $PSScriptRoot 'bin\Desktop-Context.exe'
        if (!(Test-Path -LiteralPath $helper -PathType Leaf)) { return $probe }
        $info = [Diagnostics.ProcessStartInfo]::new($helper)
        $info.UseShellExecute=$false; $info.CreateNoWindow=$true; $info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
        $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
        $info.StandardOutputEncoding=[Text.Encoding]::UTF8
        foreach ($item in @('--pid', [string]$Request.DesktopPid, '--window', [string]$Request.SourceWindow, '--started', [string]$Request.DesktopStartTicks)) { $info.ArgumentList.Add($item) }
        $probe.Process = [Diagnostics.Process]::Start($info)
        $probe.Output = $probe.Process.StandardOutput.ReadToEndAsync()
        $probe.Errors = $probe.Process.StandardError.ReadToEndAsync()
    } catch { Close-CstTitleProbe -Probe $probe }
    return $probe
}

function Close-CstTitleProbe {
    param($Probe)
    if ($Probe -and $Probe.Process) {
        # Only this short-lived, read-only child belongs to the probe. Never
        # wait on UIA on the tray's message thread or touch the Desktop process.
        try { if (!$Probe.Process.HasExited) { $Probe.Process.Kill() } } catch { }
        $Probe.Process.Dispose(); $Probe.Process=$null
    }
}

function Receive-CstTitleProbe {
    param([Parameter(Mandatory)]$Probe, [DateTime]$Now=[DateTime]::UtcNow)
    $result = [pscustomobject]@{ Context=$null; Reason='helper-unavailable'; ElapsedMs=0 }
    if (!$Probe.Process) { return $result }
    $age = ($Now - $Probe.At).TotalMilliseconds
    $result.ElapsedMs = [Math]::Max(0, [int]$age)
    $result.Reason = 'timeout'
    if ($age -ge 0 -and $age -lt 4000 -and
        (!$Probe.Process.HasExited -or !$Probe.Output.IsCompleted -or !$Probe.Errors.IsCompleted)) { return }
    try {
        if ($age -lt 0 -or $age -ge 4000 -or !$Probe.Process.HasExited -or $Probe.Process.ExitCode -ne 0 -or
            !$Probe.Output.IsCompletedSuccessfully -or !$Probe.Errors.IsCompletedSuccessfully) { return $result }
        $result.Reason = 'invalid-observation'
        $raw = $Probe.Output.Result
        if ($raw.Length -gt 8192 -or $Probe.Errors.Result.Length) { return $result }
        $value = $raw | ConvertFrom-Json -ErrorAction Stop
        if ($value.version -ne 1 -or $value.status -cne 'ready' -or
            $value.pid -ne $Probe.Request.DesktopPid -or $value.window -ne $Probe.Request.SourceWindow -or
            $value.started -cne [string]$Probe.Request.DesktopStartTicks -or
            $value.title -isnot [string] -or $value.title.Length -eq 0 -or $value.title.Length -gt 512) { return $result }
        $value | Add-Member -NotePropertyName capturedAt -NotePropertyValue ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Force
        $result.Context = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress)))
        $result.Reason = 'matched'
    } catch { } finally { Close-CstTitleProbe -Probe $Probe }
    return $result
}

function Start-CstTerminalWindow {
    param([Parameter(Mandatory)][string[]]$NodeArguments, [Parameter(Mandatory)][string]$ControlDirectory,
        [Parameter(Mandatory)][string]$NodeExecutable, [Parameter(Mandatory)][string]$PowerShellPath,
        [long]$SourceWindow = 0, [switch]$ExplicitMenuLaunch)
    # A menu click authorizes opening its own terminal even when another app is
    # foreground. Focus handling below still targets only that new window and
    # stops trying to activate it if the user changes apps.
    if ($ExplicitMenuLaunch) { $SourceWindow = [CodexSharedSession.TerminalWindows]::Foreground() }
    elseif ($SourceWindow -eq 0) { return }
    $beforeHandles = @([CodexSharedSession.TerminalWindows]::Snapshot() | ForEach-Object Handle)
    $windowTitle = 'Codex Session to Terminal ' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $terminal = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$ExplicitMenuLaunch -and [CodexSharedSession.TerminalWindows]::Foreground() -ne $SourceWindow) { return }
    $created = $null
    try {
        if ($terminal) {
            $info = [Diagnostics.ProcessStartInfo]::new($terminal.Source)
            $info.UseShellExecute = $false
            $info.CreateNoWindow = $true
            foreach ($argument in (@('-w','new','new-tab','--title',$windowTitle,$NodeExecutable) + $NodeArguments)) { $info.ArgumentList.Add($argument) }
            $created = [Diagnostics.Process]::Start($info)
            $status = Invoke-CodexTerminalForeground -SourceWindow $SourceWindow -BeforeHandles $beforeHandles -WindowTitle $windowTitle
        } else {
            # Encode a literal-only invocation so spaces, quotes and shell punctuation
            # in the installation directory never become PowerShell instructions.
            $literals = @(@($NodeExecutable) + $NodeArguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" })
            $command = '$Host.UI.RawUI.WindowTitle=' + "'" + $windowTitle + "'; & " + ($literals -join ' ') + '; exit $LASTEXITCODE'
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
            $created = Start-Process -FilePath $PowerShellPath -ArgumentList @('-NoLogo','-NoProfile','-EncodedCommand',$encoded) -WorkingDirectory $PSScriptRoot -WindowStyle Normal -PassThru
            $status = Invoke-CodexTerminalForeground -SourceWindow $SourceWindow -BeforeHandles $beforeHandles -WindowTitle $windowTitle -Mode PowerShell -CreatedProcess $created
        }
        @{ at = [DateTime]::UtcNow.ToString('o'); status = $status } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ControlDirectory 'last-terminal-focus.json') -Encoding utf8
    } finally { if ($created) { $created.Dispose() } }
}

function Invoke-CstTerminal {
    param([Parameter(Mandatory)][guid]$ThreadId, [Parameter(Mandatory)][string]$ControlDirectory, [Parameter(Mandatory)][string]$NodeExecutable, [Parameter(Mandatory)][int]$DesktopPid, [Parameter(Mandatory)][string]$BackendPath,
        [ValidateSet('local','durable')][string]$HostId = 'local')
    if ([CodexSharedSession.ClipboardLinkListener]::ForegroundProcessId() -ne $DesktopPid) { return }
    $sourceWindow = [CodexSharedSession.TerminalWindows]::Foreground()
    $powerShellPath = Join-Path $PSHOME 'pwsh.exe'
    $nodeArguments = @(Get-CstTerminalArguments -ThreadId $ThreadId -HostId $HostId -ControlDirectory $ControlDirectory -PowerShellPath $powerShellPath -BackendPath $BackendPath)
    Start-CstTerminalWindow -NodeArguments $nodeArguments -ControlDirectory $ControlDirectory -NodeExecutable $NodeExecutable -PowerShellPath $powerShellPath -SourceWindow $sourceWindow
}

function Invoke-CstCloudTerminal {
    param([Parameter(Mandatory)][string]$ControlDirectory, [Parameter(Mandatory)][string]$NodeExecutable, [Parameter(Mandatory)][string]$BackendPath,
        [switch]$FromShortcut, [long]$SourceWindow = 0, [int]$DesktopPid = 0, [string]$TitleContext)
    if ($FromShortcut -and ($SourceWindow -eq 0 -or $DesktopPid -le 0 -or
        [CodexSharedSession.ClipboardLinkListener]::ForegroundProcessId() -ne $DesktopPid -or
        [CodexSharedSession.TerminalWindows]::Foreground() -ne $SourceWindow)) { return }
    $powerShellPath = Join-Path $PSHOME 'pwsh.exe'
    $nodeArguments = @(Get-CstCloudTerminalArguments -ControlDirectory $ControlDirectory -PowerShellPath $powerShellPath -BackendPath $BackendPath -TitleContext $(if ($FromShortcut) { $TitleContext }))
    Start-CstTerminalWindow -NodeArguments $nodeArguments -ControlDirectory $ControlDirectory -NodeExecutable $NodeExecutable -PowerShellPath $powerShellPath -SourceWindow $SourceWindow -ExplicitMenuLaunch:(!$FromShortcut)
}

function Start-CstTray {
    param([Parameter(Mandatory)][string]$NodeExecutable)
    if (!$IsWindows -or [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') { throw 'Start Codex Session to Terminal with PowerShell 7 -STA on Windows.' }
    $instance = $null; $tray = $null; $icon = $null; $menu = $null; $panel = $null; $heartbeat = $null; $runDirectory = $null
    $reader = $null; $timer = $null; $context = $null
    $state = @{ Exit = $false; Desktop = $null; Listener = $null; ShortcutPending = $null; TitleProbe = $null; LastThread = ''; LastLaunch = [DateTime]::MinValue; Text = $null; TickRunning = $false; Failure = $null; NextCheck = [DateTime]::MinValue }
    try {
        $instance = New-CstTrayInstance
        if (!$instance.OwnsMutex) { return }
        # Only the owner loads native UI/listener code. Repeated double-clicks
        # signal its panel immediately instead of compiling another tray process.
        if (!(Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw 'The Codex Session to Terminal Node.js runtime is missing.' }
        . (Join-Path $PSScriptRoot 'Thread-Link.ps1')
        . (Join-Path $PSScriptRoot 'Terminal-Focus.ps1')
        . (Join-Path $PSScriptRoot 'CST-Panel.ps1')
        . (Join-Path $PSScriptRoot 'CST-Presence.ps1')
        Initialize-CodexTerminalFocus
        if (!('CodexSharedSession.ClipboardLinkListener' -as [type])) { Add-Type -TypeDefinition (Get-CstClipboardListenerSource -Path (Join-Path $PSScriptRoot 'Watch-Chat-Link.ps1')) }
        Initialize-CstPanel
        [void][Windows.Forms.Application]::SetHighDpiMode([Windows.Forms.HighDpiMode]::PerMonitorV2)
        [Windows.Forms.Application]::EnableVisualStyles()
        $runtimeRoot = Join-Path $env:LOCALAPPDATA 'SessionBridge\independent'
        $runDirectory = New-CstRunDirectory -RuntimeRoot $runtimeRoot
        # .NET ticks exceed JavaScript's exact integer range. Keep the generation
        # identity lossless for terminal readers.
        @{ pid = $PID; startTicks = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDirectory 'owner.json') -Encoding utf8
        $heartbeat = [CodexSessionToTerminal.TrayHeartbeat]::new($runDirectory)
        $chinese = [CodexSessionToTerminal.SystemAppearance]::UiLanguage().StartsWith('zh', [StringComparison]::OrdinalIgnoreCase)
        $state.Text = Get-CstInterfaceText -Chinese $chinese
        $panel = [CodexSessionToTerminal.SessionPanel]::new((Join-Path $PSScriptRoot 'assets\icon.ico'))
        Update-CstPanel -Panel $panel -Rows @() -Dark ([CodexSessionToTerminal.SystemAppearance]::IsDark()) -Chinese $chinese
        $menu = [CodexSessionToTerminal.TrayMenu]::new()
        $menu.UpdateAppearance([CodexSessionToTerminal.SystemAppearance]::IsDark(), $chinese, $false)
        $menu.SessionsItem.add_Click({ $panel.ShowPanel() })
        $menu.CloudSessionsItem.add_Click({
            if (!$state.Desktop -or $state.Exit) { return }
            try {
                $current = Get-Process -Id $state.Desktop.Id -ErrorAction Stop
                if ($current.StartTime.ToUniversalTime().Ticks -ne $state.Desktop.StartTicks) { throw 'The selected ChatGPT process has changed.' }
                Invoke-CstCloudTerminal -ControlDirectory $runDirectory -NodeExecutable $NodeExecutable -BackendPath $state.Desktop.BackendPath
            }
            catch { $tray.ShowBalloonTip(4000, 'Codex Session to Terminal', $state.Text.OpenFailed, [Windows.Forms.ToolTipIcon]::Warning) }
        })
        $menu.ExitItem.add_Click({ $state.Exit = $true })
        $tray = [Windows.Forms.NotifyIcon]::new()
        $icon = [Drawing.Icon]::new((Join-Path $PSScriptRoot 'assets\icon.ico'))
        $tray.Icon = $icon; $tray.ContextMenuStrip = $menu; $tray.Text = $state.Text.TooltipWaiting; $tray.Visible = $true
        $tray.add_MouseClick({ param($sender, $eventArgs)
            if ($eventArgs.Button -eq [Windows.Forms.MouseButtons]::Left) { $panel.ShowPanel() }
        })
        $tray.add_BalloonTipClicked({ $panel.ShowPanel() })
        # Windows may suppress this under Focus Assist or notification settings.
        # Show it once per tray process. Explicit launches also open the panel,
        # so a suppressed notification never makes CST appear unresponsive.
        $tray.ShowBalloonTip(5000, 'Codex Session to Terminal', $state.Text.Running, [Windows.Forms.ToolTipIcon]::Info)
        Show-CstRequestedPanel -Instance $instance -Panel $panel -Initial
        $onShortcutPressed = [Action] {
            if (!$state.Desktop -or $state.Exit -or
                [CodexSharedSession.ClipboardLinkListener]::ForegroundProcessId() -ne $state.Desktop.Id) { return }
            Close-CstTitleProbe -Probe $state.TitleProbe; $state.TitleProbe=$null
            $state.ShortcutPending = @{ At = [DateTime]::UtcNow; SourceWindow = [CodexSharedSession.TerminalWindows]::Foreground()
                DesktopPid = $state.Desktop.Id; DesktopStartTicks = $state.Desktop.StartTicks }
        }
        $onTextChanged = [Action[string]] {
            param([string]$Text)
            $link = ConvertFrom-CodexThreadLink -Text $Text
            if (!$link -or !$state.Desktop -or $state.Exit) { return }
            $state.ShortcutPending = $null
            Close-CstTitleProbe -Probe $state.TitleProbe; $state.TitleProbe=$null
            $threadKey = $link.HostId + ':' + $link.ThreadId.ToString('D')
            $now = [DateTime]::UtcNow
            if ($state.LastThread -eq $threadKey -and ($now - $state.LastLaunch).TotalSeconds -lt 2) { return }
            $state.LastThread = $threadKey; $state.LastLaunch = $now
            try {
                $current = Get-Process -Id $state.Desktop.Id -ErrorAction Stop
                if ($current.StartTime.ToUniversalTime().Ticks -ne $state.Desktop.StartTicks) { return }
                Invoke-CstTerminal -ThreadId $link.ThreadId -HostId $link.HostId -ControlDirectory $runDirectory -NodeExecutable $NodeExecutable -DesktopPid $state.Desktop.Id -BackendPath $state.Desktop.BackendPath
            }
            catch { $tray.ShowBalloonTip(4000, 'Codex Session to Terminal', $state.Text.OpenFailed, [Windows.Forms.ToolTipIcon]::Warning) }
        }
        $reader = New-CstStatusReader
        $context = [Windows.Forms.ApplicationContext]::new()
        $timer = [Windows.Forms.Timer]::new()
        $timer.Interval = 50
        $timer.add_Tick({
          if ($state.TickRunning) { return }
          $state.TickRunning = $true
          try {
            if ($state.Exit -or (Test-Path -LiteralPath (Join-Path $runDirectory 'stop.flag'))) {
                $timer.Stop(); $context.ExitThread(); return
            }
            Show-CstRequestedPanel -Instance $instance -Panel $panel
            $snapshot = Receive-CstStatusRead -Reader $reader
            if ($snapshot) {
                $desktop = $snapshot.Desktop
                $identity = if ($desktop) { "$($desktop.Id):$($desktop.StartTicks)" } else { '' }
                $previous = if ($state.Desktop) { "$($state.Desktop.Id):$($state.Desktop.StartTicks)" } else { '' }
                if ($identity -ne $previous) {
                    $state.ShortcutPending = $null
                    Close-CstTitleProbe -Probe $state.TitleProbe; $state.TitleProbe=$null
                    if ($state.Listener) { $state.Listener.remove_TextChanged($onTextChanged); $state.Listener.remove_ShortcutPressed($onShortcutPressed); $state.Listener.Dispose(); $state.Listener = $null }
                    $state.Desktop = $desktop
                    if ($desktop) {
                        $state.Listener = [CodexSharedSession.ClipboardLinkListener]::new([uint32]$desktop.Id, $true)
                        $state.Listener.add_TextChanged($onTextChanged)
                        $state.Listener.add_ShortcutPressed($onShortcutPressed)
                        if (!$state.Listener.ShortcutObservationEnabled) {
                            $tray.ShowBalloonTip(5000, 'Codex Session to Terminal', $state.Text.ShortcutUnavailable, [Windows.Forms.ToolTipIcon]::Warning)
                        }
                    }
                }
                $chinese = $snapshot.Chinese
                $state.Text = Get-CstInterfaceText -Chinese $chinese
                $menu.UpdateAppearance($snapshot.Dark, $chinese, [bool]$desktop)
                $tray.Text = if ($desktop) { $state.Text.TooltipReady } else { $state.Text.TooltipWaiting }
                Update-CstPanel -Panel $panel -Rows @($snapshot.Rows) -Dark $snapshot.Dark -Chinese $chinese
            }
            if (!$reader.Pending -and [DateTime]::UtcNow -ge $state.NextCheck) {
                [void](Start-CstStatusRead -Reader $reader -ControlDirectory $runDirectory -PreferredPid $(if ($state.Desktop) { $state.Desktop.Id } else { 0 }))
                $state.NextCheck = [DateTime]::UtcNow.AddSeconds(2)
            }
            if ($state.Listener) { $state.Listener.Pump() }
            if ($state.ShortcutPending -and $state.Desktop) {
                $pending = Receive-CstShortcutFallback -State $state -SourceWindow ([CodexSharedSession.TerminalWindows]::Foreground()) -ForegroundPid ([CodexSharedSession.ClipboardLinkListener]::ForegroundProcessId()) -DesktopPid $state.Desktop.Id -DesktopStartTicks $state.Desktop.StartTicks
                if ($pending) {
                    Close-CstTitleProbe -Probe $state.TitleProbe
                    $state.TitleProbe = Start-CstTitleProbe -Request $pending
                }
            }
            if ($state.TitleProbe -and $state.Desktop) {
                $pending = $state.TitleProbe.Request
                if ([CodexSharedSession.TerminalWindows]::Foreground() -ne $pending.SourceWindow -or
                    [CodexSharedSession.ClipboardLinkListener]::ForegroundProcessId() -ne $pending.DesktopPid -or
                    $state.Desktop.Id -ne $pending.DesktopPid -or $state.Desktop.StartTicks -ne $pending.DesktopStartTicks -or
                    ([DateTime]::UtcNow - $pending.At).TotalMilliseconds -gt 7000) {
                    Close-CstTitleProbe -Probe $state.TitleProbe; $state.TitleProbe=$null
                    return
                }
                $titleResult = Receive-CstTitleProbe -Probe $state.TitleProbe
                if ($titleResult) {
                    $state.TitleProbe=$null
                    try { @{ reason=$titleResult.Reason; elapsedMs=$titleResult.ElapsedMs; at=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDirectory 'last-title-probe.json') -Encoding utf8 } catch { }
                    try {
                        $current = Get-Process -Id $pending.DesktopPid -ErrorAction Stop
                        if ($current.StartTime.ToUniversalTime().Ticks -eq $pending.DesktopStartTicks) {
                            Invoke-CstCloudTerminal -ControlDirectory $runDirectory -NodeExecutable $NodeExecutable -BackendPath $state.Desktop.BackendPath -FromShortcut -SourceWindow $pending.SourceWindow -DesktopPid $pending.DesktopPid -TitleContext $titleResult.Context
                        }
                    } catch { $tray.ShowBalloonTip(4000, 'Codex Session to Terminal', $state.Text.OpenFailed, [Windows.Forms.ToolTipIcon]::Warning) }
                }
            }
          } catch {
            $state.Failure = $_
            $timer.Stop(); $context.ExitThread()
          } finally { $state.TickRunning = $false }
        })
        $timer.Start()
        [Windows.Forms.Application]::Run($context)
        if ($state.Failure) { throw $state.Failure }
    } finally {
        if ($timer) { $timer.Stop(); $timer.Dispose() }
        Close-CstTitleProbe -Probe $state.TitleProbe
        if ($context) { $context.Dispose() }
        if ($reader) { Close-CstStatusReader -Reader $reader }
        if ($runDirectory) { try { Stop-CstRun -ControlDirectory $runDirectory } catch { } }
        if ($heartbeat) { $heartbeat.Dispose() }
        if ($state.Listener) { $state.Listener.remove_TextChanged($onTextChanged); $state.Listener.remove_ShortcutPressed($onShortcutPressed); $state.Listener.Dispose() }
        if ($panel) { $panel.AllowClose = $true; $panel.Dispose() }
        if ($tray) { $tray.Visible = $false; $tray.Dispose() }
        if ($menu) { $menu.Dispose() }
        if ($icon) { $icon.Dispose() }
        if ($instance) { Close-CstTrayInstance -Instance $instance }
    }
}

if (!$DefinitionsOnly) {
    try { Start-CstTray -NodeExecutable $NodePath }
    catch {
        Add-Type -AssemblyName System.Windows.Forms
        $message = 'Codex Session to Terminal could not start. Check that its files and runtimes are installed correctly.'
        if (Get-Command Get-CstInterfaceText -ErrorAction SilentlyContinue) {
            $language = if ('CodexSessionToTerminal.SystemAppearance' -as [type]) { [CodexSessionToTerminal.SystemAppearance]::UiLanguage() } else { [Globalization.CultureInfo]::CurrentUICulture.Name }
            $message = (Get-CstInterfaceText -Chinese $language.StartsWith('zh', [StringComparison]::OrdinalIgnoreCase)).StartFailed
        }
        [void][Windows.Forms.MessageBox]::Show($message, 'Codex Session to Terminal')
        exit 1
    }
}
