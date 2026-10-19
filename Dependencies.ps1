function Test-SessionBridgeDependencies {
    param(
        [Parameter(Mandatory)][string]$ApplicationRoot,
        [Parameter(Mandatory)][string]$ExpectedCliVersion
    )
    $requiredFiles = @(
        'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
        'node_modules\ws\index.js'
        'node_modules\ajv\dist\ajv.js'
    )
    foreach ($relativePath in $requiredFiles) {
        if (!(Test-Path -LiteralPath (Join-Path $ApplicationRoot $relativePath) -PathType Leaf)) { return $false }
    }
    try {
        $manifest = Get-Content -LiteralPath (Join-Path $ApplicationRoot 'package.json') -Raw | ConvertFrom-Json
        $cli = Get-Content -LiteralPath (Join-Path $ApplicationRoot 'node_modules\@openai\codex\package.json') -Raw | ConvertFrom-Json
        $nativeCli = Get-Content -LiteralPath (Join-Path $ApplicationRoot 'node_modules\@openai\codex-win32-x64\package.json') -Raw | ConvertFrom-Json
        $ws = Get-Content -LiteralPath (Join-Path $ApplicationRoot 'node_modules\ws\package.json') -Raw | ConvertFrom-Json
        $ajv = Get-Content -LiteralPath (Join-Path $ApplicationRoot 'node_modules\ajv\package.json') -Raw | ConvertFrom-Json
        return $cli.version -ceq $ExpectedCliVersion -and
            $nativeCli.version -ceq ($ExpectedCliVersion + '-win32-x64') -and
            $ws.version -ceq $manifest.dependencies.ws -and
            $ajv.version -ceq $manifest.dependencies.ajv
    } catch { return $false }
}

function Initialize-SessionBridgeDependencies {
    param(
        [Parameter(Mandatory)][scriptblock]$TestReady,
        [Parameter(Mandatory)][scriptblock]$Install
    )
    if (& $TestReady) { return }
    Write-Output 'First-start setup: downloading the official Codex CLI and bridge dependencies from registry.npmjs.org. This may take a few minutes.'
    & $Install
    if (!(& $TestReady)) { throw 'Dependency setup did not produce the required versions. ChatGPT was not started; repair the installation and retry.' }
}

function Install-SessionBridgeDependencies {
    param(
        [Parameter(Mandatory)][string]$ApplicationRoot,
        [Parameter(Mandatory)][string]$NodePath
    )
    $npmCli = Join-Path $ApplicationRoot 'runtime\node\node_modules\npm\bin\npm-cli.js'
    if (!(Test-Path -LiteralPath $npmCli -PathType Leaf)) {
        throw 'Dependencies are missing. For a source checkout, run npm ci in the project directory. For an installed copy, repair the bundled Node.js runtime and retry.'
    }
    Push-Location -LiteralPath $ApplicationRoot
    try {
        & $NodePath $npmCli ci --ignore-scripts --include=optional --registry=https://registry.npmjs.org
        if ($LASTEXITCODE -ne 0) { throw "Dependency download failed (npm exit code $LASTEXITCODE). ChatGPT was not started; check the network and retry." }
    } finally { Pop-Location }
}
