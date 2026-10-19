# Loaded by production.ps1. Discovery never changes the installed application.
function Get-SessionBridgePowerShell {
    $command = Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates = @(
        (Join-Path $PSScriptRoot 'runtime\powershell\pwsh.exe')
        $(if ($command) { $command.Source })
        (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe')
        (Join-Path $env:LOCALAPPDATA 'Microsoft\PowerShell\7\pwsh.exe')
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique
    foreach ($candidate in $candidates) {
        $versionText = & $candidate -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
        $version = $null
        if ($LASTEXITCODE -eq 0 -and [Version]::TryParse(($versionText | Out-String).Trim(), [ref]$version) -and $version -ge [Version]'7.4') {
            return $candidate
        }
    }
    throw 'PowerShell 7.4 or newer was not found. Repair this installation, or install PowerShell 7 when running from source.'
}

function Get-SessionBridgeNode {
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates = @(
        (Join-Path $PSScriptRoot 'runtime\node\node.exe')
        $(if ($command) { $command.Source })
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\node\node.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique
    foreach ($candidate in $candidates) {
        $version = (& $candidate --version 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return $candidate }
    }
    throw 'Node.js 22 or newer was not found. Install Node.js and make node.exe available on PATH.'
}

function Get-SessionBridgeInstalledCli {
    param([Parameter(Mandatory)][string]$PackageInstallLocation)
    # Use the backend shipped by this installed package, never a potentially
    # stale AppData cache selected by directory timestamp or matching version.
    $candidate = Join-Path $PackageInstallLocation 'app\resources\codex.exe'
    if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw 'The installed Desktop package does not contain app\resources\codex.exe. Its backend layout needs compatibility review; no application was changed.'
    }
    return $candidate
}

function Invoke-SessionBridgeCliProbe {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string[]]$Arguments,
        [ValidateRange(100,30000)][int]$TimeoutMilliseconds = 10000
    )
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'A required Codex executable is missing.' }
    # Help/version checks must not touch the user's normal Codex home. Only
    # this short-lived child is terminated if it fails to exit in time.
    $probeParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    $probeName = 'session-bridge-probe-' + [Guid]::NewGuid().ToString('N')
    $probeHome = Join-Path $probeParent $probeName
    [void](New-Item -ItemType Directory -Path $probeHome)
    $process = $null
    try {
        $info = [Diagnostics.ProcessStartInfo]::new($Path)
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.WorkingDirectory = $probeHome
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.Environment['CODEX_HOME'] = $probeHome
        foreach ($name in @('CODEX_CLI_PATH','CODEX_APP_SERVER_FORCE_CLI','CODEX_APP_SERVER_WS_URL','CODEX_THREAD_ID','CODEX_SESSION_ID','CODEX_SHARED_SESSION_CONFIG','CODEX_SHARED_SESSION_GENERATION')) {
            [void]$info.Environment.Remove($name)
        }
        foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
        $process = [Diagnostics.Process]::Start($info)
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill($true); [void]$process.WaitForExit(2000) } catch { }
            throw 'The Codex compatibility check timed out. No Desktop process was stopped.'
        }
        if ($process.ExitCode -ne 0) { throw "The Codex compatibility check exited with code $($process.ExitCode). No Desktop process was changed." }
        if (!$stdout.Wait(1000) -or !$stderr.Wait(1000)) { throw 'The Codex compatibility check did not close its output streams.' }
        return $stdout.Result
    } finally {
        if ($process) { $process.Dispose() }
        # The cleanup target is generated here, not read from configuration.
        # Verify its absolute parent and name before any recursive removal.
        $resolvedProbe = [IO.Path]::GetFullPath($probeHome)
        $safeParent = [IO.Path]::GetDirectoryName($resolvedProbe).Equals($probeParent, [StringComparison]::OrdinalIgnoreCase)
        if ($safeParent -and [IO.Path]::GetFileName($resolvedProbe) -ceq $probeName -and $probeName -match '^session-bridge-probe-[a-f0-9]{32}$' -and
            (Test-Path -LiteralPath $resolvedProbe) -and !((Get-Item -LiteralPath $resolvedProbe -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $resolvedProbe -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Assert-SessionBridgeCliCapabilities {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('Backend','Client')][string]$Role,
        [ValidateRange(100,30000)][int]$TimeoutMilliseconds = 10000
    )
    $version = (Invoke-SessionBridgeCliProbe -Path $Path -Arguments @('--version') -TimeoutMilliseconds $TimeoutMilliseconds).Trim()
    if ($version -notmatch '^codex-cli ([^\r\n]+)$') { throw "The $Role executable did not identify itself as Codex CLI." }
    $versionNumber = $Matches[1]
    $helpArguments = if ($Role -eq 'Backend') { @('app-server','--help') } else { @('--help') }
    $requiredFlags = if ($Role -eq 'Backend') { @('--listen','--ws-auth','--ws-token-file') } else { @('--remote','--remote-auth-token-env') }
    $help = Invoke-SessionBridgeCliProbe -Path $Path -Arguments $helpArguments -TimeoutMilliseconds $TimeoutMilliseconds
    foreach ($flag in $requiredFlags) {
        # Require an option declaration, not a mention in prose or a longer flag.
        $pattern = '(?m)^\s*(?:-\w,\s*)?' + [regex]::Escape($flag) + '(?=[\s=\[]|$)'
        if ($help -notmatch $pattern) { throw "The $Role Codex CLI lacks required option $flag. This launcher cannot use it safely; no Desktop process was changed." }
    }
    [pscustomobject]@{ Path=$Path; Version=$versionNumber; Role=$Role; RequiredFlags=$requiredFlags }
}

function Get-SessionBridgeCompiler {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The Windows .NET Framework 4 C# compiler is required.' }
    return $compiler
}
