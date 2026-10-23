# No application, foreground-window API, or input is used by these fixtures.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Focus-Desktop.ps1') -DefinitionsOnly

function Assert-CstFocus([bool]$Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function New-FocusFixture {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $source = [pscustomobject]@{ handle = '101'; pid = 1001; startTicks = '639200000000000000'; executablePath = 'C:\Terminal\WindowsTerminal.exe'
        userSid = 'S-1-5-21-1-2-3-1001'; sessionId = 1; windowClass = 'CASCADIA_HOSTING_WINDOW_CLASS' }
    $target = [pscustomobject]@{ handle = '202'; pid = 2002; startTicks = '639200000000000001'; executablePath = 'C:\Program Files\WindowsApps\OpenAI.Codex_fixture\app\ChatGPT.exe'
        userSid = $source.userSid; sessionId = 1; windowClass = 'Chrome_WidgetWin_1' }
    $state = @{ now = $now; source = $source; target = $target; sourceForeground = $true; targets = @($target); paths = @($target.executablePath)
        calls = [Collections.Generic.List[string]]::new(); checks = [Collections.Generic.Queue[string]]::new(); defaultCheck = 'Ready'; restore = 'Ready'; activation = 'Ready'
        dispatch = 'Dispatched'; dispatchDelayMs = 0; dispatchUri = $null; dispatchSource = $null; dispatchTarget = $null; dispatchPaths = @() }
    $operations = @{
        Clock = { $state.now }.GetNewClosure()
        Source = { $state.calls.Add('source'); $state.source }.GetNewClosure()
        Targets = { param($Paths) $state.calls.Add('targets'); $state.targets }.GetNewClosure()
        AllowedPaths = { $state.calls.Add('paths'); $state.paths }.GetNewClosure()
        SourceIsForeground = { param($Source) $state.calls.Add('source-check'); $state.sourceForeground }.GetNewClosure()
        Check = { param($Source, $Target, $Paths) $state.calls.Add('check'); if ($state.checks.Count) { $state.checks.Dequeue() } else { $state.defaultCheck } }.GetNewClosure()
        Restore = { param($Source, $Target, $Paths) $state.calls.Add('restore'); $state.restore }.GetNewClosure()
        Activate = { param($Source, $Target, $Paths) $state.calls.Add('activate'); $state.activation }.GetNewClosure()
        Dispatch = { param($Source, $Target, $Paths, $Uri)
            $state.calls.Add('dispatch'); $state.dispatchSource = $Source; $state.dispatchTarget = $Target
            $state.dispatchPaths = @($Paths); $state.dispatchUri = $Uri; $state.now += $state.dispatchDelayMs; $state.dispatch
        }.GetNewClosure()
        Delay = { $state.calls.Add('delay'); $state.now += 25 }.GetNewClosure()
    }
    @{ State = $state; Operations = $operations; Context = @{ version = 1; capturedAtUnixMs = $now; source = $source; target = $target } }
}
function Encode-FocusContext($Context) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Context | ConvertTo-Json -Depth 6 -Compress))) }

# Compiles declarations only. Do not call Native.CaptureSource/FindTargets/Check.
Initialize-CstDesktopFocusNative
$fixture = New-FocusFixture
$identity = ConvertTo-CstFocusNativeIdentity $fixture.State.target
foreach ($field in @('handle','pid','startTicks','executablePath','userSid','sessionId','windowClass')) {
    $changed = ConvertTo-CstFocusNativeIdentity $fixture.State.target
    switch ($field) {
        'handle' { $changed.handle = '999' }
        'pid' { $changed.pid++ }
        'startTicks' { $changed.startTicks = '639200000000000002' }
        'executablePath' { $changed.executablePath = 'C:\Unrelated\ChatGPT.exe' }
        'userSid' { $changed.userSid = 'S-1-5-21-1-2-3-9999' }
        'sessionId' { $changed.sessionId++ }
        'windowClass' { $changed.windowClass = 'OtherWindow' }
    }
    Assert-CstFocus (![CstDesktopFocus.Native]::Same($identity, $changed)) "A stale or foreign identity matched: $field"
}
Assert-CstFocus ([CstDesktopFocus.Native]::Same($identity, (ConvertTo-CstFocusNativeIdentity $fixture.State.target))) 'An exact identity did not match.'
$captured = Invoke-CstDesktopFocusCapture -Operations $fixture.Operations
Assert-CstFocus ($captured.status -ceq 'Captured') 'A single verified Desktop must produce a context.'
Assert-CstFocus ($captured.context.target.handle -ceq '202' -and $captured.context.source.handle -ceq '101') 'Capture changed the bound window identities.'
Assert-CstFocus (($fixture.State.calls -join ',') -ceq 'source,paths,targets,source-check') 'Capture must contain only read operations.'
foreach ($kind in @('ambiguous','no-desktop','no-source','switched','wrong-user','wrong-session')) {
    $fixture = New-FocusFixture
    switch ($kind) {
        'ambiguous' { $fixture.State.targets = @($fixture.State.target, $fixture.State.target); $expected = 'Ambiguous' }
        'no-desktop' { $fixture.State.targets = @(); $expected = 'DesktopUnavailable' }
        'no-source' { $fixture.State.source = $null; $expected = 'SourceUnavailable' }
        'switched' { $fixture.State.sourceForeground = $false; $expected = 'SourceUnavailable' }
        'wrong-user' { $fixture.State.target.userSid = 'S-1-5-21-1-2-3-9999'; $expected = 'DesktopUnavailable' }
        'wrong-session' { $fixture.State.target.sessionId = 2; $expected = 'DesktopUnavailable' }
    }
    $result = Invoke-CstDesktopFocusCapture -Operations $fixture.Operations
    Assert-CstFocus ($result.status -ceq $expected -and $null -eq $result.context) "Capture failed closed incorrectly: $kind"
    Assert-CstFocus ('restore' -notin $fixture.State.calls -and 'activate' -notin $fixture.State.calls) 'Capture mutated a window.'
}

foreach ($kind in @('expired','future','unknown-field','numeric-handle','wrong-exe','wrong-source','wrong-user','pid-overflow')) {
    $fixture = New-FocusFixture
    switch ($kind) {
        'expired' { $fixture.Context.capturedAtUnixMs -= 60001 }
        'future' { $fixture.Context.capturedAtUnixMs += 60000 }
        'unknown-field' { $fixture.Context.unexpected = $true }
        'numeric-handle' { $fixture.Context.target.handle = 202 }
        'wrong-exe' { $fixture.Context.target.executablePath = 'C:\other\Editor.exe' }
        'wrong-source' { $fixture.Context.source.windowClass = 'OtherWindow' }
        'wrong-user' { $fixture.Context.target.userSid = 'S-1-5-21-1-2-3-9999' }
        'pid-overflow' { $fixture.Context.target.pid = 2147483648L }
    }
    $result = Invoke-CstDesktopFocusActivate -EncodedContext (Encode-FocusContext $fixture.Context) -Operations $fixture.Operations
    Assert-CstFocus ($result.status -ceq 'InvalidContext' -and !$result.foreground) "Malformed context accepted: $kind"
    Assert-CstFocus ($fixture.State.calls.Count -eq 0) "Invalid context accessed an app: $kind"
}
foreach ($encoded in @('', '.', 'bm90LWpzb24=', '////', ('A' * 16385))) {
    $fixture = New-FocusFixture
    $result = Invoke-CstDesktopFocusActivate -EncodedContext $encoded -Operations $fixture.Operations
    Assert-CstFocus ($result.status -ceq 'InvalidContext' -and $fixture.State.calls.Count -eq 0) 'Invalid base64 or JSON reached the window operations.'
}

foreach ($status in @('InvalidContext','SourceChanged','Foreground')) {
    $fixture = New-FocusFixture; $fixture.State.defaultCheck = $status
    $result = Invoke-CstDesktopFocusActivate -EncodedContext (Encode-FocusContext $fixture.Context) -Operations $fixture.Operations
    Assert-CstFocus ($result.status -ceq $status -and $result.foreground -eq ($status -ceq 'Foreground')) 'Preflight state was not reported accurately.'
    Assert-CstFocus ('restore' -notin $fixture.State.calls -and 'activate' -notin $fixture.State.calls) 'Preflight rejection or existing foreground mutated a window.'
}
$fixture = New-FocusFixture
$fixture.State.restore = 'SourceChanged'
$result = Invoke-CstDesktopFocusActivate -EncodedContext (Encode-FocusContext $fixture.Context) -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'SourceChanged' -and 'activate' -notin $fixture.State.calls) 'A switch before restore allowed foreground activation.'
$fixture = New-FocusFixture
$fixture.State.activation = 'InvalidContext'
$result = Invoke-CstDesktopFocusActivate -EncodedContext (Encode-FocusContext $fixture.Context) -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'InvalidContext' -and 'delay' -notin $fixture.State.calls) 'A stale target during activation was polled as valid.'

$fixture = New-FocusFixture
$fixture.State.checks.Enqueue('Ready'); $fixture.State.checks.Enqueue('Ready'); $fixture.State.checks.Enqueue('Foreground')
$result = Invoke-CstDesktopFocusActivate -EncodedContext (Encode-FocusContext $fixture.Context) -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'Foreground' -and $result.foreground) 'Observed foreground was not reported.'
Assert-CstFocus ((@($fixture.State.calls | Where-Object { $_ -eq 'restore' }).Count -eq 1) -and (@($fixture.State.calls | Where-Object { $_ -eq 'activate' }).Count -eq 1)) 'Activation was repeated.'
$fixture = New-FocusFixture
$result = Invoke-CstDesktopFocusActivate -EncodedContext (Encode-FocusContext $fixture.Context) -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'NotForeground' -and !$result.foreground) 'An unobserved request was reported as successful.'
Assert-CstFocus (@($fixture.State.calls | Where-Object { $_ -eq 'delay' }).Count -eq 20) 'Foreground readback exceeded its bounded wait.'
$fixture = New-FocusFixture
$fixture.State.checks.Enqueue('Ready'); $fixture.State.checks.Enqueue('SourceChanged')
$result = Invoke-CstDesktopFocusActivate -EncodedContext (Encode-FocusContext $fixture.Context) -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'SourceChanged' -and 'delay' -notin $fixture.State.calls) 'Readback kept polling after the user switched apps.'

$threadId = '01a11946-12fe-7f81-81d9-de3b2fb11444'
foreach ($inputPair in @(
    @('', 'local'), @($threadId, ''), @($threadId, 'LOCAL'), @($threadId, 'remote'),
    @($threadId, 'local&threadAccess=shared'), @($threadId, 'durable '),
    @('00000000-0000-0000-0000-000000000000', 'local'),
    @("$threadId`n", 'local'), @(" $threadId", 'local'), @("${threadId}?hostId=durable", 'local'),
    @('C:\other.exe', 'local'), @('not-a-uuid', 'durable')
)) {
    $fixture = New-FocusFixture
    $result = Invoke-CstDesktopOpenThread -ThreadId $inputPair[0] -HostId $inputPair[1] -Operations $fixture.Operations
    Assert-CstFocus ($result.status -ceq 'InvalidContext' -and !$result.dispatched -and !$result.foreground) 'Invalid thread dispatch input was accepted.'
    Assert-CstFocus ($fixture.State.calls.Count -eq 0) 'Invalid thread dispatch inspected an app or attempted a launch.'
}

foreach ($hostId in @('local', 'durable')) {
    $fixture = New-FocusFixture
    $uri = ConvertTo-CstDesktopThreadUri -ThreadId ($threadId.ToUpperInvariant()) -HostId $hostId
    Assert-CstFocus ($uri -ceq ('codex://threads/{0}?hostId={1}' -f $threadId, $hostId)) 'Thread URI was not fixed and canonical.'
    # Constructing ProcessStartInfo does not start a process or call native UI.
    $info = New-CstDesktopThreadStartInfo -Target $fixture.State.target -Uri $uri
    Assert-CstFocus ($info.FileName -ceq $fixture.State.target.executablePath) 'Dispatch changed the verified executable path.'
    Assert-CstFocus (!$info.UseShellExecute -and $info.CreateNoWindow -and $info.WindowStyle -eq [Diagnostics.ProcessWindowStyle]::Hidden) 'Dispatch must bypass the shell and remain hidden.'
    Assert-CstFocus ($info.ArgumentList.Count -eq 2 -and $info.ArgumentList[0] -ceq '--single-argument' -and $info.ArgumentList[1] -ceq $uri -and !$info.Arguments) 'Dispatch must contain only two literal argv entries.'
    foreach ($key in @('CODEX_HOME','CODEX_CLI_PATH','CODEX_APP_SERVER_FORCE_CLI','CODEX_APP_SERVER_WS_URL','CODEX_THREAD_ID','CODEX_SESSION_ID',
        'CODEX_SHARED_SESSION_CONFIG','CODEX_SHARED_SESSION_GENERATION','CODEX_ELECTRON_USER_DATA_PATH','CODEX_ELECTRON_AGENT_RUN_ID',
        'CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS','CODEX_FUTURE_PROFILE_OVERRIDE','codex_lowercase_override','CST_BRIDGE_TOKEN','cst_test_override','BUILD_FLAVOR','ELECTRON_RUN_AS_NODE','NODE_OPTIONS')) {
        $info.Environment[$key] = 'fixture-override'
    }
    $info.Environment['SystemRoot'] = 'C:\Windows'; $info.Environment['TEMP'] = 'C:\Temp'
    Clear-CstDesktopDispatchEnvironment $info
    Assert-CstFocus (@($info.Environment.Keys | Where-Object { $_ -ilike 'CODEX_*' -or $_ -ilike 'CST_*' -or $_ -iin @('BUILD_FLAVOR','ELECTRON_RUN_AS_NODE','NODE_OPTIONS') }).Count -eq 0) 'A terminal/profile/bootstrap override leaked into Desktop dispatch.'
    Assert-CstFocus ($info.Environment['SystemRoot'] -ceq 'C:\Windows' -and $info.Environment['TEMP'] -ceq 'C:\Temp') 'Standard Windows environment was lost.'
    $fixture.State.defaultCheck = 'Foreground'
    $result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId $hostId -Operations $fixture.Operations
    Assert-CstFocus ($result.status -ceq 'Foreground' -and $result.dispatched -and $result.foreground) 'Immediate original-window foreground was not reported.'
    Assert-CstFocus (($fixture.State.calls -join ',') -ceq 'source,paths,targets,source-check,dispatch,check') 'Immediate foreground should use one capture/dispatch and no focus mutation.'
    Assert-CstFocus ($fixture.State.dispatchUri -ceq $uri -and $fixture.State.dispatchTarget.handle -ceq '202' -and $fixture.State.dispatchSource.handle -ceq '101') 'Dispatch changed the URI or captured window identities.'
    Assert-CstFocus ($fixture.State.dispatchPaths.Count -eq 1 -and $fixture.State.dispatchPaths[0] -ceq $fixture.State.target.executablePath) 'Dispatch did not retain the trusted per-call Appx path.'
    Assert-CstFocus ((Test-CstFocusFields $result @('status','dispatched','foreground')) -and $result.dispatched -is [bool] -and $result.foreground -is [bool]) 'Dispatch output must not claim page-navigation success or return extra context.'
}

foreach ($uri in @('https://example.com', "codex://threads/${threadId}?hostId=remote", "codex://threads/${threadId}?hostId=local&threadAccess=shared", "codex://threads/${threadId}?hostId=local`n")) {
    $fixture = New-FocusFixture; $rejected = $false
    try { New-CstDesktopThreadStartInfo -Target $fixture.State.target -Uri $uri | Out-Null } catch { $rejected = $true }
    Assert-CstFocus $rejected 'ProcessStartInfo accepted an unfixed URI.'
}
foreach ($kind in @('ambiguous','no-desktop','no-source','no-package','switched','wrong-user','wrong-session')) {
    $fixture = New-FocusFixture
    switch ($kind) {
        'ambiguous' { $fixture.State.targets = @($fixture.State.target, $fixture.State.target); $expected = 'Ambiguous' }
        'no-desktop' { $fixture.State.targets = @(); $expected = 'DesktopUnavailable' }
        'no-source' { $fixture.State.source = $null; $expected = 'SourceUnavailable' }
        'no-package' { $fixture.State.paths = @(); $expected = 'DesktopUnavailable' }
        'switched' { $fixture.State.sourceForeground = $false; $expected = 'SourceUnavailable' }
        'wrong-user' { $fixture.State.target.userSid = 'S-1-5-21-1-2-3-9999'; $expected = 'DesktopUnavailable' }
        'wrong-session' { $fixture.State.target.sessionId = 2; $expected = 'DesktopUnavailable' }
    }
    $result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId 'local' -Operations $fixture.Operations
    Assert-CstFocus ($result.status -ceq $expected -and !$result.dispatched -and !$result.foreground) "Unavailable OpenThread target was accepted: $kind"
    Assert-CstFocus ('dispatch' -notin $fixture.State.calls -and 'restore' -notin $fixture.State.calls -and 'activate' -notin $fixture.State.calls) 'Failed capture launched or changed an application.'
}
foreach ($status in @('SourceChanged','InvalidContext','DispatchFailed')) {
    $fixture = New-FocusFixture; $fixture.State.dispatch = $status
    $result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId 'durable' -Operations $fixture.Operations
    Assert-CstFocus ($result.status -ceq $status -and !$result.dispatched -and !$result.foreground) 'Dispatch rejection was not reported accurately.'
    Assert-CstFocus (@($fixture.State.calls | Where-Object { $_ -ceq 'dispatch' }).Count -eq 1 -and 'check' -notin $fixture.State.calls -and 'activate' -notin $fixture.State.calls) 'Rejected dispatch was retried or followed by activation.'
}
foreach ($status in @('SourceChanged','InvalidContext')) {
    $fixture = New-FocusFixture; $fixture.State.defaultCheck = $status
    $result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId 'durable' -Operations $fixture.Operations
    Assert-CstFocus ($result.status -ceq $status -and $result.dispatched -and !$result.foreground) 'Post-dispatch identity/source change lost the dispatch receipt.'
    Assert-CstFocus ('restore' -notin $fixture.State.calls -and 'activate' -notin $fixture.State.calls -and 'delay' -notin $fixture.State.calls) 'Post-dispatch source/target change still mutated a window.'
}
$fixture = New-FocusFixture; $fixture.State.restore = 'SourceChanged'
$result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId 'local' -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'SourceChanged' -and $result.dispatched -and !$result.foreground -and 'activate' -notin $fixture.State.calls) 'Source switch before restore did not cancel OpenThread activation.'
$fixture = New-FocusFixture; $fixture.State.activation = 'InvalidContext'
$result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId 'local' -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'InvalidContext' -and $result.dispatched -and 'delay' -notin $fixture.State.calls) 'Stale activation target was polled or retried.'
$fixture = New-FocusFixture; $fixture.State.dispatchDelayMs = 60001
$result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId 'local' -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'InvalidContext' -and $result.dispatched -and 'check' -notin $fixture.State.calls) 'Expired per-call context performed a focus operation.'
$fixture = New-FocusFixture
$fixture.State.checks.Enqueue('Ready'); $fixture.State.checks.Enqueue('Ready'); $fixture.State.checks.Enqueue('Foreground')
$result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId 'durable' -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'Foreground' -and $result.dispatched -and $result.foreground) 'Bounded post-dispatch observation did not report foreground.'
foreach ($once in @('paths','dispatch','restore','activate')) {
    Assert-CstFocus (@($fixture.State.calls | Where-Object { $_ -ceq $once }).Count -eq 1) "OpenThread repeated $once."
}
$fixture = New-FocusFixture
$result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId 'local' -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'NotForeground' -and $result.dispatched -and !$result.foreground) 'Unobserved foreground was reported as successful after dispatch.'
Assert-CstFocus (@($fixture.State.calls | Where-Object { $_ -ceq 'delay' }).Count -eq 20 -and @($fixture.State.calls | Where-Object { $_ -ceq 'dispatch' }).Count -eq 1) 'OpenThread exceeded its 500ms readback or retried dispatch.'
$fixture = New-FocusFixture
$fixture.State.checks.Enqueue('Ready'); $fixture.State.checks.Enqueue('SourceChanged')
$result = Invoke-CstDesktopOpenThread -ThreadId $threadId -HostId 'durable' -Operations $fixture.Operations
Assert-CstFocus ($result.status -ceq 'SourceChanged' -and $result.dispatched -and 'delay' -notin $fixture.State.calls) 'Readback continued after the user switched apps.'

'Desktop focus: identity/context, ambiguity, expiry, source-switch cancellation, fixed isolated thread dispatch and bounded readback fixtures passed; native declarations compiled only. No real window APIs, input, applications or focus changes were used.'
