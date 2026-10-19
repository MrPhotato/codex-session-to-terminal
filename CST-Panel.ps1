function Initialize-CstPanel {
    if (('CodexSessionToTerminal.SessionPanel' -as [type]) -and ('CodexSessionToTerminal.TrayMenu' -as [type])) { return }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing.Common
    $references = @('System.Windows.Forms', 'System.Drawing.Common', 'System.Drawing.Primitives',
        'System.ComponentModel.Primitives', 'Microsoft.Win32.Registry', 'System.Threading', 'System.ComponentModel')
    # .NET 10 separated the drawing interfaces; older supported runtimes do not
    # contain these assemblies and must not be asked to load them.
    foreach ($name in @('System.Windows.Forms.Primitives.dll', 'System.Private.Windows.Core.dll', 'System.Private.Windows.GdiPlus.dll')) {
        $reference = Join-Path $PSHOME $name
        if (Test-Path -LiteralPath $reference -PathType Leaf) { $references += $reference }
    }
    foreach ($entry in @(@('CodexSessionToTerminal.SessionPanel', 'CST-Panel.cs'), @('CodexSessionToTerminal.TrayMenu', 'CST-TrayMenu.cs'))) {
        if (!($entry[0] -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot $entry[1]) -ReferencedAssemblies $references }
    }
}

function Get-CstInterfaceText {
    param([bool]$Chinese)
    if ($Chinese) {
        return @{
            Running = 'Codex Session to Terminal 正在托盘运行。点击图标查看终端会话。'
            Sessions = '终端会话'; Waiting = '等待 ChatGPT'; Ready = '已就绪 · ChatGPT 正在运行'
            Hint = '在 ChatGPT 中按 Ctrl+Alt+L'; Legacy = '查看原版启动入口'; Exit = '退出 Codex Session to Terminal'
            TooltipReady = 'Codex Session to Terminal · Ctrl+Alt+L 打开当前聊天'; TooltipWaiting = 'Codex Session to Terminal · 等待 ChatGPT'
            OpenFailed = '终端未能打开。ChatGPT 仍在正常运行。'
            StartFailed = 'Codex Session to Terminal 无法启动，请检查程序文件和运行环境是否完整。'
        }
    }
    return @{
        Running = 'Codex Session to Terminal is running in the system tray. Click its icon to view terminal sessions.'
        Sessions = 'Terminal sessions'; Waiting = 'Waiting for ChatGPT'; Ready = 'Ready · ChatGPT is running'
        Hint = 'In ChatGPT, press Ctrl+Alt+L'; Legacy = 'Show legacy startup files'; Exit = 'Exit Codex Session to Terminal'
        TooltipReady = 'Codex Session to Terminal · Ctrl+Alt+L opens this chat'; TooltipWaiting = 'Codex Session to Terminal · waiting for ChatGPT'
        OpenFailed = 'The terminal could not be opened. ChatGPT is still running normally.'
        StartFailed = 'Codex Session to Terminal could not start. Check that its files and runtimes are installed correctly.'
    }
}

function Update-CstPanel {
    param([Parameter(Mandatory)]$Panel, [object[]]$Rows, [bool]$Dark, [bool]$Chinese)
    $nativeRows = @(
        foreach ($row in $Rows) {
            $native = [CodexSessionToTerminal.SessionRow]::new()
            $native.ThreadId = $row.ThreadId; $native.Title = $row.Title; $native.Phase = $row.Phase
            $native.ActiveTurn = $row.ActiveTurn; $native.TerminalCount = $row.TerminalCount
            $native
        }
    )
    $Panel.UpdateView([CodexSessionToTerminal.SessionRow[]]$nativeRows, $Dark, $Chinese)
}
