using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace CstDesktopNavigation
{
    public sealed class WindowIdentity
    {
        public long Handle;
        public int ProcessId;
        public long StartTicks;
        public string ExecutablePath;
        public string UserSid;
        public int SessionId;
        public string WindowClass;
        public string PackageFullName;
        public string PackageFamilyName;
        public string PackageRoot;
    }

    // Fixtures supply these few actions; production never accepts identities or
    // operations from argv. There is no persistent process or external helper.
    public interface IOps
    {
        long NowMilliseconds { get; }
        WindowIdentity CaptureSource();
        WindowIdentity[] FindTargets();
        bool SourceIsForeground(WindowIdentity source);
        string Dispatch(WindowIdentity source, WindowIdentity target, string uri);
        string Check(WindowIdentity source, WindowIdentity target);
        string Restore(WindowIdentity source, WindowIdentity target);
        string Activate(WindowIdentity source, WindowIdentity target);
        void Delay(int milliseconds);
    }

    public sealed class NavigationResult
    {
        public string Status { get; private set; }
        public bool Dispatched { get; private set; }
        public bool Foreground { get; private set; }

        public NavigationResult(string status, bool dispatched)
        {
            switch (status)
            {
                case "Foreground": case "NotForeground": case "SourceChanged": case "InvalidContext":
                case "SourceUnavailable": case "DesktopUnavailable": case "Ambiguous": case "DispatchFailed":
                    Status = status; break;
                default: Status = "InvalidContext"; break;
            }
            Dispatched = dispatched;
            Foreground = Status == "Foreground";
        }

        public string ToJson()
        {
            // Status comes only from the finite vocabulary above. Dispatch is
            // not a page-navigation receipt, even when foreground is observed.
            return "{\"status\":\"" + Status + "\",\"dispatched\":" +
                (Dispatched ? "true" : "false") + ",\"foreground\":" +
                (Foreground ? "true" : "false") + "}";
        }
    }

    public static class Navigation
    {
        public const string OfficialPackageFamily = "OpenAI.Codex_2p2nqsd0c76g0";
        private const long ContextLifetimeMilliseconds = 60000;

        public static string BuildUri(string threadId, string hostId)
        {
            Guid parsed;
            if (threadId == null || threadId.Length != 36 ||
                (hostId != "local" && hostId != "durable") ||
                !Guid.TryParseExact(threadId, "D", out parsed) || parsed == Guid.Empty ||
                !String.Equals(threadId, parsed.ToString("D"), StringComparison.OrdinalIgnoreCase)) return null;
            return "codex://threads/" + parsed.ToString("D") + "?hostId=" + hostId;
        }

        private static bool IsText(string value, int limit)
        {
            if (String.IsNullOrEmpty(value) || value.Length > limit) return false;
            foreach (char character in value)
                if (Char.IsControl(character)) return false;
            return true;
        }

        private static bool IsAbsoluteWindowsPath(string path)
        {
            if (!IsText(path, 32768) || path.Length < 4 ||
                !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) ||
                path[1] != ':' || path[2] != '\\') return false;
            string[] parts = path.Substring(3).Split('\\');
            foreach (string part in parts)
            {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) ||
                    part.EndsWith(" ", StringComparison.Ordinal) || part.IndexOfAny(new char[] { '/', ':', '*', '?', '"', '<', '>', '|' }) >= 0)
                    return false;
            }
            return true;
        }

        public static bool ValidPackageIdentity(WindowIdentity target)
        {
            if (target == null || target.PackageFamilyName != OfficialPackageFamily ||
                !IsText(target.PackageFullName, 1024) ||
                !target.PackageFullName.StartsWith("OpenAI.Codex_", StringComparison.Ordinal) ||
                !target.PackageFullName.EndsWith("_2p2nqsd0c76g0", StringComparison.Ordinal) ||
                !IsAbsoluteWindowsPath(target.PackageRoot) || !IsAbsoluteWindowsPath(target.ExecutablePath)) return false;
            // FullName/FamilyName are read from the same process handle, and
            // PackageRoot comes from GetPackagePathByFullName(fullName), not cwd.
            return String.Equals(target.ExecutablePath, target.PackageRoot + "\\app\\ChatGPT.exe", StringComparison.OrdinalIgnoreCase);
        }

        public static bool ValidIdentity(WindowIdentity value, bool source)
        {
            if (value == null || value.Handle <= 0 || value.ProcessId <= 0 || value.StartTicks <= 0 ||
                value.StartTicks > DateTime.MaxValue.Ticks || value.SessionId < 0 ||
                !IsAbsoluteWindowsPath(value.ExecutablePath) || !IsText(value.UserSid, 184) ||
                !IsText(value.WindowClass, 255)) return false;
            try { new SecurityIdentifier(value.UserSid); } catch { return false; }
            string name = Path.GetFileName(value.ExecutablePath);
            if (source)
                return value.WindowClass == "CASCADIA_HOSTING_WINDOW_CLASS" && String.Equals(name, "WindowsTerminal.exe", StringComparison.OrdinalIgnoreCase) ||
                    value.WindowClass == "ConsoleWindowClass" && (String.Equals(name, "conhost.exe", StringComparison.OrdinalIgnoreCase) ||
                        String.Equals(name, "OpenConsole.exe", StringComparison.OrdinalIgnoreCase));
            return ValidPackageIdentity(value);
        }

        internal static bool SameCoreIdentity(WindowIdentity expected, WindowIdentity actual)
        {
            return expected != null && actual != null && expected.Handle == actual.Handle && expected.ProcessId == actual.ProcessId &&
                expected.StartTicks == actual.StartTicks && expected.UserSid == actual.UserSid && expected.SessionId == actual.SessionId &&
                expected.WindowClass == actual.WindowClass && String.Equals(expected.ExecutablePath, actual.ExecutablePath, StringComparison.OrdinalIgnoreCase);
        }

        public static bool SameIdentity(WindowIdentity expected, WindowIdentity actual)
        {
            return SameCoreIdentity(expected, actual) && expected.PackageFullName == actual.PackageFullName &&
                expected.PackageFamilyName == actual.PackageFamilyName && String.Equals(expected.PackageRoot, actual.PackageRoot, StringComparison.OrdinalIgnoreCase);
        }

        private static bool ValidPair(WindowIdentity source, WindowIdentity target)
        {
            return ValidIdentity(source, true) && ValidIdentity(target, false) && source.Handle != target.Handle &&
                source.ProcessId != target.ProcessId && source.UserSid == target.UserSid && source.SessionId == target.SessionId;
        }

        private static bool WithinLifetime(long started, long now)
        {
            return started >= 0 && now >= started && now - started <= ContextLifetimeMilliseconds;
        }

        public static ProcessStartInfo CreateStartInfo(WindowIdentity target, string uri)
        {
            const string prefix = "codex://threads/";
            if (!ValidIdentity(target, false) || uri == null || !uri.StartsWith(prefix, StringComparison.Ordinal))
                throw new ArgumentException("Invalid Desktop thread dispatch.");
            int separator = uri.IndexOf("?hostId=", StringComparison.Ordinal);
            if (separator != prefix.Length + 36 ||
                BuildUri(uri.Substring(prefix.Length, 36), uri.Substring(separator + 8)) != uri)
                throw new ArgumentException("Invalid Desktop thread dispatch.");
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = target.ExecutablePath;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            // Chromium's --single-argument consumes the raw command-line tail,
            // including quotes. Match the working ArgumentList serialization:
            // this strictly validated URI has no whitespace or quote syntax.
            info.Arguments = "--single-argument " + uri;
            List<string> remove = new List<string>();
            foreach (string key in info.EnvironmentVariables.Keys)
            {
                if (key.StartsWith("CODEX_", StringComparison.OrdinalIgnoreCase) || key.StartsWith("CST_", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(key, "BUILD_FLAVOR", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(key, "ELECTRON_RUN_AS_NODE", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(key, "NODE_OPTIONS", StringComparison.OrdinalIgnoreCase)) remove.Add(key);
            }
            foreach (string key in remove) info.EnvironmentVariables.Remove(key);
            return info;
        }

        public static NavigationResult Run(string threadId, string hostId, IOps ops)
        {
            bool dispatched = false;
            string uri = BuildUri(threadId, hostId);
            if (uri == null) return new NavigationResult("InvalidContext", false);
            try
            {
                // No native declarations are invoked or app metadata read for
                // malformed input, including when no fixture operations exist.
                if (ops == null) ops = new NativeOps();
                long started = ops.NowMilliseconds;
                WindowIdentity source = ops.CaptureSource();
                if (!ValidIdentity(source, true)) return new NavigationResult("SourceUnavailable", false);
                WindowIdentity[] targets = ops.FindTargets();
                if (targets == null || targets.Length == 0) return new NavigationResult("DesktopUnavailable", false);
                if (targets.Length > 1) return new NavigationResult("Ambiguous", false);
                WindowIdentity target = targets[0];
                if (!ValidPair(source, target) || !WithinLifetime(started, ops.NowMilliseconds))
                    return new NavigationResult("DesktopUnavailable", false);
                if (!ops.SourceIsForeground(source)) return new NavigationResult("SourceUnavailable", false);
                if (!WithinLifetime(started, ops.NowMilliseconds)) return new NavigationResult("InvalidContext", false);
                string status = ops.Dispatch(source, target, uri);
                if (status != "Dispatched") return new NavigationResult(status, false);
                dispatched = true;
                if (!WithinLifetime(started, ops.NowMilliseconds)) return new NavigationResult("InvalidContext", true);
                status = ops.Check(source, target);
                if (status != "Ready") return new NavigationResult(status, true);
                if (!WithinLifetime(started, ops.NowMilliseconds)) return new NavigationResult("InvalidContext", true);
                status = ops.Restore(source, target);
                if (status != "Ready") return new NavigationResult(status, true);
                if (!WithinLifetime(started, ops.NowMilliseconds)) return new NavigationResult("InvalidContext", true);
                status = ops.Activate(source, target);
                if (status != "Ready") return new NavigationResult(status, true);
                long readbackStarted = ops.NowMilliseconds;
                for (int attempt = 0; attempt <= 20; attempt++)
                {
                    long now = ops.NowMilliseconds;
                    if (!WithinLifetime(started, now) || now < readbackStarted) return new NavigationResult("InvalidContext", true);
                    status = ops.Check(source, target);
                    if (status != "Ready") return new NavigationResult(status, true);
                    long elapsed = ops.NowMilliseconds - readbackStarted;
                    if (attempt == 20 || elapsed >= 500) break;
                    ops.Delay((int)Math.Min(25, 500 - elapsed));
                }
                return new NavigationResult("NotForeground", true);
            }
            catch { return new NavigationResult("InvalidContext", dispatched); }
        }
    }

    public static class Program
    {
        public static string Execute(string[] args, IOps ops)
        {
            if (args != null && args.Length == 1 && args[0] == "--check") return "{\"version\":1,\"ready\":true}";
            if (args == null || args.Length != 4 || args[0] != "--thread" || args[2] != "--host")
                return new NavigationResult("InvalidContext", false).ToJson();
            return Navigation.Run(args[1], args[3], ops).ToJson();
        }

        public static int Main(string[] args)
        {
            Console.WriteLine(Execute(args, null));
            return 0;
        }
    }

    internal sealed class NativeOps : IOps
    {
        private readonly string currentUserSid;
        private readonly uint currentSession;
        private delegate bool EnumWindowProcedure(IntPtr window, IntPtr parameter);
        private delegate int ReadPackageString(ref uint length, StringBuilder value);

        public NativeOps()
        {
            using (WindowsIdentity current = WindowsIdentity.GetCurrent())
            {
                if (current.User == null) throw new InvalidOperationException("No current user.");
                currentUserSid = current.User.Value;
            }
            uint session;
            if (!ProcessIdToSessionId(GetCurrentProcessId(), out session)) throw new InvalidOperationException("No current session.");
            currentSession = session;
        }

        public long NowMilliseconds { get { return (DateTime.UtcNow.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond; } }
        public void Delay(int milliseconds) { Thread.Sleep(milliseconds); }

        private static string ReadPackageValue(ReadPackageString read, uint limit)
        {
            uint length = 0;
            // These APIs return LONG error codes, not BOOL/GetLastError. In
            // particular, NO_PACKAGE never falls back to an executable name.
            if (read(ref length, null) != 122 || length < 2 || length > limit) return null;
            uint capacity = length;
            StringBuilder value = new StringBuilder((int)capacity);
            if (read(ref length, value) != 0 || length < 2 || length > capacity || value.Length == 0 || value.Length >= capacity) return null;
            return value.ToString();
        }

        private WindowIdentity Inspect(IntPtr window, bool source, bool includePackage)
        {
            if (window == IntPtr.Zero || !IsWindow(window) || !IsWindowVisible(window) ||
                GetAncestor(window, 2) != window || GetWindow(window, 4) != IntPtr.Zero) return null;
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid == 0 || pid > Int32.MaxValue) return null;
            IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
            if (process == IntPtr.Zero) return null;
            try
            {
                uint size = 32768;
                StringBuilder path = new StringBuilder((int)size);
                StringBuilder className = new StringBuilder(256);
                if (!QueryFullProcessImageName(process, 0, path, ref size) || GetClassName(window, className, className.Capacity) == 0) return null;
                string executablePath = path.ToString();
                string name = Path.GetFileName(executablePath);
                string windowClass = className.ToString();
                // Reject unrelated windows before token and package queries.
                if (source)
                {
                    if (!(windowClass == "CASCADIA_HOSTING_WINDOW_CLASS" && String.Equals(name, "WindowsTerminal.exe", StringComparison.OrdinalIgnoreCase) ||
                        windowClass == "ConsoleWindowClass" && (String.Equals(name, "conhost.exe", StringComparison.OrdinalIgnoreCase) ||
                            String.Equals(name, "OpenConsole.exe", StringComparison.OrdinalIgnoreCase)))) return null;
                }
                else if (!String.Equals(name, "ChatGPT.exe", StringComparison.OrdinalIgnoreCase)) return null;
                long creation, exit, kernel, user;
                uint session;
                if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) || exit != 0 ||
                    !ProcessIdToSessionId(pid, out session) || session != currentSession || !OpenProcessToken(process, 8, out token)) return null;
                string sid;
                using (WindowsIdentity peer = new WindowsIdentity(token))
                {
                    if (peer.User == null || peer.User.Value != currentUserSid) return null;
                    sid = peer.User.Value;
                }
                WindowIdentity identity = new WindowIdentity();
                identity.Handle = window.ToInt64(); identity.ProcessId = (int)pid;
                identity.StartTicks = DateTime.FromFileTimeUtc(creation).Ticks;
                identity.ExecutablePath = executablePath; identity.UserSid = sid;
                identity.SessionId = (int)session; identity.WindowClass = windowClass;
                if (includePackage)
                {
                    identity.PackageFullName = ReadPackageValue(delegate(ref uint length, StringBuilder value) { return GetPackageFullName(process, ref length, value); }, 1024);
                    identity.PackageFamilyName = ReadPackageValue(delegate(ref uint length, StringBuilder value) { return GetPackageFamilyName(process, ref length, value); }, 1024);
                    if (identity.PackageFullName == null || identity.PackageFamilyName != Navigation.OfficialPackageFamily) return null;
                    identity.PackageRoot = ReadPackageValue(delegate(ref uint length, StringBuilder value) { return GetPackagePathByFullName(identity.PackageFullName, ref length, value); }, 32768);
                    if (!Navigation.ValidPackageIdentity(identity)) return null;
                }
                uint again;
                GetWindowThreadProcessId(window, out again);
                if (!IsWindow(window) || again != pid) return null;
                return identity;
            }
            catch { return null; }
            finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
        }

        public WindowIdentity CaptureSource() { return Inspect(GetForegroundWindow(), true, false); }

        internal WindowIdentity InspectTarget(long handle) { return Inspect(new IntPtr(handle), false, true); }

        public WindowIdentity[] FindTargets()
        {
            List<WindowIdentity> found = new List<WindowIdentity>();
            bool complete = EnumWindows(delegate(IntPtr window, IntPtr ignored)
            {
                WindowIdentity candidate = Inspect(window, false, true);
                if (candidate != null) found.Add(candidate);
                return true;
            }, IntPtr.Zero);
            return complete ? found.ToArray() : new WindowIdentity[0];
        }

        public bool SourceIsForeground(WindowIdentity source)
        {
            return Navigation.ValidIdentity(source, true) && GetForegroundWindow().ToInt64() == source.Handle &&
                Navigation.SameCoreIdentity(source, Inspect(new IntPtr(source.Handle), true, false));
        }

        public string Check(WindowIdentity source, WindowIdentity target)
        {
            if (!Navigation.ValidIdentity(source, true) || !Navigation.ValidIdentity(target, false) ||
                !Navigation.SameCoreIdentity(source, Inspect(new IntPtr(source.Handle), true, false)) ||
                !Navigation.SameCoreIdentity(target, Inspect(new IntPtr(target.Handle), false, false))) return "InvalidContext";
            // Package identity was verified on the captured process handle. A
            // matching creation time, PID and exact executable binds this check
            // to that same process; no repeated package registration query is
            // needed while the immutable process identity remains unchanged.
            long foreground = GetForegroundWindow().ToInt64();
            if (foreground == target.Handle) return "Foreground";
            return foreground == source.Handle ? "Ready" : "SourceChanged";
        }

        public string Dispatch(WindowIdentity source, WindowIdentity target, string uri)
        {
            ProcessStartInfo info = Navigation.CreateStartInfo(target, uri);
            string status = Check(source, target);
            if (status == "Foreground") return "SourceChanged";
            if (status != "Ready") return status;
            Process child = null;
            try
            {
                // No PID-addressed single-instance API exists. An original
                // instance exiting after the check remains a narrow TOCTOU;
                // absent or changed targets never reach this dispatch.
                child = Process.Start(info);
                return child == null ? "DispatchFailed" : "Dispatched";
            }
            catch { return "DispatchFailed"; }
            finally { if (child != null) { try { child.Dispose(); } catch { } } }
        }

        public string Restore(WindowIdentity source, WindowIdentity target)
        {
            string status = Check(source, target);
            if (status != "Ready") return status;
            IntPtr window = new IntPtr(target.Handle);
            if (IsIconic(window))
            {
                status = Check(source, target);
                if (status != "Ready") return status;
                ShowWindowAsync(window, 9);
            }
            return "Ready";
        }

        public string Activate(WindowIdentity source, WindowIdentity target)
        {
            string status = Check(source, target);
            if (status != "Ready") return status;
            SetForegroundWindow(new IntPtr(target.Handle));
            return "Ready";
        }

        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProcedure callback, IntPtr parameter);
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder value);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder value);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetPackagePathByFullName(string fullName, ref uint length, StringBuilder value);
    }
}
