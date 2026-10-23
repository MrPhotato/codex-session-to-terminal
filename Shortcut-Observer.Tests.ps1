# Pure decision tests only. Never construct the listener or call native APIs.
$ErrorActionPreference = 'Stop'
$watcherText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Watch-Chat-Link.ps1') -Raw
$nativeMatch = [regex]::Match($watcherText, '(?ms)^\$nativeSource = @''\r?\n(?<source>.*?)\r?\n''@')
if (!$nativeMatch.Success) { throw 'Native observer source literal was not found.' }
if (!('CodexSharedSession.ShortcutChordState' -as [type])) {
    Add-Type -TypeDefinition $nativeMatch.Groups['source'].Value
}

function Assert-Shortcut([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}
function Set-TestModifiers($State, [ushort]$Control = 0xA2, [ushort]$Alt = 0xA4) {
    [void]$State.Observe($Control, 0, 0, $true)
    [void]$State.Observe($Alt, 0, 0, $true)
}

foreach ($control in @(0xA2, 0xA3)) {
    foreach ($alt in @(0xA4, 0xA5)) {
        $state = [CodexSharedSession.ShortcutChordState]::new()
        Set-TestModifiers $state $control $alt
        Assert-Shortcut ($state.Observe(0x4C, 0x26, 0, $true)) 'Exact left/right Ctrl+Alt+L was not accepted.'
        Assert-Shortcut (!$state.Observe(0x4C, 0x26, 0, $true)) 'Held L repeated a shortcut.'
        [void]$state.Observe(0x4C, 0x26, 1, $true)
        Assert-Shortcut ($state.Observe(0x4C, 0x26, 0, $true)) 'A new L press after release was lost.'
    }
}
foreach ($extra in @(0xA0, 0xA1, 0x5B, 0x5C)) {
    $state = [CodexSharedSession.ShortcutChordState]::new()
    Set-TestModifiers $state
    [void]$state.Observe($extra, 0, 0, $true)
    Assert-Shortcut (!$state.Observe(0x4C, 0, 0, $true)) 'Shift/Windows modified shortcut was accepted.'
    [void]$state.Observe($extra, 0, 1, $true)
    Assert-Shortcut (!$state.Observe(0x4C, 0, 0, $true)) 'Modifier release retriggered held L.'
    [void]$state.Observe(0x4C, 0, 1, $true)
    Assert-Shortcut ($state.Observe(0x4C, 0, 0, $true)) 'Exact chord after modifier release was lost.'
}
foreach ($missing in @('ctrl', 'alt', 'both')) {
    $state = [CodexSharedSession.ShortcutChordState]::new()
    if ($missing -eq 'ctrl') { [void]$state.Observe(0xA4, 0, 0, $true) }
    if ($missing -eq 'alt') { [void]$state.Observe(0xA2, 0, 0, $true) }
    Assert-Shortcut (!$state.Observe(0x4C, 0, 0, $true)) 'Incomplete modifier chord was accepted.'
}

$state = [CodexSharedSession.ShortcutChordState]::new()
[void]$state.Observe(0x11, 0x1D, 2, $true)
[void]$state.Observe(0x12, 0x38, 2, $true)
Assert-Shortcut ($state.Observe(0x4C, 0x26, 0, $true)) 'Raw generic right Ctrl/Alt mapping failed.'
[void]$state.Observe(0x4C, 0x26, 1, $true)
[void]$state.Observe(0x10, 0x36, 0, $true)
Assert-Shortcut (!$state.Observe(0x4C, 0, 0, $true)) 'Raw generic right Shift was ignored.'

$state = [CodexSharedSession.ShortcutChordState]::new()
Set-TestModifiers $state
[void]$state.Observe(0xA3, 0, 0, $true)
[void]$state.Observe(0xA2, 0, 1, $true)
Assert-Shortcut ($state.Observe(0x4C, 0, 0, $true)) 'Releasing one Ctrl incorrectly released the other.'

$state = [CodexSharedSession.ShortcutChordState]::new()
Set-TestModifiers $state
Assert-Shortcut (!$state.Observe(0x4C, 0, 0, $false)) 'An unrelated foreground window triggered the shortcut.'
Assert-Shortcut (!$state.Observe(0x4C, 0, 0, $true)) 'Focus switch retriggered a key held elsewhere.'
[void]$state.Observe(0x4C, 0, 1, $true)
$state.ResetModifiers()
Assert-Shortcut (!$state.Observe(0x4C, 0, 0, $true)) 'Focus reset retained stale Ctrl/Alt modifiers.'
[void]$state.Observe(0x4C, 0, 1, $true)
Set-TestModifiers $state
Assert-Shortcut ($state.Observe(0x4C, 0, 0, $true)) 'Rebased modifiers did not recover the shortcut.'

$state = [CodexSharedSession.ShortcutChordState]::new()
Set-TestModifiers $state
foreach ($key in @(0x41, 0x42, 0x0D, 0x20, 0xFF)) {
    Assert-Shortcut (!$state.Observe($key, 0, 0, $true)) 'An unrelated key emitted a shortcut.'
}
Assert-Shortcut (!$state.Observe(0x4C, 0xFF, 0, $true)) 'Keyboard overrun was accepted.'
Assert-Shortcut (!$state.Observe(0x4C, 0, 4, $true)) 'Unexpected E1 packet was accepted.'
Assert-Shortcut ($state.Observe(0x4C, 0, 0, $true)) 'Ignored input corrupted chord state.'

$listenerType = [CodexSharedSession.ClipboardLinkListener]
Assert-Shortcut ($null -ne $listenerType.GetConstructor([type[]]@([uint32]))) 'Legacy one-argument constructor is missing.'
Assert-Shortcut ($null -ne $listenerType.GetConstructor([type[]]@([uint32], [bool]))) 'Explicit opt-in constructor is missing.'
Assert-Shortcut ($listenerType.GetEvent('ShortcutPressed').EventHandlerType -eq [Action]) 'Shortcut event signature changed.'
'Shortcut observer pure tests passed; no keyboard registration or window operations were performed.'
