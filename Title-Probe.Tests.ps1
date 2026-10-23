#requires -Version 7.4
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'CST-Tray.ps1') -DefinitionsOnly
function New-ProbeFixture {
    param([string]$Text, [bool]$Exited=$true)
    $process=[pscustomobject]@{HasExited=$Exited;ExitCode=0;Killed=$false;Disposed=$false}
    $process | Add-Member ScriptMethod Kill { $this.Killed=$true }
    $process | Add-Member ScriptMethod Dispose { $this.Disposed=$true }
    $probe=@{Request=@{DesktopPid=123;SourceWindow=456L;DesktopStartTicks=639000000000000001L};At=[DateTime]::UtcNow;Process=$process
        Output=[Threading.Tasks.Task]::FromResult([string]$Text); Errors=[Threading.Tasks.Task]::FromResult([string]'')}
    return @{Probe=$probe;Process=$process}
}
$valid=@{version=1;status='ready';pid=123;window=456;started='639000000000000001';title='云端聊天 "🙂"';documentRuntimeId='42,7,9'} | ConvertTo-Json -Compress
$fixture=New-ProbeFixture $valid
$result=Receive-CstTitleProbe $fixture.Probe
$decoded=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($result.Context)) | ConvertFrom-Json
if ($decoded.title -cne '云端聊天 "🙂"' -or $decoded.started -cne '639000000000000001' -or !$decoded.capturedAt -or !$fixture.Process.Disposed) { throw 'Probe context lost title/generation or retained its child.' }
foreach ($text in @('{', $valid.Replace('"ready"','"unavailable"'), $valid.Replace('639000000000000001','639000000000000002'))) {
    $fixture=New-ProbeFixture $text
    if ((Receive-CstTitleProbe $fixture.Probe).Context -or !$fixture.Process.Disposed) { throw 'Invalid observation was accepted or child retained.' }
}
$fixture=New-ProbeFixture $valid $false
if ($null -ne (Receive-CstTitleProbe $fixture.Probe -Now $fixture.Probe.At.AddMilliseconds(1499))) { throw 'Pending UIA read blocked or completed prematurely.' }
if ((Receive-CstTitleProbe $fixture.Probe -Now $fixture.Probe.At.AddMilliseconds(1500)).Context -or !$fixture.Process.Killed -or !$fixture.Process.Disposed) { throw 'Timeout did not stop only the owned helper and fall back.' }
$args=@(Get-CstCloudTerminalArguments -ControlDirectory $PSScriptRoot -PowerShellPath 'C:\pwsh.exe' -BackendPath 'C:\codex.exe' -TitleContext $result.Context)
if ($args.Count -ne 9 -or $args[7] -cne '--title-context' -or $args[8] -cne $result.Context) { throw 'Title context was not a separate literal argument.' }
'Title probe: exact context, invalid data, bounded polling, owned-child cleanup and literal arguments passed; no UI accessed.'
