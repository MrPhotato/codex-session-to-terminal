$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Execution-Policy.ps1')
$scopeNames = @('MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine')
function New-TestPolicySnapshot {
    param([hashtable]$Overrides = @{})
    @($scopeNames | ForEach-Object {
        [pscustomobject]@{ Scope = $_; ExecutionPolicy = $(if ($Overrides.ContainsKey($_)) { $Overrides[$_] } else { 'Undefined' }) }
    })
}
$cases = @(
    @{ Name = 'Unconfigured Windows Restricted default'; Overrides = @{}; Effective = 'Restricted'; Expected = 'RemoteSigned' }
    @{ Name = 'Unconfigured host RemoteSigned default'; Overrides = @{}; Effective = 'RemoteSigned'; Expected = $null }
    @{ Name = 'Inherited usable process policy'; Overrides = @{ Process = 'RemoteSigned' }; Effective = 'RemoteSigned'; Expected = $null }
    @{ Name = 'Configured usable user policy'; Overrides = @{ CurrentUser = 'RemoteSigned' }; Effective = 'RemoteSigned'; Expected = $null }
    @{ Name = 'Group Policy RemoteSigned is retained'; Overrides = @{ MachinePolicy = 'RemoteSigned' }; Effective = 'RemoteSigned'; Expected = $null }
)
foreach ($case in $cases) {
    $actual = Get-SessionBridgeProcessPolicy -Scopes (New-TestPolicySnapshot $case.Overrides) -EffectivePolicy $case.Effective
    if ($actual -cne $case.Expected) { throw "Policy decision failed: $($case.Name)." }
}
foreach ($scope in $scopeNames) {
    foreach ($restriction in @('Restricted', 'AllSigned')) {
        # An inherited permissive process policy must not hide a persistent opt-in.
        $overrides = @{ Process = 'RemoteSigned' }
        $overrides[$scope] = $restriction
        $caught = ''
        try { Get-SessionBridgeProcessPolicy -Scopes (New-TestPolicySnapshot $overrides) -EffectivePolicy 'RemoteSigned' | Out-Null }
        catch { $caught = $_.ToString() }
        if ($caught -notlike '*blocked by a configured PowerShell execution policy*') { throw "Explicit $scope $restriction was not preserved." }
    }
}
$caught = ''
try { Get-SessionBridgeProcessPolicy -Scopes @([pscustomobject]@{ Scope='Process'; ExecutionPolicy='Undefined' }) -EffectivePolicy 'Restricted' | Out-Null }
catch { $caught = $_.ToString() }
if ($caught -notlike '*could not be verified*') { throw 'An incomplete policy snapshot did not fail closed.' }

'Execution-policy decisions passed: only an unconfigured Restricted default receives process RemoteSigned; every explicit Restricted/AllSigned is preserved. No host policies were read or changed.'
