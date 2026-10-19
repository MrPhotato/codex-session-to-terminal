param([string]$PreviewDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'CST-Panel.ps1')
Initialize-CstPanel
$panel = [CodexSessionToTerminal.SessionPanel]::new((Join-Path $PSScriptRoot 'assets\icon.ico'))
try {
    $rows = @(
        [pscustomobject]@{ ThreadId = '12345678-1234-4234-9234-123456789abc'; Title = 'Codex Session to Terminal'; Phase = 'ready'; ActiveTurn = $true; TerminalCount = 1 },
        [pscustomobject]@{ ThreadId = '12345678-1234-4234-9234-123456789abd'; Title = '整理项目文档 / Project notes'; Phase = 'ready'; ActiveTurn = $false; TerminalCount = 2 },
        [pscustomobject]@{ ThreadId = '12345678-1234-4234-9234-123456789abe'; Title = 'Review the latest changes'; Phase = 'disconnected'; ActiveTurn = $false; TerminalCount = 1 }
    )
    if ($PreviewDirectory) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($PreviewDirectory)) }
    foreach ($chinese in @($true, $false)) {
        $text = Get-CstInterfaceText -Chinese $chinese
        foreach ($key in @('Running','Sessions','Waiting','Ready','Hint','Legacy','Exit','OpenFailed','StartFailed')) {
            if ([string]::IsNullOrWhiteSpace($text[$key])) { throw "Interface translation is missing: $key" }
        }
        foreach ($dark in @($true, $false)) {
            Update-CstPanel -Panel $panel -Rows $rows -Dark $dark -Chinese $chinese
            if (!$panel.Text.StartsWith($(if ($chinese) { '终端会话' } else { 'Terminal sessions' }))) { throw 'Panel language did not update.' }
            if ($panel.AccessibleDescription -notmatch '3' -or $panel.AccessibleDescription -notmatch '2') { throw 'Session summary is incomplete.' }
            foreach ($size in @(@(760,570), @(530,381), @(1100,720))) {
                $bitmap = $panel.RenderPreview($size[0], $size[1])
                try {
                    $expected = if ($dark) { [Drawing.Color]::FromArgb(33,33,33) } else { [Drawing.Color]::White }
                    if ($bitmap.GetPixel(0,0).ToArgb() -ne $expected.ToArgb()) { throw 'Theme background was not applied.' }
                    if ($PreviewDirectory -and $size[0] -eq 760) {
                        $name = 'cst-' + $(if ($chinese) { 'zh' } else { 'en' }) + '-' + $(if ($dark) { 'dark' } else { 'light' }) + '.png'
                        $bitmap.Save((Join-Path $PreviewDirectory $name), [Drawing.Imaging.ImageFormat]::Png)
                    }
                } finally { $bitmap.Dispose() }
            }
        }
    }
    # Empty state and a long list render through the same component as the live
    # window; neither showing the window nor changing the OS theme is necessary.
    Update-CstPanel -Panel $panel -Rows @() -Dark $true -Chinese $true
    $bitmap = $panel.RenderPreview(760,570)
    try { if ($PreviewDirectory) { $bitmap.Save((Join-Path $PreviewDirectory 'cst-empty.png'), [Drawing.Imaging.ImageFormat]::Png) } }
    finally { $bitmap.Dispose() }
    Update-CstPanel -Panel $panel -Rows ($rows * 15) -Dark $false -Chinese $false
    $bitmap = $panel.RenderPreview(530,381)
    $bitmap.Dispose()
    $close = [Windows.Forms.FormClosingEventArgs]::new([Windows.Forms.CloseReason]::UserClosing, $false)
    $method = $panel.GetType().GetMethod('OnFormClosing', [Reflection.BindingFlags]'Instance,NonPublic')
    [void]$method.Invoke($panel, @($close))
    if (!$close.Cancel -or $panel.IsDisposed) { throw 'Closing the panel must keep the tray component alive.' }
    $panel.AllowClose = $true
    $exit = [Windows.Forms.FormClosingEventArgs]::new([Windows.Forms.CloseReason]::UserClosing, $false)
    [void]$method.Invoke($panel, @($exit))
    if ($exit.Cancel) { throw 'Tray shutdown must allow final panel disposal.' }
    if ($panel.Visible) { throw 'Component tests unexpectedly displayed a window.' }
    if ([string]::IsNullOrWhiteSpace([CodexSessionToTerminal.SystemAppearance]::UiLanguage())) { throw 'Windows UI language was unavailable.' }
    'CST panel: native compilation, both themes/languages, resize/empty/long lists and hide-on-close passed. No window was shown.'
} finally { $panel.Dispose() }
