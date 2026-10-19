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

function Get-CstTerminalArguments {
    param([Parameter(Mandatory)][guid]$ThreadId, [Parameter(Mandatory)][string]$ControlDirectory, [Parameter(Mandatory)][string]$PowerShellPath, [Parameter(Mandatory)][string]$BackendPath)
    @((Join-Path $PSScriptRoot 'cst-terminal.mjs'), '--thread', $ThreadId.ToString('D'), '--control-directory', [IO.Path]::GetFullPath($ControlDirectory), '--powershell-path', $PowerShellPath, '--backend-path', $BackendPath)
}

function Invoke-CstTerminal {
    param([Parameter(Mandatory)][guid]$ThreadId, [Parameter(Mandatory)][string]$ControlDirectory, [Parameter(Mandatory)][string]$NodeExecutable, [Parameter(Mandatory)][int]$DesktopPid, [Parameter(Mandatory)][string]$BackendPath)
    if ([CodexSharedSession.ClipboardLinkListener]::ForegroundProcessId() -ne $DesktopPid) { return }
    $sourceWindow = [CodexSharedSession.TerminalWindows]::Foreground()
    $beforeHandles = @([CodexSharedSession.TerminalWindows]::Snapshot() | ForEach-Object Handle)
    $windowTitle = 'CST ' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $powerShellPath = Join-Path $PSHOME 'pwsh.exe'
    $nodeArguments = @(Get-CstTerminalArguments -ThreadId $ThreadId -ControlDirectory $ControlDirectory -PowerShellPath $powerShellPath -BackendPath $BackendPath)
    $terminal = Get-Command wt.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ([CodexSharedSession.TerminalWindows]::Foreground() -ne $sourceWindow) { return }
    $created = $null
    try {
        if ($terminal) {
            $info = [Diagnostics.ProcessStartInfo]::new($terminal.Source)
            $info.UseShellExecute = $false
            $info.CreateNoWindow = $true
            foreach ($argument in (@('-w','new','new-tab','--title',$windowTitle,$NodeExecutable) + $nodeArguments)) { $info.ArgumentList.Add($argument) }
            $created = [Diagnostics.Process]::Start($info)
            $status = Invoke-CodexTerminalForeground -SourceWindow $sourceWindow -BeforeHandles $beforeHandles -WindowTitle $windowTitle
        } else {
            # Encode a literal-only invocation so spaces, quotes and shell punctuation
            # in the installation directory never become PowerShell instructions.
            $literals = @(@($NodeExecutable) + $nodeArguments | ForEach-Object { "'" + $_.Replace("'", "''") + "'" })
            $command = '$Host.UI.RawUI.WindowTitle=' + "'" + $windowTitle + "'; & " + ($literals -join ' ') + '; exit $LASTEXITCODE'
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
            $created = Start-Process -FilePath $powerShellPath -ArgumentList @('-NoLogo','-NoProfile','-EncodedCommand',$encoded) -WorkingDirectory $PSScriptRoot -WindowStyle Normal -PassThru
            $status = Invoke-CodexTerminalForeground -SourceWindow $sourceWindow -BeforeHandles $beforeHandles -WindowTitle $windowTitle -Mode PowerShell -CreatedProcess $created
        }
        @{ at = [DateTime]::UtcNow.ToString('o'); status = $status } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ControlDirectory 'last-terminal-focus.json') -Encoding utf8
    } finally { if ($created) { $created.Dispose() } }
}

function Start-CstTray {
    param([Parameter(Mandatory)][string]$NodeExecutable)
    if (!$IsWindows -or [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') { throw 'Start CST with PowerShell 7 -STA on Windows.' }
    if (!(Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) { throw 'The CST Node.js runtime is missing.' }
    . (Join-Path $PSScriptRoot 'Thread-Link.ps1')
    . (Join-Path $PSScriptRoot 'Terminal-Focus.ps1')
    . (Join-Path $PSScriptRoot 'CST-Panel.ps1')
    . (Join-Path $PSScriptRoot 'CST-Presence.ps1')
    Initialize-CodexTerminalFocus
    if (!('CodexSharedSession.ClipboardLinkListener' -as [type])) { Add-Type -TypeDefinition (Get-CstClipboardListenerSource -Path (Join-Path $PSScriptRoot 'Watch-Chat-Link.ps1')) }
    Initialize-CstPanel
    [void][Windows.Forms.Application]::SetHighDpiMode([Windows.Forms.HighDpiMode]::PerMonitorV2)
    [Windows.Forms.Application]::EnableVisualStyles()
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = [Threading.Mutex]::new($false, ('Local\CSTIndependent-' + $userSid))
    $ownsMutex = $false; $listener = $null; $tray = $null; $icon = $null; $menu = $null; $panel = $null; $heartbeat = $null; $runDirectory = $null
    $state = @{ Exit = $false; Desktop = $null; LastThread = ''; LastLaunch = [DateTime]::MinValue; Text = $null }
    try {
        try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (!$ownsMutex) { return }
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
        $menu = [Windows.Forms.ContextMenuStrip]::new()
        $sessionsItem = $menu.Items.Add($state.Text.Sessions)
        $sessionsItem.add_Click({ $panel.ShowPanel() })
        [void]$menu.Items.Add([Windows.Forms.ToolStripSeparator]::new())
        $statusItem = $menu.Items.Add($state.Text.Waiting); $statusItem.Enabled = $false
        $hintItem = $menu.Items.Add($state.Text.Hint); $hintItem.Enabled = $false
        [void]$menu.Items.Add([Windows.Forms.ToolStripSeparator]::new())
        $legacyItem = $menu.Items.Add($state.Text.Legacy)
        $legacyItem.add_Click({
            # Reveal the fallback; never invoke it or restart Desktop from the tray.
            Start-Process -FilePath explorer.exe -ArgumentList @('/select,', ('"' + (Join-Path $PSScriptRoot 'Start.cmd') + '"')) -WindowStyle Normal | Out-Null
        })
        $exitItem = $menu.Items.Add($state.Text.Exit)
        $exitItem.add_Click({ $state.Exit = $true })
        $tray = [Windows.Forms.NotifyIcon]::new()
        $icon = [Drawing.Icon]::new((Join-Path $PSScriptRoot 'assets\icon.ico'))
        $tray.Icon = $icon; $tray.ContextMenuStrip = $menu; $tray.Text = $state.Text.TooltipWaiting; $tray.Visible = $true
        $tray.add_MouseClick({ param($sender, $eventArgs)
            if ($eventArgs.Button -eq [Windows.Forms.MouseButtons]::Left) { $panel.ShowPanel() }
        })
        $tray.add_BalloonTipClicked({ $panel.ShowPanel() })
        # Windows may suppress this under Focus Assist or notification settings.
        # Show it once per tray process, without bringing a window to the foreground.
        $tray.ShowBalloonTip(5000, 'Codex Session to Terminal', $state.Text.Running, [Windows.Forms.ToolTipIcon]::Info)
        $onTextChanged = [Action[string]] {
            param([string]$Text)
            $thread = ConvertFrom-CodexLocalThreadLink -Text $Text
            if (!$thread -or !$state.Desktop -or $state.Exit) { return }
            $now = [DateTime]::UtcNow
            if ($state.LastThread -eq $thread.ToString('D') -and ($now - $state.LastLaunch).TotalSeconds -lt 2) { return }
            $state.LastThread = $thread.ToString('D'); $state.LastLaunch = $now
            try {
                $current = Get-Process -Id $state.Desktop.Id -ErrorAction Stop
                if ($current.StartTime.ToUniversalTime().Ticks -ne $state.Desktop.StartTicks) { return }
                Invoke-CstTerminal -ThreadId $thread -ControlDirectory $runDirectory -NodeExecutable $NodeExecutable -DesktopPid $state.Desktop.Id -BackendPath $state.Desktop.BackendPath
            }
            catch { $tray.ShowBalloonTip(4000, 'CST', $state.Text.OpenFailed, [Windows.Forms.ToolTipIcon]::Warning) }
        }
        $nextCheck = [DateTime]::MinValue
        while (!$state.Exit -and !(Test-Path -LiteralPath (Join-Path $runDirectory 'stop.flag'))) {
            if ([DateTime]::UtcNow -ge $nextCheck) {
                $desktop = $null
                try { $desktop = Get-CstRunningDesktop -PreferredPid $(if ($state.Desktop) { $state.Desktop.Id } else { 0 }) } catch { }
                $identity = if ($desktop) { "$($desktop.Id):$($desktop.StartTicks)" } else { '' }
                $previous = if ($state.Desktop) { "$($state.Desktop.Id):$($state.Desktop.StartTicks)" } else { '' }
                if ($identity -ne $previous) {
                    if ($listener) { $listener.remove_TextChanged($onTextChanged); $listener.Dispose(); $listener = $null }
                    $state.Desktop = $desktop
                    if ($desktop) { $listener = [CodexSharedSession.ClipboardLinkListener]::new([uint32]$desktop.Id); $listener.add_TextChanged($onTextChanged) }
                }
                $chinese = [CodexSessionToTerminal.SystemAppearance]::UiLanguage().StartsWith('zh', [StringComparison]::OrdinalIgnoreCase)
                $state.Text = Get-CstInterfaceText -Chinese $chinese
                $sessionsItem.Text = $state.Text.Sessions; $hintItem.Text = $state.Text.Hint
                $legacyItem.Text = $state.Text.Legacy; $exitItem.Text = $state.Text.Exit
                $statusItem.Text = if ($desktop) { $state.Text.Ready } else { $state.Text.Waiting }
                $tray.Text = if ($desktop) { $state.Text.TooltipReady } else { $state.Text.TooltipWaiting }
                Update-CstPanel -Panel $panel -Rows @(Get-CstSessionRows -ControlDirectory $runDirectory) -Dark ([CodexSessionToTerminal.SystemAppearance]::IsDark()) -Chinese $chinese
                $nextCheck = [DateTime]::UtcNow.AddSeconds(2)
            }
            if ($listener) { $listener.Pump() }
            [Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 50
        }
    } finally {
        if ($runDirectory) { try { Stop-CstRun -ControlDirectory $runDirectory } catch { } }
        if ($heartbeat) { $heartbeat.Dispose() }
        if ($listener) { $listener.Dispose() }
        if ($panel) { $panel.AllowClose = $true; $panel.Dispose() }
        if ($tray) { $tray.Visible = $false; $tray.Dispose() }
        if ($menu) { $menu.Dispose() }
        if ($icon) { $icon.Dispose() }
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if (!$DefinitionsOnly) {
    try { Start-CstTray -NodeExecutable $NodePath }
    catch {
        Add-Type -AssemblyName System.Windows.Forms
        $message = 'CST could not start. Check that its files and runtimes are installed correctly.'
        if (Get-Command Get-CstInterfaceText -ErrorAction SilentlyContinue) {
            $language = if ('CodexSessionToTerminal.SystemAppearance' -as [type]) { [CodexSessionToTerminal.SystemAppearance]::UiLanguage() } else { [Globalization.CultureInfo]::CurrentUICulture.Name }
            $message = (Get-CstInterfaceText -Chinese $language.StartsWith('zh', [StringComparison]::OrdinalIgnoreCase)).StartFailed
        }
        [void][Windows.Forms.MessageBox]::Show($message, 'Codex Session to Terminal')
        exit 1
    }
}
