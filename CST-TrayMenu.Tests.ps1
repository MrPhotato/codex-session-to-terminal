param([string]$PreviewDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing.Common
if (-not ('CodexSessionToTerminal.TrayMenu' -as [type])) {
    $references = @('System.Windows.Forms', 'System.Drawing.Common', 'System.Drawing.Primitives', 'System.ComponentModel.Primitives', 'System.ComponentModel')
    foreach ($name in @('System.Windows.Forms.Primitives.dll', 'System.Private.Windows.Core.dll', 'System.Private.Windows.GdiPlus.dll')) {
        $reference = Join-Path $PSHOME $name
        if (Test-Path -LiteralPath $reference -PathType Leaf) { $references += $reference }
    }
    Add-Type -Path (Join-Path $PSScriptRoot 'CST-TrayMenu.cs') -ReferencedAssemblies $references
}
if ($PreviewDirectory) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($PreviewDirectory)) }
$menu = [CodexSessionToTerminal.TrayMenu]::new()
try {
    if ($menu -isnot [Windows.Forms.ContextMenuStrip]) { throw 'The tray menu must remain a native ContextMenuStrip.' }
    if ($menu.AccessibleName -ne 'Codex Session to Terminal') { throw 'The full product name must be exposed.' }
    $actions = @($menu.Items | Where-Object { $_ -is [Windows.Forms.ToolStripMenuItem] })
    if ($actions.Count -ne 3) { throw 'The menu must expose local sessions, read-only cloud sessions, and exit.' }
    if ($menu.CloudSessionsItem.Enabled) { throw 'Cloud selection must be disabled until Desktop is ready.' }
    $menu.UpdateAppearance($false, $false, $true)
    foreach ($item in $actions) {
        if (!$item.CanSelect -or !$item.Enabled) { throw 'Native menu actions must retain selection and keyboard navigation.' }
    }
    foreach ($item in @($menu.Items | Where-Object { $_ -is [Windows.Forms.ToolStripLabel] })) {
        if ($item.CanSelect -or !$item.Enabled) { throw 'Information labels must be readable and non-selectable, not disabled commands.' }
    }
    foreach ($chinese in @($true, $false)) {
        foreach ($dark in @($true, $false)) {
            foreach ($ready in @($true, $false)) {
                $menu.UpdateAppearance($dark, $chinese, $ready)
                $expectedStatus = if ($ready) { if ($chinese) { '已就绪' } else { 'Ready' } } else { if ($chinese) { '等待' } else { 'Waiting' } }
                if ($menu.AccessibleDescription -notmatch $expectedStatus) { throw 'Desktop readiness was not reflected truthfully.' }
                $expectedCloudLabel = if ($chinese) { '打开云端只读会话' } else { 'Open online read-only session' }
                if ($menu.CloudSessionsItem.Text -cne $expectedCloudLabel -or
                    $menu.CloudSessionsItem.AccessibleName -cne $expectedCloudLabel -or
                    $menu.CloudSessionsItem.Enabled -ne $ready) { throw 'The cloud action must be localized, accessible, and enabled only when Desktop is ready.' }
                if (($menu.Items | Where-Object { $_.Text -match '(^|\W)CST(\W|$)' }).Count) { throw 'The menu must not use the product abbreviation.' }
                $heading = @($menu.Items | Where-Object { $_.Tag -eq 'heading' })[0]
                if ($heading.Text -ne 'Codex Session to Terminal') { throw 'The menu must retain the unabbreviated brand.' }
                $measured = [Windows.Forms.TextRenderer]::MeasureText($heading.Text, $heading.Font, [Drawing.Size]::Empty,
                    [Windows.Forms.TextFormatFlags]'NoPadding,SingleLine')
                if ($measured.Width -gt ($heading.Width - $heading.Padding.Horizontal)) { throw 'The brand does not fit in the menu.' }
                $cloudMeasured = [Windows.Forms.TextRenderer]::MeasureText($menu.CloudSessionsItem.Text, $menu.CloudSessionsItem.Font, [Drawing.Size]::Empty,
                    [Windows.Forms.TextFormatFlags]'NoPadding,SingleLine')
                $actionScale = $menu.CloudSessionsItem.Font.Size / 13
                $actionTextWidth = $menu.CloudSessionsItem.Width - [Math]::Round(38 * $actionScale) - [Math]::Round(9 * $actionScale)
                if ($cloudMeasured.Width -gt $actionTextWidth) { throw 'The cloud action label does not fit in the compact menu.' }
                foreach ($dpiScale in @(1.0, 1.25, 1.5, 2.0)) {
                    $bitmap = $menu.RenderPreview([single]$dpiScale)
                    try {
                        if ($bitmap.Width -ne [Math]::Round(280 * $dpiScale)) { throw "Incorrect menu width at scale $dpiScale." }
                        if (!$([Windows.Forms.SystemInformation]::HighContrast)) {
                            $expected = if ($dark) { [Drawing.Color]::FromArgb(33,33,35) } else { [Drawing.Color]::FromArgb(252,252,253) }
                            if ($bitmap.GetPixel(2,2).ToArgb() -ne $expected.ToArgb()) { throw 'Menu theme background was not rendered.' }
                        }
                        if ($PreviewDirectory -and $ready) {
                            $name = 'tray-menu-' + $(if ($chinese) { 'zh' } else { 'en' }) + '-' + $(if ($dark) { 'dark' } else { 'light' }) + '-' + [int]($dpiScale * 100) + '.png'
                            $bitmap.Save((Join-Path $PreviewDirectory $name), [Drawing.Imaging.ImageFormat]::Png)
                        }
                    } finally { $bitmap.Dispose() }
                }
            }
        }
    }
    $menu.UpdateAppearance($true, $true, $true)
    $previousFont = $menu.Font
    $previousSize = $menu.Size
    $menu.UpdateAppearance($true, $true, $true)
    if (![object]::ReferenceEquals($previousFont, $menu.Font) -or $previousSize -ne $menu.Size) { throw 'Unchanged polling updates must not recreate fonts or layout.' }
    $menu.UpdateAppearance($true, $true, $false)
    if (![object]::ReferenceEquals($previousFont, $menu.Font)) { throw 'Readiness updates must not recreate unchanged fonts.' }
    $menu.UpdateAppearance($true, $true, $true)
    $expectedHint = @($menu.Items | Where-Object { $_.Tag -eq 'hint' })[0].Text
    if ($expectedHint -ne '在 ChatGPT 中按 Ctrl+Alt+L') { throw 'Shortcut instructions must explain where the key is pressed.' }
    $script:menuActionClicks = 0
    $handler = { $script:menuActionClicks++ }
    $menu.SessionsItem.add_Click($handler)
    $menu.SessionsItem.PerformClick()
    $menu.SessionsItem.remove_Click($handler)
    if ($script:menuActionClicks -ne 1) { throw 'The public native menu action cannot be bound.' }
    $script:cloudActionClicks = 0
    $cloudHandler = { $script:cloudActionClicks++ }
    $menu.CloudSessionsItem.add_Click($cloudHandler)
    $menu.UpdateAppearance($true, $true, $false)
    $menu.CloudSessionsItem.PerformClick()
    if ($script:cloudActionClicks -ne 0) { throw 'Disabled cloud selection must not dispatch a click.' }
    $menu.UpdateAppearance($true, $true, $true)
    $menu.CloudSessionsItem.PerformClick()
    $menu.CloudSessionsItem.remove_Click($cloudHandler)
    if ($script:cloudActionClicks -ne 1) { throw 'The enabled cloud action cannot be bound.' }
    $menu.SessionsItem.Select()
    if (!$menu.SessionsItem.Selected) { throw 'The menu item must retain native selection.' }
    $selected = $menu.RenderPreview(1)
    try {
        if ($PreviewDirectory) { $selected.Save((Join-Path $PreviewDirectory 'tray-menu-zh-dark-selected-100.png'), [Drawing.Imaging.ImageFormat]::Png) }
    } finally { $selected.Dispose() }
    if ($menu.Visible) { throw 'Offscreen tests must not display or focus the menu.' }
    'Tray menu: native actions, accessibility, themes, languages, readiness and 100/125/150/200 percent offscreen rendering passed.'
} finally { $menu.Dispose() }
