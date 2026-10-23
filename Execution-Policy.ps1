# Read another PowerShell host without passing quoted source through the Windows
# PowerShell 5.1 native argument formatter. Its -Command path drops inner quotes.
function Get-SessionBridgeRuntimePolicy {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RuntimePath)
    $probe = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $snapshot = [pscustomobject]@{
        EffectivePolicy = (Get-ExecutionPolicy).ToString()
        Scopes = @(Get-ExecutionPolicy -List | ForEach-Object {
            [pscustomobject]@{ Scope = $_.Scope.ToString(); ExecutionPolicy = $_.ExecutionPolicy.ToString() }
        })
    }
    [Console]::Out.Write(($snapshot | ConvertTo-Json -Depth 3 -Compress))
    exit 0
} catch { [Console]::Error.WriteLine('Execution policy probe failed.'); exit 1 }
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probe))
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $RuntimePath
    $info.Arguments = '-NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ' + $encoded
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = $null
    try {
        $process = [Diagnostics.Process]::Start($info)
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(15000)) {
            # Only the policy probe created above is ended; no application runs.
            try { $process.Kill(); [void]$process.WaitForExit(2000) } catch { }
            throw 'The PowerShell policy check timed out. No app was started or policy changed.'
        }
        if (!$output.Wait(1000) -or !$errors.Wait(1000) -or $process.ExitCode -ne 0 -or $errors.Result.Trim()) {
            throw 'Could not verify the selected PowerShell execution policy. No app was started or policy changed.'
        }
        try {
            $policy = $output.Result | ConvertFrom-Json -ErrorAction Stop
            if ($policy -isnot [pscustomobject] -or $policy.EffectivePolicy -isnot [string] -or
                $null -eq $policy.Scopes -or @($policy.Scopes).Count -ne 5) { throw 'Unexpected policy snapshot.' }
        } catch {
            throw 'The PowerShell policy check returned an invalid response. No app was started or policy changed.'
        }
        return $policy
    } finally { if ($process) { $process.Dispose() } }
}

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
