# Only the terminal created for one deliberate chat-link action may be activated.
# These helpers do not register hotkeys, send input, or make a window topmost.
function Initialize-CodexTerminalFocus {
    if ('CodexSharedSession.TerminalWindows' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexSharedSession {
    public sealed class TerminalWindow {
        public long Handle;
        public uint ProcessId;
        public string ProcessName;
        public string ClassName;
        public string Title;
    }
    public static class TerminalWindows {
        public static TerminalWindow[] Snapshot() {
            var result = new List<TerminalWindow>();
            EnumWindows((window, parameter) => {
                if (!IsWindowVisible(window)) return true;
                var className = new StringBuilder(256);
                GetClassName(window, className, className.Capacity);
                string name = className.ToString();
                if (name != "CASCADIA_HOSTING_WINDOW_CLASS" && name != "ConsoleWindowClass") return true;
                uint processId;
                GetWindowThreadProcessId(window, out processId);
                string processName;
                try { using (var process = Process.GetProcessById((int)processId)) processName = process.ProcessName; }
                catch { return true; }
                var title = new StringBuilder(512);
                GetWindowText(window, title, title.Capacity);
                result.Add(new TerminalWindow { Handle = window.ToInt64(), ProcessId = processId,
                    ProcessName = processName, ClassName = name, Title = title.ToString() });
                return true;
            }, IntPtr.Zero);
            return result.ToArray();
        }
        public static long Foreground() { return GetForegroundWindow().ToInt64(); }
        public static bool TargetIsValid(TerminalWindow target) {
            IntPtr window = new IntPtr(target.Handle);
            uint actualProcessId;
            GetWindowThreadProcessId(window, out actualProcessId);
            if (!IsWindow(window) || !IsWindowVisible(window) || actualProcessId != target.ProcessId) return false;
            var className = new StringBuilder(256);
            GetClassName(window, className, className.Capacity);
            // The nonce title identified this new HWND once. The CLI may now
            // replace its title legitimately; retain the HWND/PID/class checks.
            return className.ToString() == target.ClassName;
        }
        public static string Activate(TerminalWindow target, long sourceHandle) {
            if (!TargetIsValid(target)) return "TargetInvalid";
            long handle = target.Handle;
            IntPtr window = new IntPtr(handle);
            long foreground = Foreground();
            if (foreground == handle) return "Foreground";
            if (foreground != sourceHandle) return "SourceWindowChanged";
            // Restore only this target. Async avoids waiting on another UI thread.
            if (IsIconic(window)) ShowWindowAsync(window, 9);
            foreground = Foreground();
            if (foreground == handle) return "Foreground";
            if (foreground != sourceHandle) return "SourceWindowChanged";
            return SetForegroundWindow(window) ? "ActivationRequested" : "ActivationApiRejected";
        }
        public static bool IsTopmost(long handle) {
            return (GetWindowLong(new IntPtr(handle), -20) & 0x00000008) != 0;
        }
        public static string RaiseWithoutFocus(TerminalWindow target, long sourceHandle, bool wasTopmost) {
            if (!TargetIsValid(target)) return "TargetInvalid";
            if (Foreground() == target.Handle) return "Foreground";
            if (Foreground() != sourceHandle) return "SourceWindowChanged";
            if (IsTopmost(target.Handle) != wasTopmost) return "TopmostStateChanged";
            if (IsIconic(new IntPtr(target.Handle))) return "TargetMinimized";
            // HWND_TOP changes ordinary Z order once. It never requests TOPMOST.
            const uint flags = 0x0001 | 0x0002 | 0x0010 | 0x0200 | 0x4000;
            return SetWindowPos(new IntPtr(target.Handle), IntPtr.Zero, 0, 0, 0, 0, flags)
                ? "RaiseRequested" : "RaiseApiRejected";
        }
        public static string ReadRaiseState(TerminalWindow target, long sourceHandle, bool wasTopmost) {
            if (!TargetIsValid(target) || !IsWindow(new IntPtr(sourceHandle))) return "TargetInvalid";
            long foreground = Foreground();
            if (foreground != sourceHandle && foreground != target.Handle) return "SourceWindowChanged";
            if (IsTopmost(target.Handle) != wasTopmost) return "TopmostStateChanged";
            if (foreground == target.Handle) return "Foreground";
            if (IsIconic(new IntPtr(target.Handle))) return "TargetMinimized";
            int targetIndex = -1, sourceIndex = -1, index = 0;
            EnumWindows((window, parameter) => {
                long handle = window.ToInt64();
                if (handle == target.Handle) targetIndex = index;
                if (handle == sourceHandle) sourceIndex = index;
                index++;
                return targetIndex < 0 || sourceIndex < 0;
            }, IntPtr.Zero);
            if (targetIndex >= 0 && sourceIndex >= 0 && targetIndex < sourceIndex) {
                // Recheck after enumeration: a later user switch must not be
                // reported as a successful foreground/stacking operation.
                foreground = Foreground();
                if (foreground != sourceHandle && foreground != target.Handle) return "SourceWindowChanged";
                if (!TargetIsValid(target)) return "TargetInvalid";
                if (IsTopmost(target.Handle) != wasTopmost) return "TopmostStateChanged";
                return foreground == target.Handle ? "Foreground" : "RaisedWithoutFocus";
            }
            return "RaisePending";
        }
        private delegate bool EnumWindowProcedure(IntPtr window, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProcedure procedure, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong(IntPtr window, int index);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);
    }
}
'@
}

function Select-CodexNewTerminalWindow {
    param(
        [AllowEmptyCollection()][object[]]$Windows,
        [AllowEmptyCollection()][long[]]$BeforeHandles,
        [Parameter(Mandatory)][string]$WindowTitle,
        [ValidateSet('WindowsTerminal','PowerShell')][string]$Mode = 'WindowsTerminal',
        [long]$CreatedProcessWindow = 0,
        [int]$CreatedProcessId = 0
    )
    $matches = @($Windows | Where-Object {
        $_.Handle -ne 0 -and $_.Handle -notin $BeforeHandles -and $(
            if ($Mode -eq 'WindowsTerminal') {
                $_.ClassName -ceq 'CASCADIA_HOSTING_WINDOW_CLASS' -and
                $_.ProcessName -ieq 'WindowsTerminal' -and $_.Title -ceq $WindowTitle
            } else {
                $CreatedProcessWindow -ne 0 -and $_.Handle -eq $CreatedProcessWindow -and
                $_.ProcessId -eq $CreatedProcessId
            }
        )
    })
    if ($matches.Count -eq 1) { return [pscustomobject]@{ Status = 'Found'; Window = $matches[0] } }
    return [pscustomobject]@{ Status = $(if ($matches.Count) { 'Ambiguous' } else { 'Pending' }); Window = $null }
}

function Invoke-CodexTerminalForeground {
    param(
        [Parameter(Mandatory)][long]$SourceWindow,
        [AllowEmptyCollection()][long[]]$BeforeHandles,
        [Parameter(Mandatory)][string]$WindowTitle,
        [ValidateSet('WindowsTerminal','PowerShell')][string]$Mode = 'WindowsTerminal',
        [Diagnostics.Process]$CreatedProcess
    )
    Initialize-CodexTerminalFocus
    if ($SourceWindow -eq 0) { return 'Unavailable' }
    $createdTicks = if ($CreatedProcess) { $CreatedProcess.StartTime.ToUniversalTime().Ticks } else { 0 }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt 3000) {
        $createdWindow = 0L
        $createdId = 0
        if ($Mode -eq 'PowerShell') {
            try {
                if (!$CreatedProcess -or $CreatedProcess.HasExited) { return 'Unavailable' }
                $CreatedProcess.Refresh()
                if ($CreatedProcess.StartTime.ToUniversalTime().Ticks -ne $createdTicks) { return 'Unavailable' }
                $createdWindow = $CreatedProcess.MainWindowHandle.ToInt64()
                $createdId = $CreatedProcess.Id
            } catch { return 'Unavailable' }
        }
        $selected = Select-CodexNewTerminalWindow -Windows ([CodexSharedSession.TerminalWindows]::Snapshot()) `
            -BeforeHandles $BeforeHandles -WindowTitle $WindowTitle -Mode $Mode `
            -CreatedProcessWindow $createdWindow -CreatedProcessId $createdId
        $foreground = [CodexSharedSession.TerminalWindows]::Foreground()
        if ($selected.Status -eq 'Ambiguous') { return 'Ambiguous' }
        if ($selected.Status -eq 'Found' -and $foreground -eq $selected.Window.Handle) { return 'Foreground' }
        # Once the user changes apps, never steal focus back later in this request.
        if ($foreground -ne $SourceWindow) { return 'UserSwitched' }
        if ($selected.Status -eq 'Found') {
            $target = $selected.Window
            $activation = [CodexSharedSession.TerminalWindows]::Activate($target, $SourceWindow)
            if ($activation -in @('Foreground', 'TargetInvalid', 'SourceWindowChanged')) { return $activation }
            # An accepted request can activate asynchronously. Do not repeat it.
            $activationClock = [Diagnostics.Stopwatch]::StartNew()
            while ($activationClock.ElapsedMilliseconds -lt 500) {
                $foreground = [CodexSharedSession.TerminalWindows]::Foreground()
                if ($foreground -eq $target.Handle) { return 'Foreground' }
                if ($foreground -ne $SourceWindow) { return 'SourceWindowChanged' }
                if (![CodexSharedSession.TerminalWindows]::TargetIsValid($target)) { return 'TargetInvalid' }
                Start-Sleep -Milliseconds 25
            }
            $activationFailure = if ($activation -eq 'ActivationApiRejected') { $activation } else { 'ActivationNotObserved' }
            $wasTopmost = [CodexSharedSession.TerminalWindows]::IsTopmost($target.Handle)
            $raise = [CodexSharedSession.TerminalWindows]::RaiseWithoutFocus($target, $SourceWindow, $wasTopmost)
            if ($raise -eq 'Foreground') { return $raise }
            if ($raise -ne 'RaiseRequested') { return ($activationFailure + '/' + $raise) }
            $raiseClock = [Diagnostics.Stopwatch]::StartNew()
            while ($raiseClock.ElapsedMilliseconds -lt 500) {
                $state = [CodexSharedSession.TerminalWindows]::ReadRaiseState($target, $SourceWindow, $wasTopmost)
                if ($state -in @('Foreground', 'RaisedWithoutFocus')) { return $state }
                if ($state -ne 'RaisePending') { return ($activationFailure + '/' + $state) }
                Start-Sleep -Milliseconds 25
            }
            return ($activationFailure + '/RaiseNotObserved')
        }
        Start-Sleep -Milliseconds 100
    }
    return 'Unavailable'
}
