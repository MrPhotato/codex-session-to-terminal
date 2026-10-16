$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Terminal-Focus.ps1')

# Synthetic window records only. Do not initialize the native helper, enumerate
# actual windows, launch a process, or invoke any foreground/window APIs here.
function New-TestTerminalWindow {
    param(
        [long]$Handle,
        [string]$Title = 'Codex CLI test-window',
        [string]$ProcessName = 'WindowsTerminal',
        [string]$ClassName = 'CASCADIA_HOSTING_WINDOW_CLASS',
        [int]$ProcessId = 7
    )
    [pscustomobject]@{
        Handle = $Handle
        Title = $Title
        ProcessName = $ProcessName
        ClassName = $ClassName
        ProcessId = $ProcessId
    }
}

$title = 'Codex CLI test-window'
$old = New-TestTerminalWindow -Handle 100
$new = New-TestTerminalWindow -Handle 200
$powerShellWindow = New-TestTerminalWindow -Handle 400 -Title 'PowerShell' -ProcessName 'pwsh' -ClassName 'ConsoleWindowClass' -ProcessId 99
$cases = @(
    @{
        Name = 'Select only the new exact Windows Terminal window'
        Input = @{ Windows = @($old, $new); BeforeHandles = @(100) }
        Status = 'Found'; Handle = 200
    }
    @{
        Name = 'Ignore an existing terminal even when its title matches'
        Input = @{ Windows = @($old); BeforeHandles = @(100) }
        Status = 'Pending'
    }
    @{
        Name = 'Reject ambiguous new windows instead of choosing one'
        Input = @{ Windows = @($new, (New-TestTerminalWindow -Handle 300)); BeforeHandles = @() }
        Status = 'Ambiguous'
    }
    @{
        Name = 'Reject a terminal with a different title'
        Input = @{ Windows = @((New-TestTerminalWindow -Handle 200 -Title 'Another window')); BeforeHandles = @() }
        Status = 'Pending'
    }
    @{
        Name = 'Reject a different process using the expected title and class'
        Input = @{ Windows = @((New-TestTerminalWindow -Handle 200 -ProcessName 'notepad')); BeforeHandles = @() }
        Status = 'Pending'
    }
    @{
        Name = 'Reject a different window class'
        Input = @{ Windows = @((New-TestTerminalWindow -Handle 200 -ClassName 'OtherClass')); BeforeHandles = @() }
        Status = 'Pending'
    }
    @{
        Name = 'Reject a null window handle'
        Input = @{ Windows = @((New-TestTerminalWindow -Handle 0)); BeforeHandles = @() }
        Status = 'Pending'
    }
    @{
        Name = 'Fallback selects only its created process window'
        Input = @{ Windows = @($powerShellWindow, $new); BeforeHandles = @(); Mode = 'PowerShell'; CreatedProcessWindow = 400; CreatedProcessId = 99 }
        Status = 'Found'; Handle = 400
    }
    @{
        Name = 'Fallback rejects the correct handle with a different process'
        Input = @{ Windows = @($powerShellWindow); BeforeHandles = @(); Mode = 'PowerShell'; CreatedProcessWindow = 400; CreatedProcessId = 98 }
        Status = 'Pending'
    }
    @{
        Name = 'Fallback rejects an already existing window'
        Input = @{ Windows = @($powerShellWindow); BeforeHandles = @(400); Mode = 'PowerShell'; CreatedProcessWindow = 400; CreatedProcessId = 99 }
        Status = 'Pending'
    }
)

foreach ($case in $cases) {
    $parameters = $case.Input
    $result = Select-CodexNewTerminalWindow @parameters -WindowTitle $title
    if ($result.Status -cne $case.Status) {
        throw "Terminal selection failed: $($case.Name). Expected $($case.Status), got $($result.Status)."
    }
    if ($case.Status -eq 'Found') {
        if ($null -eq $result.Window -or $result.Window.Handle -ne $case.Handle) {
            throw "Terminal selection returned the wrong window: $($case.Name)."
        }
    } elseif ($null -ne $result.Window) {
        throw "Terminal selection returned a window for an unconfirmed match: $($case.Name)."
    }
}

"Terminal focus selection: $($cases.Count) pure tests passed. No native window APIs were called."
