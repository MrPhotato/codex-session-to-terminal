// Standalone fixtures. Compile this file together with Desktop-Navigation.cs
// and select /main:CstDesktopNavigation.Tests.EntryPoint. No native operations,
// application launches, foreground changes, or real desktop instances are used.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

namespace CstDesktopNavigation.Tests {
    internal sealed class FakeOps : IOps {
        public long Now = 1800000000000L;
        public readonly List<string> Calls = new List<string>();
        public readonly Queue<string> Checks = new Queue<string>();
        public WindowIdentity Source = Fixtures.Source();
        public WindowIdentity Target = Fixtures.Target();
        public WindowIdentity[] Targets;
        public bool SourceForeground = true;
        public string DefaultCheck = "Ready";
        public string DispatchResult = "Dispatched";
        public string RestoreResult = "Ready";
        public string ActivateResult = "Ready";
        public long DispatchElapsed;
        public string DispatchUri;
        public WindowIdentity DispatchedSource;
        public WindowIdentity DispatchedTarget;
        public string ThrowAt;

        public FakeOps() { Targets = new[] { Target }; }
        private void Called(string name) {
            Calls.Add(name);
            if (ThrowAt == name) throw new InvalidOperationException("fixture " + name);
        }
        public long NowMilliseconds { get { Called("clock"); return Now; } }
        public WindowIdentity CaptureSource() { Called("source"); return Source; }
        public WindowIdentity[] FindTargets() { Called("targets"); return Targets; }
        public bool SourceIsForeground(WindowIdentity source) { Called("source-check"); return SourceForeground; }
        public string Dispatch(WindowIdentity source, WindowIdentity target, string uri) {
            Called("dispatch");
            DispatchedSource = source; DispatchedTarget = target; DispatchUri = uri;
            Now += DispatchElapsed;
            return DispatchResult;
        }
        public string Check(WindowIdentity source, WindowIdentity target) {
            Called("check"); return Checks.Count > 0 ? Checks.Dequeue() : DefaultCheck;
        }
        public string Restore(WindowIdentity source, WindowIdentity target) { Called("restore"); return RestoreResult; }
        public string Activate(WindowIdentity source, WindowIdentity target) { Called("activate"); return ActivateResult; }
        public void Delay(int milliseconds) {
            Called("delay");
            Fixtures.Assert(milliseconds == 25, "Polling must use the bounded 25 ms interval.");
            Now += milliseconds;
        }
        public int Count(string name) { return Calls.FindAll(value => value == name).Count; }
        public bool TouchedWindow { get { return Count("restore") != 0 || Count("activate") != 0; } }
    }

    internal static class Fixtures {
        public const string ThreadId = "01a11946-12fe-7f81-81d9-de3b2fb11444";
        public const string Family = "OpenAI.Codex_2p2nqsd0c76g0";
        public const string FullName = "OpenAI.Codex_26.1000.1.0_x64__2p2nqsd0c76g0";
        public const string Root = @"C:\Program Files\WindowsApps\OpenAI.Codex_26.1000.1.0_x64__2p2nqsd0c76g0";
        public static void Assert(bool condition, string message) {
            if (!condition) throw new Exception(message);
        }
        public static WindowIdentity Source() {
            return new WindowIdentity {
                Handle = 101, ProcessId = 1001, StartTicks = 639200000000000000L,
                ExecutablePath = @"C:\Terminal\WindowsTerminal.exe", UserSid = "S-1-5-21-1-2-3-1001",
                SessionId = 1, WindowClass = "CASCADIA_HOSTING_WINDOW_CLASS"
            };
        }
        public static WindowIdentity Target() {
            return new WindowIdentity {
                Handle = 202, ProcessId = 2002, StartTicks = 639200000000000001L,
                ExecutablePath = Root + @"\app\ChatGPT.exe", UserSid = "S-1-5-21-1-2-3-1001",
                SessionId = 1, WindowClass = "Chrome_WidgetWin_1", PackageFullName = FullName,
                PackageFamilyName = Family, PackageRoot = Root
            };
        }
        public static void Result(NavigationResult result, string status, bool dispatched, bool foreground) {
            Assert(result != null && result.Status == status && result.Dispatched == dispatched && result.Foreground == foreground,
                "Unexpected result; expected " + status + ", dispatched=" + dispatched + ", foreground=" + foreground + ".");
        }
        public static void NoDispatch(FakeOps ops) {
            Assert(ops.Count("dispatch") == 0 && !ops.TouchedWindow, "Rejected input or identity changed an application.");
        }
        public static void AssertThrows(Action action, string message) {
            bool threw = false;
            try { action(); } catch (ArgumentException) { threw = true; } catch (InvalidOperationException) { threw = true; }
            Assert(threw, message);
        }
    }

    public static class EntryPoint {
        private static int passed;
        private static void Test(string name, Action action) {
            action(); passed++; Console.WriteLine("PASS " + name);
        }

        private static void Inputs() {
            string[][] invalid = {
                new[] { "", "local" }, new[] { (string)null, "local" },
                new[] { Fixtures.ThreadId, "" }, new[] { Fixtures.ThreadId, (string)null },
                new[] { Fixtures.ThreadId, "LOCAL" }, new[] { Fixtures.ThreadId, "remote" },
                new[] { Fixtures.ThreadId, "durable " }, new[] { Fixtures.ThreadId, "local&threadAccess=shared" },
                new[] { "00000000-0000-0000-0000-000000000000", "local" },
                new[] { " " + Fixtures.ThreadId, "local" }, new[] { Fixtures.ThreadId + "\n", "local" },
                new[] { Fixtures.ThreadId + "?hostId=durable", "local" },
                new[] { "codex://threads/" + Fixtures.ThreadId, "local" }, new[] { @"C:\other.exe", "local" }
            };
            foreach (string[] pair in invalid) {
                var ops = new FakeOps();
                Fixtures.Assert(Navigation.BuildUri(pair[0], pair[1]) == null, "Malformed target produced a URI.");
                Fixtures.Result(Navigation.Run(pair[0], pair[1], ops), "InvalidContext", false, false);
                Fixtures.Assert(ops.Calls.Count == 0, "Malformed input reached the operations boundary.");
            }
            foreach (string host in new[] { "local", "durable" }) {
                Fixtures.Assert(Navigation.BuildUri(Fixtures.ThreadId.ToUpperInvariant(), host) ==
                    "codex://threads/" + Fixtures.ThreadId + "?hostId=" + host, "URI is not canonical or exact.");
            }
        }

        private static void PackageIdentity() {
            Fixtures.Assert(Navigation.ValidPackageIdentity(Fixtures.Target()), "Valid package identity rejected.");
            foreach (Action<WindowIdentity> mutate in new Action<WindowIdentity>[] {
                value => value.PackageFamilyName = "Other.Codex_2p2nqsd0c76g0",
                value => value.PackageFamilyName = "OpenAI.Codex_untrusted",
                value => value.PackageFamilyName = null,
                value => value.PackageFullName = null,
                value => value.PackageFullName = "Other.Codex_26.1000.1.0_x64__2p2nqsd0c76g0",
                value => value.PackageRoot = null,
                value => value.PackageRoot = @"relative\package",
                value => value.ExecutablePath = Fixtures.Root + @"\app\Child\ChatGPT.exe",
                value => value.ExecutablePath = Fixtures.Root + @"\app\ChatGPT.exe.backup",
                value => value.ExecutablePath = Fixtures.Root + @"-other\app\ChatGPT.exe",
                value => value.ExecutablePath = Fixtures.Root + @"\app\codex.exe",
                value => value.ExecutablePath = @"C:\Unpackaged\ChatGPT.exe"
            }) {
                var target = Fixtures.Target(); mutate(target);
                Fixtures.Assert(!Navigation.ValidPackageIdentity(target), "Untrusted package or non-exact executable accepted.");
            }
            var next = Fixtures.Target();
            next.PackageFullName = "OpenAI.Codex_99.1.2.3_arm64__2p2nqsd0c76g0";
            next.PackageRoot = @"D:\Apps\" + next.PackageFullName;
            next.ExecutablePath = next.PackageRoot + @"\app\ChatGPT.exe";
            Fixtures.Assert(Navigation.ValidPackageIdentity(next), "Validation must not pin an app version, architecture, or drive.");
            var casing = Fixtures.Target(); casing.ExecutablePath = casing.ExecutablePath.ToUpperInvariant();
            Fixtures.Assert(Navigation.ValidPackageIdentity(casing), "Windows path case differences must not select a different executable.");
        }

        private static void IdentityComparison() {
            Fixtures.Assert(!Navigation.SameIdentity(null, Fixtures.Target()) && !Navigation.SameIdentity(Fixtures.Target(), null), "Null identity matched.");
            Fixtures.Assert(Navigation.SameIdentity(Fixtures.Target(), Fixtures.Target()), "Identical values did not match.");
            foreach (Action<WindowIdentity> mutate in new Action<WindowIdentity>[] {
                value => value.Handle++, value => value.ProcessId++, value => value.StartTicks++,
                value => value.SessionId++, value => value.UserSid += "0", value => value.WindowClass += "Other",
                value => value.ExecutablePath = @"C:\Other\ChatGPT.exe",
                value => value.PackageFullName = "OpenAI.Codex_99.1.2.3_x64__2p2nqsd0c76g0",
                value => value.PackageFamilyName = "Other_2p2nqsd0c76g0", value => value.PackageRoot += "Other"
            }) {
                var actual = Fixtures.Target(); mutate(actual);
                Fixtures.Assert(!Navigation.SameIdentity(Fixtures.Target(), actual), "Changed HWND/process incarnation or package identity matched.");
            }
            var casing = Fixtures.Target(); casing.ExecutablePath = casing.ExecutablePath.ToUpperInvariant();
            Fixtures.Assert(Navigation.SameIdentity(Fixtures.Target(), casing), "Equivalent Windows executable casing did not match.");
            Fixtures.Assert(Navigation.ValidIdentity(Fixtures.Source(), true), "Valid terminal source rejected.");
            foreach (string executable in new[] { @"C:\Windows\System32\conhost.exe", @"C:\Terminal\OpenConsole.exe" }) {
                var source = Fixtures.Source(); source.ExecutablePath = executable; source.WindowClass = "ConsoleWindowClass";
                Fixtures.Assert(Navigation.ValidIdentity(source, true), "Supported console source rejected.");
            }
            var wrongSource = Fixtures.Source(); wrongSource.WindowClass = "Chrome_WidgetWin_1";
            Fixtures.Assert(!Navigation.ValidIdentity(wrongSource, true), "Non-terminal source accepted.");
        }

        private static void CaptureRejections() {
            foreach (string kind in new[] { "no-source", "no-target", "ambiguous", "source-changed", "wrong-user", "wrong-session", "wrong-package" }) {
                var ops = new FakeOps(); string expected;
                switch (kind) {
                    case "no-source": ops.Source = null; expected = "SourceUnavailable"; break;
                    case "no-target": ops.Targets = new WindowIdentity[0]; expected = "DesktopUnavailable"; break;
                    case "ambiguous": ops.Targets = new[] { ops.Target, Fixtures.Target() }; expected = "Ambiguous"; break;
                    case "source-changed": ops.SourceForeground = false; expected = "SourceUnavailable"; break;
                    case "wrong-user": ops.Target.UserSid = "S-1-5-21-1-2-3-9999"; expected = "DesktopUnavailable"; break;
                    case "wrong-session": ops.Target.SessionId = 2; expected = "DesktopUnavailable"; break;
                    default: ops.Target.PackageFamilyName = "Untrusted_2p2nqsd0c76g0"; expected = "DesktopUnavailable"; break;
                }
                Fixtures.Result(Navigation.Run(Fixtures.ThreadId, "local", ops), expected, false, false);
                Fixtures.NoDispatch(ops);
            }
        }

        private static void DispatchAndReadback() {
            foreach (string host in new[] { "local", "durable" }) {
                var ops = new FakeOps(); ops.DefaultCheck = "Foreground";
                Fixtures.Result(Navigation.Run(Fixtures.ThreadId.ToUpperInvariant(), host, ops), "Foreground", true, true);
                Fixtures.Assert(ops.Count("dispatch") == 1 && ops.Count("check") == 1 && !ops.TouchedWindow && ops.Count("delay") == 0,
                    "Immediate foreground must not repeat dispatch or change a window.");
                Fixtures.Assert(Object.ReferenceEquals(ops.DispatchedSource, ops.Source) && Object.ReferenceEquals(ops.DispatchedTarget, ops.Target),
                    "Dispatch lost the verified source or target identity.");
                Fixtures.Assert(ops.DispatchUri == Navigation.BuildUri(Fixtures.ThreadId, host), "Dispatch changed the bound thread or host.");
            }
            foreach (string status in new[] { "SourceChanged", "InvalidContext", "DispatchFailed" }) {
                var ops = new FakeOps(); ops.DispatchResult = status;
                Fixtures.Result(Navigation.Run(Fixtures.ThreadId, "local", ops), status, false, false);
                Fixtures.Assert(ops.Count("dispatch") == 1 && ops.Count("check") == 0 && !ops.TouchedWindow, "Rejected dispatch was retried or activated.");
            }
            foreach (string status in new[] { "SourceChanged", "InvalidContext" }) {
                var ops = new FakeOps(); ops.DefaultCheck = status;
                Fixtures.Result(Navigation.Run(Fixtures.ThreadId, "durable", ops), status, true, false);
                Fixtures.Assert(!ops.TouchedWindow && ops.Count("delay") == 0, "Changed source/target was mutated after dispatch.");
            }
            var switched = new FakeOps(); switched.RestoreResult = "SourceChanged";
            Fixtures.Result(Navigation.Run(Fixtures.ThreadId, "local", switched), "SourceChanged", true, false);
            Fixtures.Assert(switched.Count("activate") == 0, "Source switch before restore still activated the target.");
            var stale = new FakeOps(); stale.ActivateResult = "InvalidContext";
            Fixtures.Result(Navigation.Run(Fixtures.ThreadId, "local", stale), "InvalidContext", true, false);
            Fixtures.Assert(stale.Count("delay") == 0, "Stale activation target was polled.");
            var delayed = new FakeOps(); delayed.Checks.Enqueue("Ready"); delayed.Checks.Enqueue("Ready"); delayed.Checks.Enqueue("Foreground");
            Fixtures.Result(Navigation.Run(Fixtures.ThreadId, "local", delayed), "Foreground", true, true);
            Fixtures.Assert(delayed.Count("dispatch") == 1 && delayed.Count("restore") == 1 && delayed.Count("activate") == 1,
                "Readback repeated a dispatch or window mutation.");
            var denied = new FakeOps();
            Fixtures.Result(Navigation.Run(Fixtures.ThreadId, "local", denied), "NotForeground", true, false);
            Fixtures.Assert(denied.Count("delay") == 20 && denied.Count("activate") == 1 && denied.Count("dispatch") == 1,
                "Unconfirmed foreground must be bounded and never dispatch again.");
        }

        private static void ExpiryAndExceptions() {
            var expired = new FakeOps(); expired.DispatchElapsed = 60001;
            Fixtures.Result(Navigation.Run(Fixtures.ThreadId, "local", expired), "InvalidContext", true, false);
            Fixtures.Assert(expired.Count("check") == 0 && !expired.TouchedWindow, "Expired capture performed a foreground operation.");
            foreach (string step in new[] { "source", "targets", "source-check", "dispatch", "check", "restore", "activate", "delay" }) {
                var ops = new FakeOps(); ops.ThrowAt = step;
                bool dispatched = step == "check" || step == "restore" || step == "activate" || step == "delay";
                Fixtures.Result(Navigation.Run(Fixtures.ThreadId, "local", ops), "InvalidContext", dispatched, false);
                Fixtures.Assert(ops.Count("dispatch") <= 1 && ops.Count("activate") <= 1, "Exception caused a replay.");
            }
        }

        private static void StartInfo() {
            string[] keys = { "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_ELECTRON_AGENT_RUN_ID", "CODEX_DESKTOP_RELAUNCH_OPEN_EVENTS",
                "CODEX_APP_SERVER_WS_URL", "CODEX_FUTURE_OVERRIDE", "codex_lowercase_override", "CST_BRIDGE_TOKEN", "cst_other_override",
                "BUILD_FLAVOR", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "CST_FIXTURE_WINDOWS_ENV" };
            var saved = new Dictionary<string, string>();
            foreach (string key in keys) { saved[key] = Environment.GetEnvironmentVariable(key); Environment.SetEnvironmentVariable(key, "fixture"); }
            string systemRoot = Environment.GetEnvironmentVariable("SystemRoot");
            try {
                foreach (string host in new[] { "local", "durable" }) {
                    string uri = Navigation.BuildUri(Fixtures.ThreadId, host);
                    ProcessStartInfo info = Navigation.CreateStartInfo(Fixtures.Target(), uri);
                    Fixtures.Assert(info.FileName == Fixtures.Target().ExecutablePath && !info.UseShellExecute && info.CreateNoWindow &&
                        info.WindowStyle == ProcessWindowStyle.Hidden, "Process launch must target the verified executable without shell dispatch.");
                    // Chromium consumes the raw tail after this switch, including
                    // literal quotes. Ordinary Windows argv equivalence is not
                    // enough: quoting this URI makes Desktop reject the link.
                    Fixtures.Assert(info.Arguments == "--single-argument " + uri,
                        "Chromium's raw single argument must be the exact URI without wrapping quotes.");
                    foreach (string key in info.EnvironmentVariables.Keys) {
                        Fixtures.Assert(!key.StartsWith("CODEX_", StringComparison.OrdinalIgnoreCase) && !key.StartsWith("CST_", StringComparison.OrdinalIgnoreCase) &&
                            !key.Equals("BUILD_FLAVOR", StringComparison.OrdinalIgnoreCase) && !key.Equals("ELECTRON_RUN_AS_NODE", StringComparison.OrdinalIgnoreCase) &&
                            !key.Equals("NODE_OPTIONS", StringComparison.OrdinalIgnoreCase), "Profile/transport/startup override leaked to Desktop.");
                    }
                    Fixtures.Assert(info.EnvironmentVariables["SystemRoot"] == systemRoot, "Standard Windows environment changed.");
                }
            } finally { foreach (KeyValuePair<string, string> item in saved) Environment.SetEnvironmentVariable(item.Key, item.Value); }
            foreach (string uri in new[] { "https://example.com", "codex://threads/" + Fixtures.ThreadId + "?hostId=remote",
                "codex://threads/" + Fixtures.ThreadId + "?hostId=local&threadAccess=shared",
                "codex://threads/" + Fixtures.ThreadId + "?hostId=local\n" }) {
                string captured = uri;
                Fixtures.AssertThrows(() => Navigation.CreateStartInfo(Fixtures.Target(), captured), "Unvalidated launch URI accepted.");
            }
        }

        private static void ProgramBoundary() {
            var check = new FakeOps();
            string json = Program.Execute(new[] { "--check" }, check);
            Fixtures.Assert(Regex.IsMatch(json, "\"version\"\\s*:\\s*1") && Regex.IsMatch(json, "\"ready\"\\s*:\\s*true") && check.Calls.Count == 0,
                "--check must report the helper protocol without native inspection or dispatch.");
            foreach (string[] argv in new[] { new string[0], new[] { "--unknown" }, new[] { "--check", "unexpected" },
                new[] { "--thread", Fixtures.ThreadId }, new[] { "--thread", Fixtures.ThreadId, "--host", "local", "extra" },
                new[] { "--host", "local", "--thread", Fixtures.ThreadId }, new[] { "--thread-id", Fixtures.ThreadId, "--host-id", "local" } }) {
                var ops = new FakeOps();
                string response = Program.Execute(argv, ops);
                Fixtures.Assert(response.Contains("InvalidContext") && ops.Calls.Count == 0, "Malformed helper argv reached operations.");
                Fixtures.Assert(!response.Contains("navigated") && !response.Contains("pageReady"), "Helper must not manufacture page navigation receipt.");
            }
            var normal = new FakeOps(); normal.DefaultCheck = "Foreground";
            string accepted = Program.Execute(new[] { "--thread", Fixtures.ThreadId, "--host", "durable" }, normal);
            Fixtures.Assert(accepted.Contains("Foreground") && Regex.IsMatch(accepted, "\"dispatched\"\\s*:\\s*true") &&
                Regex.IsMatch(accepted, "\"foreground\"\\s*:\\s*true") && normal.Count("dispatch") == 1,
                "Fixed helper arguments did not reach a single bound dispatch.");
        }

        public static int Main(string[] args) {
            try {
                Test("URI validation before operations", Inputs);
                Test("OS package and exact executable identity", PackageIdentity);
                Test("window and process incarnation identity", IdentityComparison);
                Test("capture rejection without side effects", CaptureRejections);
                Test("single dispatch and observed foreground", DispatchAndReadback);
                Test("expiry and exceptions preserve dispatch state", ExpiryAndExceptions);
                Test("fixed argv and clean child environment", StartInfo);
                Test("program boundary and inert readiness check", ProgramBoundary);
                Console.WriteLine("Desktop navigation fixture groups passed: " + passed.ToString(CultureInfo.InvariantCulture));
                return 0;
            } catch (Exception error) {
                Console.Error.WriteLine("FAIL " + error.Message);
                return 1;
            }
        }
    }
}
