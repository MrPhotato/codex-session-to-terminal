# Loaded by production.ps1. Discovery never changes the installed application.
function Get-SessionBridgeNode {
    $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates = @(
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
    param([Parameter(Mandatory)][string]$ExpectedVersion)
    $installRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $installRoot -PathType Container) {
        $candidates = Get-ChildItem -LiteralPath $installRoot -Directory | Sort-Object LastWriteTimeUtc -Descending |
            ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
        foreach ($candidate in $candidates) {
            $version = (& $candidate --version 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $version -ceq "codex-cli $ExpectedVersion") { return $candidate }
        }
    }
    throw "The Desktop's matching CLI ($ExpectedVersion) was not found. Open Desktop normally once to finish its installation, then retry Prepare."
}

function Get-SessionBridgeCompiler {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The Windows .NET Framework 4 C# compiler is required.' }
    return $compiler
}
