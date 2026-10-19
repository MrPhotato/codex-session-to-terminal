$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Start-Flow.ps1')

# Exercise only injected callbacks. No process lookup, configuration, or app launch.
$cases = @(
    @{ Name = 'First start prepares before launch'; Running = @(); Fail = ''; Calls = 'check,prepare,launch'; Error = '' }
    @{ Name = 'Existing Desktop prevents preparation'; Running = @([pscustomobject]@{ pid = 42 }); Fail = ''; Calls = 'check'; Error = '*ChatGPT is already running*' }
    @{ Name = 'Preparation failure prevents launch'; Running = @(); Fail = 'prepare'; Calls = 'check,prepare'; Error = '*fixture prepare failure*' }
    @{ Name = 'Launch failure is propagated'; Running = @(); Fail = 'launch'; Calls = 'check,prepare,launch'; Error = '*fixture launch failure*' }
    @{ Name = 'Unreadable process inventory fails closed'; Running = @(); Fail = 'check'; Calls = 'check'; Error = '*fixture check failure*' }
)
foreach ($case in $cases) {
    $calls = [Collections.Generic.List[string]]::new()
    $caught = ''
    try {
        Invoke-SessionBridgeStart -GetRunningDesktop {
            $calls.Add('check')
            if ($case.Fail -eq 'check') { throw 'fixture check failure' }
            $case.Running
        } -Prepare {
            $calls.Add('prepare')
            if ($case.Fail -eq 'prepare') { throw 'fixture prepare failure' }
        } -Launch {
            $calls.Add('launch')
            if ($case.Fail -eq 'launch') { throw 'fixture launch failure' }
        }
    } catch { $caught = $_.ToString() }
    if (($calls -join ',') -cne $case.Calls) { throw "Start order failed: $($case.Name)." }
    if (($case.Error -eq '' -and $caught -ne '') -or ($case.Error -ne '' -and $caught -notlike $case.Error)) {
        throw "Start failure propagation failed: $($case.Name)."
    }
}

# Exercise the real action dispatch with command stubs. These cases must stop
# before the launcher reads or writes any private configuration or starts a process.
foreach ($commandLine in @('fixture ChatGPT.exe', $null)) {
foreach ($action in @('Start', 'Prepare', 'Launch')) {
    $caught = ''
    try {
        & {
            function Get-CimInstance { [pscustomobject]@{ CommandLine = $commandLine } }
            function Get-AppxPackage { throw 'Private preparation was reached despite the running Desktop.' }
            function Start-Process { throw 'An application launch was attempted.' }
            & (Join-Path $PSScriptRoot 'production.ps1') -Action $action
        }
    } catch { $caught = $_.ToString() }
    if ($caught -notlike '*ChatGPT is already running*') { throw "Existing Desktop guard failed for $action." }
}
}

$caught = ''
try {
    & {
        function Get-CimInstance { }
        function Get-AppxPackage {
            [pscustomobject]@{
                Version = [Version]'99.99.99.99'
                InstallLocation = Join-Path ([IO.Path]::GetTempPath()) ('session-bridge-missing-package-' + [Guid]::NewGuid().ToString('N'))
            }
        }
        function Start-Process { throw 'An application launch was attempted.' }
        & (Join-Path $PSScriptRoot 'production.ps1') -Action Start
    }
} catch { $caught = $_.ToString() }
if ($caught -notlike '*unsupported application layout*') { throw 'Start did not reject an unsupported package layout before setup or launch.' }

'Start checks passed: running Desktop and unreadable command lines block all mutations; setup precedes launch; failures and unsupported package layouts stop the flow. Command stubs only.'
