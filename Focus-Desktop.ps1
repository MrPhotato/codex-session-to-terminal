#requires -Version 7.4
[CmdletBinding()]
param(
    [ValidateSet('Capture', 'Activate', 'OpenThread')][string]$Action,
    [string]$ContextBase64,
    [string]$ThreadId,
    [string]$HostId,
    [switch]$DefinitionsOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Initialize-CstDesktopFocusNative {
    if ('CstDesktopFocus.Native' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace CstDesktopFocus {
    public sealed class Identity {
        public string handle;
        public int pid;
        public string startTicks;
        public string executablePath;
        public string userSid;
        public int sessionId;
        public string windowClass;
    }
    public static class Native {
        private static Identity Inspect(IntPtr window) {
            if (window == IntPtr.Zero || !IsWindow(window) || !IsWindowVisible(window) ||
                GetAncestor(window, 2) != window || GetWindow(window, 4) != IntPtr.Zero) return null;
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid == 0 || pid > Int32.MaxValue) return null;
            IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
            if (process == IntPtr.Zero) return null;
            try {
                uint size = 32768;
                var path = new StringBuilder((int)size);
                long creation, exit, kernel, user;
                uint session, currentSession;
                if (!QueryFullProcessImageName(process, 0, path, ref size) ||
                    !GetProcessTimes(process, out creation, out exit, out kernel, out user) || exit != 0 ||
                    !ProcessIdToSessionId(pid, out session) ||
                    !ProcessIdToSessionId(GetCurrentProcessId(), out currentSession) || session != currentSession ||
                    !OpenProcessToken(process, 8, out token)) return null;
                string sid;
                using (var peer = new WindowsIdentity(token)) using (var current = WindowsIdentity.GetCurrent()) {
                    if (peer.User == null || current.User == null || !peer.User.Equals(current.User)) return null;
                    sid = peer.User.Value;
                }
                var className = new StringBuilder(256);
                if (GetClassName(window, className, className.Capacity) == 0) return null;
                uint again;
                GetWindowThreadProcessId(window, out again);
                if (!IsWindow(window) || again != pid) return null;
                return new Identity { handle = window.ToInt64().ToString(CultureInfo.InvariantCulture), pid = (int)pid,
                    startTicks = DateTime.FromFileTimeUtc(creation).Ticks.ToString(CultureInfo.InvariantCulture),
                    executablePath = path.ToString(), userSid = sid, sessionId = (int)session, windowClass = className.ToString() };
            } catch { return null; }
            finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
        }
        private static bool IsTerminal(Identity value) {
            if (value == null) return false;
            string name = Path.GetFileName(value.executablePath);
            return value.windowClass == "CASCADIA_HOSTING_WINDOW_CLASS" && name.Equals("WindowsTerminal.exe", StringComparison.OrdinalIgnoreCase) ||
                value.windowClass == "ConsoleWindowClass" && (name.Equals("conhost.exe", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals("OpenConsole.exe", StringComparison.OrdinalIgnoreCase));
        }
        private static bool IsDesktop(Identity value, string[] paths) {
            if (value == null || paths == null) return false;
            foreach (string path in paths) {
                if (String.Equals(value.executablePath, path, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }
        // Pure comparison is public for fixtures; it never reads or changes UI.
        public static bool Same(Identity expected, Identity actual) {
            return expected != null && actual != null && expected.handle == actual.handle && expected.pid == actual.pid &&
                expected.startTicks == actual.startTicks && expected.userSid == actual.userSid && expected.sessionId == actual.sessionId &&
                expected.windowClass == actual.windowClass && String.Equals(expected.executablePath, actual.executablePath, StringComparison.OrdinalIgnoreCase);
        }
        private static IntPtr Window(Identity value) { return new IntPtr(Int64.Parse(value.handle, CultureInfo.InvariantCulture)); }
        public static Identity CaptureSource() {
            Identity value = Inspect(GetForegroundWindow());
            return IsTerminal(value) ? value : null;
        }
        public static Identity[] FindTargets(string[] allowedPaths) {
            var found = new List<Identity>();
            EnumWindows((window, unused) => {
                Identity value = Inspect(window);
                if (IsDesktop(value, allowedPaths)) found.Add(value);
                return true;
            }, IntPtr.Zero);
            return found.ToArray();
        }
        public static bool SourceIsForeground(Identity source) {
            return source != null && GetForegroundWindow() == Window(source) &&
                IsTerminal(source) && Same(source, Inspect(Window(source)));
        }
        public static string Check(Identity source, Identity target, string[] allowedPaths) {
            if (!IsTerminal(source) || !Same(source, Inspect(Window(source))) ||
                !IsDesktop(target, allowedPaths) || !Same(target, Inspect(Window(target)))) return "InvalidContext";
            IntPtr foreground = GetForegroundWindow();
            if (foreground == Window(target)) return "Foreground";
            return foreground == Window(source) ? "Ready" : "SourceChanged";
        }
        public static string Restore(Identity source, Identity target, string[] allowedPaths) {
            string check = Check(source, target, allowedPaths);
            if (check != "Ready") return check;
            IntPtr window = Window(target);
            if (IsIconic(window)) {
                // Recheck immediately before touching this specific window.
                check = Check(source, target, allowedPaths);
                if (check != "Ready") return check;
                ShowWindowAsync(window, 9);
            }
            return "Ready";
        }
        public static string RequestForeground(Identity source, Identity target, string[] allowedPaths) {
            string check = Check(source, target, allowedPaths);
            if (check != "Ready") return check;
            SetForegroundWindow(Window(target));
            // A nonzero API return is not proof of foreground ownership.
            return "Ready";
        }
        private delegate bool EnumWindowProcedure(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProcedure callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
        [DllImport("advapi32.dll", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }
}
'@
}

function ConvertTo-CstFocusRecord {
    param($Value)
    if ($null -eq $Value) { return $null }
    [pscustomobject]@{ handle = $Value.handle; pid = $Value.pid; startTicks = $Value.startTicks
        executablePath = $Value.executablePath; userSid = $Value.userSid; sessionId = $Value.sessionId; windowClass = $Value.windowClass }
}

function ConvertTo-CstFocusNativeIdentity {
    param($Value)
    $result = [CstDesktopFocus.Identity]::new()
    foreach ($key in @('handle','pid','startTicks','executablePath','userSid','sessionId','windowClass')) { $result.$key = $Value.$key }
    $result
}

function New-CstDesktopFocusOperations {
    Initialize-CstDesktopFocusNative
    @{
        Clock = { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
        AllowedPaths = {
            @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | ForEach-Object {
                if ($_.InstallLocation) { [IO.Path]::GetFullPath((Join-Path $_.InstallLocation 'app\ChatGPT.exe')) }
            } | Select-Object -Unique)
        }
        Source = { ConvertTo-CstFocusRecord ([CstDesktopFocus.Native]::CaptureSource()) }
        Targets = { param([string[]]$Paths) @([CstDesktopFocus.Native]::FindTargets($Paths) | ForEach-Object { ConvertTo-CstFocusRecord $_ }) }
        SourceIsForeground = { param($Source) [CstDesktopFocus.Native]::SourceIsForeground((ConvertTo-CstFocusNativeIdentity $Source)) }
        Check = { param($Source, $Target, [string[]]$Paths) [CstDesktopFocus.Native]::Check((ConvertTo-CstFocusNativeIdentity $Source), (ConvertTo-CstFocusNativeIdentity $Target), $Paths) }
        Restore = { param($Source, $Target, [string[]]$Paths) [CstDesktopFocus.Native]::Restore((ConvertTo-CstFocusNativeIdentity $Source), (ConvertTo-CstFocusNativeIdentity $Target), $Paths) }
        Activate = { param($Source, $Target, [string[]]$Paths) [CstDesktopFocus.Native]::RequestForeground((ConvertTo-CstFocusNativeIdentity $Source), (ConvertTo-CstFocusNativeIdentity $Target), $Paths) }
        Dispatch = {
            param($Source, $Target, [string[]]$Paths, [string]$Uri)
            $startInfo = New-CstDesktopThreadStartInfo -Target $Target -Uri $Uri
            # Build the fixed argv/environment before the last identity/foreground
            # check. This protocol has no atomic "existing PID only" dispatch:
            # a target exiting after this check remains an unavoidable race.
            $check = [CstDesktopFocus.Native]::Check((ConvertTo-CstFocusNativeIdentity $Source), (ConvertTo-CstFocusNativeIdentity $Target), $Paths)
            if ($check -ceq 'Foreground') { return 'SourceChanged' }
            if ($check -cne 'Ready') { return $check }
            $child = $null
            try {
                $child = [Diagnostics.Process]::Start($startInfo)
                if ($null -eq $child) { return 'DispatchFailed' }
                return 'Dispatched'
            } catch { return 'DispatchFailed' }
            finally { if ($null -ne $child) { $child.Dispose() } }
        }
        Delay = { Start-Sleep -Milliseconds 25 }
    }
}

function Test-CstFocusFields {
    param($Value, [string[]]$Keys)
    if ($null -eq $Value -or ($Value -isnot [Collections.IDictionary] -and $Value -isnot [pscustomobject])) { return $false }
    $actual = @(if ($Value -is [Collections.IDictionary]) { $Value.Keys } else { $Value.PSObject.Properties.Name })
    return $actual.Count -eq $Keys.Count -and @($actual | Where-Object { $_ -cnotin $Keys }).Count -eq 0
}

function Test-CstFocusIdentity {
    param($Value, [switch]$Source)
    if (!(Test-CstFocusFields $Value @('handle','pid','startTicks','executablePath','userSid','sessionId','windowClass'))) { return $false }
    $handle = 0L; $ticks = 0L
    if ($Value.handle -isnot [string] -or $Value.handle -cnotmatch '^[1-9][0-9]{0,18}$' -or ![long]::TryParse($Value.handle, [ref]$handle) -or
        $Value.startTicks -isnot [string] -or $Value.startTicks -cnotmatch '^[1-9][0-9]{16,18}$' -or ![long]::TryParse($Value.startTicks, [ref]$ticks) -or
        $ticks -gt [DateTime]::MaxValue.Ticks) { return $false }
    if (($Value.pid -isnot [int] -and $Value.pid -isnot [long]) -or $Value.pid -le 0 -or $Value.pid -gt [int]::MaxValue -or
        ($Value.sessionId -isnot [int] -and $Value.sessionId -isnot [long]) -or $Value.sessionId -lt 0 -or $Value.sessionId -gt [int]::MaxValue) { return $false }
    if ($Value.executablePath -isnot [string] -or $Value.executablePath.Length -gt 32768 -or
        $Value.executablePath -notmatch '^[A-Za-z]:\\' -or $Value.executablePath -match '[\x00-\x1f\x7f]' -or
        $Value.userSid -isnot [string] -or $Value.userSid.Length -gt 184 -or $Value.userSid -cnotmatch '^S-[0-9]+(?:-[0-9]+)+$' -or
        $Value.windowClass -isnot [string] -or !$Value.windowClass -or $Value.windowClass.Length -gt 255 -or $Value.windowClass -match '[\x00-\x1f\x7f]') { return $false }
    $name = [IO.Path]::GetFileName($Value.executablePath)
    if ($Source) {
        return ($Value.windowClass -ceq 'CASCADIA_HOSTING_WINDOW_CLASS' -and $name -ieq 'WindowsTerminal.exe') -or
            ($Value.windowClass -ceq 'ConsoleWindowClass' -and $name -iin @('conhost.exe', 'OpenConsole.exe'))
    }
    return $name -ieq 'ChatGPT.exe'
}

function Test-CstDesktopFocusContext {
    param($Context, [long]$Now)
    if (!(Test-CstFocusFields $Context @('version','capturedAtUnixMs','source','target')) -or
        ($Context.version -isnot [int] -and $Context.version -isnot [long]) -or $Context.version -ne 1 -or
        ($Context.capturedAtUnixMs -isnot [int] -and $Context.capturedAtUnixMs -isnot [long]) -or
        $Context.capturedAtUnixMs -lt 0 -or $Context.capturedAtUnixMs -gt $Now -or $Now - $Context.capturedAtUnixMs -gt 60000 -or
        !(Test-CstFocusIdentity $Context.source -Source) -or !(Test-CstFocusIdentity $Context.target)) { return $false }
    return $Context.source.handle -cne $Context.target.handle -and $Context.source.pid -ne $Context.target.pid -and
        $Context.source.userSid -ceq $Context.target.userSid -and $Context.source.sessionId -eq $Context.target.sessionId
}

function Invoke-CstDesktopFocusCapture {
    param([hashtable]$Operations)
    try {
        if (!$Operations) { $Operations = New-CstDesktopFocusOperations }
        $started = & $Operations.Clock
        $source = & $Operations.Source
        if (!(Test-CstFocusIdentity $source -Source)) { return @{ status = 'SourceUnavailable'; context = $null } }
        $paths = @(& $Operations.AllowedPaths)
        if (!$paths.Count) { return @{ status = 'DesktopUnavailable'; context = $null } }
        $targets = @(& $Operations.Targets $paths)
        if ($targets.Count -gt 1) { return @{ status = 'Ambiguous'; context = $null } }
        if ($targets.Count -ne 1) { return @{ status = 'DesktopUnavailable'; context = $null } }
        $context = @{ version = 1; capturedAtUnixMs = $started; source = $source; target = $targets[0] }
        if (!(Test-CstDesktopFocusContext $context (& $Operations.Clock))) { return @{ status = 'DesktopUnavailable'; context = $null } }
        if (!(& $Operations.SourceIsForeground $source)) { return @{ status = 'SourceUnavailable'; context = $null } }
        return @{ status = 'Captured'; context = $context }
    } catch { return @{ status = 'DesktopUnavailable'; context = $null } }
}

function Read-CstDesktopFocusContext {
    param([string]$Encoded)
    if (!$Encoded -or $Encoded.Length -gt 16384 -or $Encoded -cnotmatch '^[A-Za-z0-9+/]+={0,2}$') { return $null }
    try {
        $bytes = [Convert]::FromBase64String($Encoded)
        if ($bytes.Length -gt 12288) { return $null }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        return ($text | ConvertFrom-Json -AsHashtable -Depth 8 -ErrorAction Stop)
    } catch { return $null }
}

function New-CstDesktopFocusResult {
    param([string]$Status)
    if ($Status -cnotin @('Foreground','NotForeground','SourceChanged','InvalidContext')) { $Status = 'InvalidContext' }
    @{ status = $Status; foreground = ($Status -ceq 'Foreground') }
}

function Invoke-CstDesktopFocusActivate {
    param([string]$EncodedContext, [hashtable]$Operations)
    try {
        $context = Read-CstDesktopFocusContext $EncodedContext
        # Reject malformed input before compiling native code or inspecting apps.
        if (!(Test-CstDesktopFocusContext $context ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))) {
            return New-CstDesktopFocusResult 'InvalidContext'
        }
        if (!$Operations) { $Operations = New-CstDesktopFocusOperations }
        if (!(Test-CstDesktopFocusContext $context (& $Operations.Clock))) { return New-CstDesktopFocusResult 'InvalidContext' }
        $paths = @(& $Operations.AllowedPaths)
        if (!$paths.Count) { return New-CstDesktopFocusResult 'InvalidContext' }
        foreach ($step in @('Check','Restore','Activate')) {
            if (!(Test-CstDesktopFocusContext $context (& $Operations.Clock))) { return New-CstDesktopFocusResult 'InvalidContext' }
            # Native operations also recheck PID incarnation, path, SID and HWND
            # immediately before either permitted window mutation.
            $status = & $Operations[$step] $context.source $context.target $paths
            if ($status -cne 'Ready') { return New-CstDesktopFocusResult $status }
        }
        for ($attempt = 0; $attempt -le 20; $attempt++) {
            $status = & $Operations.Check $context.source $context.target $paths
            if ($status -cne 'Ready') { return New-CstDesktopFocusResult $status }
            if ($attempt -lt 20) { & $Operations.Delay | Out-Null }
        }
        return New-CstDesktopFocusResult 'NotForeground'
    } catch { return New-CstDesktopFocusResult 'InvalidContext' }
}

function ConvertTo-CstDesktopThreadUri {
    param([string]$ThreadId, [string]$HostId)
    if ($ThreadId -cnotmatch '\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z' -or
        $HostId -cnotin @('local', 'durable')) { return $null }
    $parsed = [Guid]::Empty
    if (![Guid]::TryParseExact($ThreadId, 'D', [ref]$parsed) -or $parsed -eq [Guid]::Empty) { return $null }
    return ('codex://threads/{0}?hostId={1}' -f $parsed.ToString('D'), $HostId)
}

function Clear-CstDesktopDispatchEnvironment {
    param([Diagnostics.ProcessStartInfo]$StartInfo)
    # A second instance must use the normal Desktop profile and process lock.
    # Never inherit this terminal's Codex home, transport, profile or old events.
    foreach ($key in @($StartInfo.Environment.Keys)) {
        if ($key -ilike 'CODEX_*' -or $key -ilike 'CST_*' -or $key -iin @('BUILD_FLAVOR', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS')) {
            $StartInfo.Environment.Remove($key) | Out-Null
        }
    }
}

function New-CstDesktopThreadStartInfo {
    param($Target, [string]$Uri)
    if (!(Test-CstFocusIdentity $Target) -or
        $Uri -cnotmatch '\Acodex://threads/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\?hostId=(local|durable)\z') {
        throw 'Invalid Desktop thread dispatch.'
    }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Target.executablePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.ArgumentList.Add('--single-argument')
    $startInfo.ArgumentList.Add($Uri)
    Clear-CstDesktopDispatchEnvironment -StartInfo $startInfo
    return $startInfo
}

function New-CstDesktopOpenThreadResult {
    param([string]$Status, [bool]$Dispatched = $false)
    if ($Status -cnotin @('Foreground','NotForeground','SourceChanged','InvalidContext','SourceUnavailable','DesktopUnavailable','Ambiguous','DispatchFailed')) {
        $Status = 'InvalidContext'
    }
    # Dispatch acceptance and foreground observation are separate from page
    # navigation, for which this second-instance protocol provides no receipt.
    @{ status = $Status; dispatched = $Dispatched; foreground = ($Status -ceq 'Foreground') }
}

function Invoke-CstDesktopOpenThread {
    param([string]$ThreadId, [string]$HostId, [hashtable]$Operations)
    $dispatched = $false
    $uri = ConvertTo-CstDesktopThreadUri -ThreadId $ThreadId -HostId $HostId
    # Invalid input must not compile native code, inspect apps, or launch anything.
    if (!$uri) { return New-CstDesktopOpenThreadResult 'InvalidContext' }
    try {
        if (!$Operations) { $Operations = New-CstDesktopFocusOperations }
        # Capture owns the validation logic. Keep its trusted Appx result only
        # for this invocation; neither argv nor a serialized context supplies it.
        $captureState = @{ paths = @() }
        $getPaths = $Operations.AllowedPaths
        $captureOperations = $Operations.Clone()
        $captureOperations.AllowedPaths = {
            $captureState.paths = @(& $getPaths)
            $captureState.paths
        }.GetNewClosure()
        $capture = Invoke-CstDesktopFocusCapture -Operations $captureOperations
        if ($capture.status -cne 'Captured') { return New-CstDesktopOpenThreadResult $capture.status }
        $context = $capture.context
        $paths = $captureState.paths
        if (!(Test-CstDesktopFocusContext $context (& $Operations.Clock))) { return New-CstDesktopOpenThreadResult 'InvalidContext' }
        # Dispatch rechecks the exact source and target immediately before Start.
        # It never chooses a URI handler, passes a shell command, or retries.
        $status = & $Operations.Dispatch $context.source $context.target $paths $uri
        if ($status -cne 'Dispatched') { return New-CstDesktopOpenThreadResult $status }
        $dispatched = $true
        foreach ($step in @('Check','Restore','Activate')) {
            if (!(Test-CstDesktopFocusContext $context (& $Operations.Clock))) { return New-CstDesktopOpenThreadResult 'InvalidContext' $dispatched }
            $status = & $Operations[$step] $context.source $context.target $paths
            if ($status -cne 'Ready') { return New-CstDesktopOpenThreadResult $status $dispatched }
        }
        for ($attempt = 0; $attempt -le 20; $attempt++) {
            if (!(Test-CstDesktopFocusContext $context (& $Operations.Clock))) { return New-CstDesktopOpenThreadResult 'InvalidContext' $dispatched }
            $status = & $Operations.Check $context.source $context.target $paths
            if ($status -cne 'Ready') { return New-CstDesktopOpenThreadResult $status $dispatched }
            if ($attempt -lt 20) { & $Operations.Delay | Out-Null }
        }
        return New-CstDesktopOpenThreadResult 'NotForeground' $dispatched
    } catch { return New-CstDesktopOpenThreadResult 'InvalidContext' $dispatched }
}

if (!$DefinitionsOnly) {
    $result = if ($Action -ceq 'Capture') { Invoke-CstDesktopFocusCapture }
        elseif ($Action -ceq 'Activate') { Invoke-CstDesktopFocusActivate -EncodedContext $ContextBase64 }
        elseif ($Action -ceq 'OpenThread') { Invoke-CstDesktopOpenThread -ThreadId $ThreadId -HostId $HostId }
        else { New-CstDesktopFocusResult 'InvalidContext' }
    $result | ConvertTo-Json -Depth 6 -Compress
}
