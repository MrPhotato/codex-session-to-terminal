# Decide from a supplied snapshot, so tests never change host execution policies.
function Get-SessionBridgeProcessPolicy {
    param(
        [Parameter(Mandatory)][object[]]$Scopes,
        [Parameter(Mandatory)][string]$EffectivePolicy
    )
    $requiredScopes = @('MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine')
    $policies = @{}
    foreach ($scope in $Scopes) {
        $name = [string]$scope.Scope
        $value = [string]$scope.ExecutionPolicy
        if ($name -notin $requiredScopes -or $policies.ContainsKey($name) -or
            $value -notin @('Undefined', 'Restricted', 'AllSigned', 'RemoteSigned', 'Unrestricted', 'Bypass')) {
            throw 'PowerShell execution policy could not be verified. No policies were changed.'
        }
        $policies[$name] = $value
    }
    if ($policies.Count -ne $requiredScopes.Count) { throw 'PowerShell execution policy could not be verified. No policies were changed.' }
    if (@($policies.Values | Where-Object { $_ -in @('Restricted', 'AllSigned') }).Count) {
        throw 'Codex Session to Terminal is blocked by a configured PowerShell execution policy (Restricted or AllSigned). Ask your administrator for an approved configuration or signed build. No policies were changed.'
    }
    if ($EffectivePolicy -eq 'Restricted' -and @($policies.Values | Where-Object { $_ -ne 'Undefined' }).Count -eq 0) {
        return 'RemoteSigned'
    }
    if ($EffectivePolicy -notin @('RemoteSigned', 'Unrestricted', 'Bypass')) {
        throw 'PowerShell execution policy does not allow this launcher. No policies were changed.'
    }
    return $null
}
