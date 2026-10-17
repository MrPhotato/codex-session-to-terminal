$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Terminal-Focus.ps1')

# Synthetic window records and injected callbacks only. Compiling the native
# helper is safe; no test invokes any native window API or launches an app.
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

Initialize-CodexTerminalFocus
if (![CodexSharedSession.TerminalWindow].GetField('ProcessStartTicks')) {
    throw 'Terminal snapshots must retain the process incarnation used for mutation guards.'
}

$raiseCases = @(
    @{ Name = 'Invalid identity prevents every mutation'; Guard = 'TargetInvalid'; Promote = 'RaiseRequested'; Cleanup = 'Demoted'; Expected = 'TargetInvalid'; Calls = 'guard' }
    @{ Name = 'Preserve a pre-existing topmost setting'; Guard = 'AlreadyTopmost'; Promote = 'RaiseRequested'; Cleanup = 'Demoted'; Expected = 'AlreadyTopmost'; Calls = 'guard' }
    @{ Name = 'Promotion always precedes demotion'; Guard = 'Ready'; Promote = 'RaiseRequested'; Cleanup = 'Demoted'; Expected = 'RaiseRequested'; Calls = 'guard,promote,cleanup' }
    @{ Name = 'User switch after promotion still cleans up'; Guard = 'Ready'; Promote = 'SourceWindowChanged'; Cleanup = 'Demoted'; Expected = 'SourceWindowChanged'; Calls = 'guard,promote,cleanup' }
    @{ Name = 'Rejected promotion still attempts cleanup'; Guard = 'Ready'; Promote = 'PromotionApiRejected'; Cleanup = 'Demoted'; Expected = 'PromotionApiRejected'; Calls = 'guard,promote,cleanup' }
    @{ Name = 'Unconfirmed cleanup cannot report success'; Guard = 'Ready'; Promote = 'RaiseRequested'; Cleanup = 'DemotionNotObserved'; Expected = 'RaiseRequested/DemotionNotObserved'; Calls = 'guard,promote,cleanup' }
    @{ Name = 'Cleanup identity failure remains visible'; Guard = 'Ready'; Promote = 'TargetInvalid'; Cleanup = 'CleanupTargetInvalid'; Expected = 'TargetInvalid/CleanupTargetInvalid'; Calls = 'guard,promote,cleanup' }
    @{ Name = 'Promotion exception still runs finally'; Guard = 'Ready'; Promote = 'throw'; Cleanup = 'Demoted'; Expected = 'PromotionError'; Calls = 'guard,promote,cleanup' }
    @{ Name = 'Promotion exception preserves cleanup failure'; Guard = 'Ready'; Promote = 'throw'; Cleanup = 'DemotionNotObserved'; Expected = 'PromotionError/DemotionNotObserved'; Calls = 'guard,promote,cleanup' }
    @{ Name = 'Cleanup exception cannot mask promotion status'; Guard = 'Ready'; Promote = 'RaiseRequested'; Cleanup = 'throw'; Expected = 'RaiseRequested/CleanupError'; Calls = 'guard,promote,cleanup' }
    @{ Name = 'Both exceptions retain both failure labels'; Guard = 'Ready'; Promote = 'throw'; Cleanup = 'throw'; Expected = 'PromotionError/CleanupError'; Calls = 'guard,promote,cleanup' }
)
foreach ($case in $raiseCases) {
    $calls = [Collections.Generic.List[string]]::new()
    $guard = [Func[string]]{ $calls.Add('guard'); return $case.Guard }
    $promote = [Func[string]]{
        $calls.Add('promote')
        if ($case.Promote -eq 'throw') { throw 'Synthetic promotion failure' }
        return $case.Promote
    }
    $cleanup = [Func[string]]{
        $calls.Add('cleanup')
        if ($case.Cleanup -eq 'throw') { throw 'Synthetic cleanup failure' }
        return $case.Cleanup
    }
    $result = [CodexSharedSession.TerminalWindows]::RunTemporaryRaise($guard, $promote, $cleanup)
    if ($result -cne $case.Expected -or ($calls -join ',') -cne $case.Calls) {
        throw "Temporary raise failed: $($case.Name). Result=$result; calls=$($calls -join ',')."
    }
}

"Terminal focus: $($cases.Count) selection and $($raiseCases.Count) guard/cleanup tests passed; native source compiled. No native window APIs were called."
