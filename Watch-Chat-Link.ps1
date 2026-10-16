#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$DesktopPid,
    [Parameter(Mandatory)][long]$DesktopStartTicks,
    [Parameter(Mandatory)][string]$ControlDirectory
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    throw 'Start this watcher with PowerShell 7 -STA on Windows.'
}
if ($DesktopStartTicks -le 0 -or !(Test-Path -LiteralPath $ControlDirectory -PathType Container)) {
    throw 'The watcher requires an existing private control directory and Desktop process identity.'
}

$stopFile = Join-Path ([IO.Path]::GetFullPath($ControlDirectory)) 'stop.flag'
$productionScript = Join-Path $PSScriptRoot 'production.ps1'
$parserScript = Join-Path $PSScriptRoot 'Thread-Link.ps1'
$focusScript = Join-Path $PSScriptRoot 'Terminal-Focus.ps1'
if (!(Test-Path -LiteralPath $productionScript -PathType Leaf) -or !(Test-Path -LiteralPath $parserScript -PathType Leaf) -or !(Test-Path -LiteralPath $focusScript -PathType Leaf)) {
    throw 'The current-chat launcher is incomplete.'
}
. $parserScript
. $focusScript
Initialize-CodexTerminalFocus

function Test-OriginalDesktopAlive {
    try {
        $desktopProcess = Get-Process -Id $DesktopPid -ErrorAction Stop
        return $desktopProcess.StartTime.ToUniversalTime().Ticks -eq $DesktopStartTicks
    } catch { return $false }
}

if ((Test-Path -LiteralPath $stopFile) -or !(Test-OriginalDesktopAlive)) { return }

# A message-only native window receives clipboard change events. It never becomes
# visible, sends input, or inspects the Desktop application's UI. A deliberate
# valid link action may activate only the new terminal created for that action.
$nativeSource = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexSharedSession {
    public sealed class ClipboardLinkListener : IDisposable {
        private const uint WM_CLIPBOARDUPDATE = 0x031D;
        private const uint CF_UNICODETEXT = 13;
        private const uint PM_REMOVE = 1;
        private const int MaximumCharacters = 512;
        private readonly uint desktopPid;
        private readonly string className;
        private readonly IntPtr instance;
        private readonly WindowProcedure procedure;
        private IntPtr window;
        private bool registered;
        private uint observedSequence;
        private uint? pendingSequence;
        private int pendingAttempts;
        public event Action<string> TextChanged;

        public ClipboardLinkListener(uint requiredDesktopPid) {
            desktopPid = requiredDesktopPid;
            className = "CodexSharedSessionClipboard." + Process.GetCurrentProcess().Id;
            instance = GetModuleHandle(null);
            procedure = HandleMessage;
            var windowClass = new WindowClass {
                Size = (uint)Marshal.SizeOf<WindowClass>(),
                Procedure = Marshal.GetFunctionPointerForDelegate(procedure),
                Instance = instance,
                ClassName = className
            };
            if (RegisterClassEx(ref windowClass) == 0) throw new InvalidOperationException("Listener registration failed.");
            registered = true;
            try {
                window = CreateWindowEx(0, className, "", 0, 0, 0, 0, 0,
                    new IntPtr(-3), IntPtr.Zero, instance, IntPtr.Zero);
                if (window == IntPtr.Zero || !AddClipboardFormatListener(window))
                    throw new InvalidOperationException("Clipboard listener unavailable.");
                // Existing clipboard content is deliberately ignored at startup.
                observedSequence = GetClipboardSequenceNumber();
            } catch { Dispose(); throw; }
        }

        public static uint ForegroundProcessId() {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            return pid;
        }

        private IntPtr HandleMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam) {
            if (message == WM_CLIPBOARDUPDATE) {
                uint sequence = GetClipboardSequenceNumber();
                if (sequence != observedSequence) {
                    observedSequence = sequence;
                    pendingSequence = null;
                    // Ignore other applications before attempting to read anything.
                    if (ForegroundProcessId() == desktopPid) {
                        pendingSequence = sequence;
                        pendingAttempts = 0;
                    }
                }
                return IntPtr.Zero;
            }
            return DefWindowProc(handle, message, wParam, lParam);
        }

        public void Pump() {
            NativeMessage message;
            while (window != IntPtr.Zero && PeekMessage(out message, window, 0, 0, PM_REMOVE)) {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
            if (!pendingSequence.HasValue) return;
            if (ForegroundProcessId() != desktopPid || GetClipboardSequenceNumber() != pendingSequence.Value) {
                pendingSequence = null;
                return;
            }
            if (!OpenClipboard(window)) {
                if (++pendingAttempts >= 5) pendingSequence = null;
                return;
            }
            string text = null;
            try {
                pendingSequence = null;
                if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return;
                IntPtr data = GetClipboardData(CF_UNICODETEXT);
                if (data == IntPtr.Zero) return;
                ulong bytes = GlobalSize(data).ToUInt64();
                // Check native allocation length before copying any clipboard text.
                if (bytes < 2 || bytes > (MaximumCharacters + 1) * 2 || (bytes & 1) != 0) return;
                IntPtr address = GlobalLock(data);
                if (address == IntPtr.Zero) return;
                try {
                    var value = new StringBuilder();
                    int length = (int)(bytes / 2);
                    for (int index = 0; index < length; index++) {
                        char character = unchecked((char)Marshal.ReadInt16(address, index * 2));
                        if (character == '\0') { text = value.ToString(); break; }
                        if (index == MaximumCharacters) return;
                        value.Append(character);
                    }
                } finally { GlobalUnlock(data); }
            } finally { CloseClipboard(); }
            if (text != null && ForegroundProcessId() == desktopPid) TextChanged?.Invoke(text);
        }

        public void Dispose() {
            pendingSequence = null;
            if (window != IntPtr.Zero) {
                RemoveClipboardFormatListener(window);
                DestroyWindow(window);
                window = IntPtr.Zero;
            }
            if (registered) {
                UnregisterClass(className, instance);
                registered = false;
            }
            GC.KeepAlive(procedure);
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate IntPtr WindowProcedure(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct WindowClass {
            public uint Size, Style;
            public IntPtr Procedure;
            public int ClassExtra, WindowExtra;
            public IntPtr Instance, Icon, Cursor, Background;
            [MarshalAs(UnmanagedType.LPWStr)] public string MenuName;
            [MarshalAs(UnmanagedType.LPWStr)] public string ClassName;
            public IntPtr SmallIcon;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct NativeMessage {
            public IntPtr Window;
            public uint Message;
            public UIntPtr WParam;
            public IntPtr LParam;
            public uint Time;
            public int X, Y;
            public uint Private;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClassEx(ref WindowClass windowClass);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string name, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool UnregisterClass(string className, IntPtr instance);
        [DllImport("user32.dll")] private static extern bool AddClipboardFormatListener(IntPtr window);
        [DllImport("user32.dll")] private static extern bool RemoveClipboardFormatListener(IntPtr window);
        [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll")] private static extern bool OpenClipboard(IntPtr window);
        [DllImport("user32.dll")] private static extern bool CloseClipboard();
        [DllImport("user32.dll")] private static extern bool IsClipboardFormatAvailable(uint format);
        [DllImport("user32.dll")] private static extern IntPtr GetClipboardData(uint format);
        [DllImport("kernel32.dll")] private static extern UIntPtr GlobalSize(IntPtr memory);
        [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr memory);
        [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr memory);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern bool PeekMessage(out NativeMessage message, IntPtr window, uint first, uint last, uint flags);
        [DllImport("user32.dll")] private static extern bool TranslateMessage(ref NativeMessage message);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DispatchMessage(ref NativeMessage message);
    }
}
'@
Add-Type -TypeDefinition $nativeSource

$powerShellPath = Join-Path $PSHOME 'pwsh.exe'
$terminalCommand = Get-Command wt.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$terminalPath = if ($terminalCommand) { $terminalCommand.Source } else { $null }
$script:lastLaunchedThread = $null
$script:lastLaunchTime = [DateTime]::MinValue
$listener = $null
$mutex = [Threading.Mutex]::new($false, "Local\CodexSharedSessionClipboard-$DesktopPid-$DesktopStartTicks")
$ownsMutex = $false

try {
    try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (!$ownsMutex) { return }

    $onTextChanged = [Action[string]] {
        param([string]$Text)
        $threadGuid = ConvertFrom-CodexLocalThreadLink -Text $Text
        if ($null -eq $threadGuid) { return }
        if ([CodexSharedSession.ClipboardLinkListener]::ForegroundProcessId() -ne $DesktopPid) { return }
        if ((Test-Path -LiteralPath $stopFile) -or !(Test-OriginalDesktopAlive)) { return }

        $threadId = $threadGuid.ToString('D')
        $now = [DateTime]::UtcNow
        if ($threadId -eq $script:lastLaunchedThread -and ($now - $script:lastLaunchTime).TotalSeconds -lt 2) { return }
        $script:lastLaunchedThread = $threadId
        $script:lastLaunchTime = $now

        # These are fixed literal arguments plus a parsed GUID. No clipboard text
        # is used as a command, a path, or a terminal argument.
        $shellArguments = @('-NoLogo', '-NoProfile', '-NoExit', '-File', ('"' + $productionScript + '"'), '-Action', 'OpenCli', '-ThreadId', $threadId)
        $terminalOpened = $false
        try {
            $sourceWindow = [CodexSharedSession.TerminalWindows]::Foreground()
            if ([CodexSharedSession.ClipboardLinkListener]::ForegroundProcessId() -ne $DesktopPid) { return }
            $beforeHandles = @([CodexSharedSession.TerminalWindows]::Snapshot() | ForEach-Object { $_.Handle })
            $windowTitle = 'Codex CLI ' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
            if ([CodexSharedSession.TerminalWindows]::Foreground() -ne $sourceWindow) { return }
            if ($terminalPath) {
                # The nonce identifies only the startup window. Let the CLI replace
                # this temporary title with the actual chat title once it connects.
                $terminalArguments = @('-w', 'new', 'new-tab', '--title', ('"' + $windowTitle + '"'), ('"' + $powerShellPath + '"')) + $shellArguments
                Start-Process -FilePath $terminalPath -ArgumentList $terminalArguments -WorkingDirectory $PSScriptRoot -WindowStyle Normal | Out-Null
                $terminalOpened = $true
                $focusResult = Invoke-CodexTerminalForeground -SourceWindow $sourceWindow -BeforeHandles $beforeHandles -WindowTitle $windowTitle
            } else {
                $createdProcess = Start-Process -FilePath $powerShellPath -ArgumentList $shellArguments -WorkingDirectory $PSScriptRoot -WindowStyle Normal -PassThru
                $terminalOpened = $true
                try {
                    $focusResult = Invoke-CodexTerminalForeground -SourceWindow $sourceWindow -BeforeHandles $beforeHandles -WindowTitle $windowTitle -Mode PowerShell -CreatedProcess $createdProcess
                } finally { $createdProcess.Dispose() }
            }
            @{ at = [DateTime]::UtcNow.ToString('o'); status = $focusResult } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ControlDirectory 'last-terminal-focus.json') -Encoding utf8
            if ($focusResult -notin @('Foreground', 'RaisedWithoutFocus', 'UserSwitched', 'SourceWindowChanged')) {
                Write-Warning 'The side terminal opened, but its foreground position could not be confirmed.'
            }
        } catch {
            try { @{ at = [DateTime]::UtcNow.ToString('o'); status = $(if ($terminalOpened) { 'FocusError' } else { 'LaunchError' }) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ControlDirectory 'last-terminal-focus.json') -Encoding utf8 } catch { }
            if ($terminalOpened) { Write-Warning 'The side terminal was launched, but its foreground position could not be confirmed.' }
            else { Write-Warning 'The side terminal could not be opened.' }
        }
    }
    $listener = [CodexSharedSession.ClipboardLinkListener]::new([uint32]$DesktopPid)
    $listener.add_TextChanged($onTextChanged)
    $nextProcessCheck = [DateTime]::MinValue
    while (!(Test-Path -LiteralPath $stopFile)) {
        if ([DateTime]::UtcNow -ge $nextProcessCheck) {
            if (!(Test-OriginalDesktopAlive)) { break }
            $nextProcessCheck = [DateTime]::UtcNow.AddSeconds(1)
        }
        $listener.Pump()
        Start-Sleep -Milliseconds 100
    }
} finally {
    if ($listener) { $listener.remove_TextChanged($onTextChanged); $listener.Dispose() }
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
