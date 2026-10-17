# Only the terminal created for one deliberate chat-link action may be activated.
# No hotkeys or input are sent. The fallback briefly raises this window through
# the topmost band, then restores its ordinary window state before reporting success.
function Initialize-CodexTerminalFocus {
    if ('CodexSharedSession.TerminalWindows' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CodexSharedSession {
    public sealed class TerminalWindow {
        public long Handle;
        public uint ProcessId;
        public long ProcessStartTicks;
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
                long processStartTicks;
                try {
                    using (var process = Process.GetProcessById((int)processId)) {
                        processName = process.ProcessName;
                        processStartTicks = process.StartTime.ToUniversalTime().Ticks;
                    }
                }
                catch { return true; }
                var title = new StringBuilder(512);
                GetWindowText(window, title, title.Capacity);
                result.Add(new TerminalWindow { Handle = window.ToInt64(), ProcessId = processId,
                    ProcessStartTicks = processStartTicks, ProcessName = processName,
                    ClassName = name, Title = title.ToString() });
                return true;
            }, IntPtr.Zero);
            return result.ToArray();
        }
        public static long Foreground() { return GetForegroundWindow().ToInt64(); }
        private static bool TargetIdentityMatches(TerminalWindow target) {
            if (target == null || target.Handle == 0 || target.ProcessId == 0 || target.ProcessStartTicks <= 0) return false;
            IntPtr window = new IntPtr(target.Handle);
            uint actualProcessId;
            GetWindowThreadProcessId(window, out actualProcessId);
            if (!IsWindow(window) || actualProcessId != target.ProcessId) return false;
            try {
                using (var process = Process.GetProcessById((int)actualProcessId)) {
                    if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != target.ProcessStartTicks) return false;
                }
            } catch { return false; }
            var className = new StringBuilder(256);
            GetClassName(window, className, className.Capacity);
            // The nonce title identified this new HWND once. The CLI may now
            // replace its title legitimately. PID reuse must not authorize a mutation.
            return className.ToString() == target.ClassName;
        }
        public static bool TargetIsValid(TerminalWindow target) {
            return TargetIdentityMatches(target) && IsWindowVisible(new IntPtr(target.Handle));
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
            if (!TargetIsValid(target)) return "TargetInvalid";
            return SetForegroundWindow(window) ? "ActivationRequested" : "ActivationApiRejected";
        }
        public static bool IsTopmost(long handle) {
            return (GetWindowLong(new IntPtr(handle), -20) & 0x00000008) != 0;
        }
        private static string CheckCanRaise(TerminalWindow target, long sourceHandle, bool wasTopmost) {
            if (!TargetIsValid(target)) return "TargetInvalid";
            if (!IsWindow(new IntPtr(sourceHandle))) return "SourceWindowInvalid";
            if (Foreground() == target.Handle) return "Foreground";
            if (Foreground() != sourceHandle) return "SourceWindowChanged";
            // Never undo a pre-existing topmost preference belonging to the user.
            if (wasTopmost) return "AlreadyTopmost";
            if (IsTopmost(target.Handle) != wasTopmost) return "TopmostStateChanged";
            if (IsIconic(new IntPtr(target.Handle))) return "TargetMinimized";
            return "Ready";
        }
        // The injected callbacks allow the guard/finally ordering to be tested
        // without touching a desktop. Cleanup never depends on the foreground app.
        public static string RunTemporaryRaise(Func<string> guard, Func<string> promote, Func<string> cleanup) {
            string result = guard();
            if (result != "Ready") return result;
            string cleanupResult = null;
            try { result = promote(); }
            catch (Exception) { result = "PromotionError"; }
            finally {
                try { cleanupResult = cleanup(); }
                catch (Exception) { cleanupResult = "CleanupError"; }
            }
            // Preserve cleanup failures even if promotion threw. Fixed status
            // labels also keep exception details out of the watcher's log.
            return cleanupResult == "Demoted" ? result : result + "/" + cleanupResult;
        }
        public static string RaiseWithoutFocus(TerminalWindow target, long sourceHandle, bool wasTopmost) {
            // Both requests originate on this thread and use the same async
            // flags. Observe promotion before accepting demotion as completion;
            // a successful asynchronous API return is only a queued request.
            const uint flags = 0x0001 | 0x0002 | 0x0010 | 0x0200 | 0x4000;
            bool promotionAttempted = false, promotionAccepted = false, promotionObserved = false;
            return RunTemporaryRaise(
                () => CheckCanRaise(target, sourceHandle, wasTopmost),
                () => {
                    string ready = CheckCanRaise(target, sourceHandle, wasTopmost);
                    if (ready != "Ready") return ready;
                    promotionAttempted = true;
                    promotionAccepted = SetWindowPos(new IntPtr(target.Handle), new IntPtr(-1), 0, 0, 0, 0, flags);
                    if (!promotionAccepted) return "PromotionApiRejected";
                    var clock = Stopwatch.StartNew();
                    while (clock.ElapsedMilliseconds < 150) {
                        if (!TargetIdentityMatches(target)) return "TargetInvalid";
                        if (IsTopmost(target.Handle)) { promotionObserved = true; return "RaiseRequested"; }
                        long foreground = Foreground();
                        if (foreground != sourceHandle && foreground != target.Handle) return "SourceWindowChanged";
                        Thread.Sleep(10);
                    }
                    return "PromotionNotObserved";
                },
                () => {
                    if (!promotionAttempted) return "Demoted";
                    // Even after a user switch or a target becoming hidden,
                    // restore only the same HWND/process incarnation in finally.
                    if (!TargetIdentityMatches(target)) return "CleanupTargetInvalid";
                    bool demotionAccepted = SetWindowPos(new IntPtr(target.Handle), new IntPtr(-2), 0, 0, 0, 0, flags);
                    var clock = Stopwatch.StartNew();
                    long nextRetry = 100;
                    while (clock.ElapsedMilliseconds < 500) {
                        if (!TargetIdentityMatches(target)) return "CleanupTargetInvalid";
                        bool topmost = IsTopmost(target.Handle);
                        if (!topmost && (promotionObserved || !promotionAccepted)) return "Demoted";
                        if (topmost) promotionObserved = true;
                        // A late promotion may arrive after the first readback.
                        // Only demotion may be retried; never promote again.
                        if ((topmost || !demotionAccepted) && clock.ElapsedMilliseconds >= nextRetry) {
                            if (!TargetIdentityMatches(target)) return "CleanupTargetInvalid";
                            demotionAccepted = SetWindowPos(new IntPtr(target.Handle), new IntPtr(-2), 0, 0, 0, 0, flags) || demotionAccepted;
                            nextRetry = clock.ElapsedMilliseconds + 100;
                        }
                        Thread.Sleep(10);
                    }
                    if (!TargetIdentityMatches(target)) return "CleanupTargetInvalid";
                    if (!IsTopmost(target.Handle) && promotionObserved) return "Demoted";
                    if (!demotionAccepted) return "DemotionApiRejected";
                    return IsTopmost(target.Handle) ? "DemotionNotObserved" : "CleanupUnconfirmed";
                });
        }
        public static string ReadRaiseState(TerminalWindow target, long sourceHandle, bool wasTopmost) {
            if (!TargetIsValid(target) || !IsWindow(new IntPtr(sourceHandle))) return "TargetInvalid";
            long foreground = Foreground();
            if (foreground != sourceHandle && foreground != target.Handle) return "SourceWindowChanged";
            if (wasTopmost || IsTopmost(target.Handle)) return "TopmostStateChanged";
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
                if (wasTopmost || IsTopmost(target.Handle)) return "TopmostStateChanged";
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
