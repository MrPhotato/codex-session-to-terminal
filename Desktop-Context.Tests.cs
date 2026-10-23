using System;
using CstDesktopNavigation;

namespace CstDesktopContext.Tests
{
    public sealed class FixtureBackButton : IBackButton
    {
        public int Invocations;
        public bool Available = true;
        public bool ThrowOnInvoke;
        public bool CanInvoke() { return Available; }
        public void Invoke() { Invocations++; if (ThrowOnInvoke) throw new InvalidOperationException("fixture invoke"); }
    }

    public sealed class FixtureOps : IBackOps
    {
        public int IdentityReads;
        public int DocumentReads;
        public int InputReads;
        public int BackReads;
        public bool Throw;
        public Func<int, WindowIdentity> Identity = delegate { return Fixtures.Identity(); };
        public Func<int, DocumentSnapshot[]> Documents = delegate { return new[] { Fixtures.Document() }; };
        public Func<int, uint?> InputTick = delegate { return 1234u; };
        public readonly FixtureBackButton BackButton = new FixtureBackButton();
        public Func<IBackButton[]> BackButtons;
        public IBackButton[] FindBackButtons(long window)
        {
            BackReads++;
            return BackButtons == null ? new IBackButton[] { BackButton } : BackButtons();
        }
        public uint? ReadLastInputTick()
        {
            InputReads++;
            if (Throw) throw new InvalidOperationException("fixture");
            return InputTick(InputReads);
        }
        public WindowIdentity InspectTarget(long window)
        {
            IdentityReads++;
            if (Throw) throw new InvalidOperationException("fixture");
            return Identity(IdentityReads);
        }
        public DocumentSnapshot[] ReadDocuments(long window)
        {
            DocumentReads++;
            if (Throw) throw new InvalidOperationException("fixture");
            return Documents(DocumentReads);
        }
    }

    public static class Fixtures
    {
        public static readonly string[] Arguments = { "--pid", "123", "--window", "456", "--started", "638000000000000000" };
        public static ContextRequest Request() { return ContextRequest.Parse(Arguments); }
        public static WindowIdentity Identity()
        {
            const string root = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1.2.3_x64__2p2nqsd0c76g0";
            return new WindowIdentity {
                Handle = 456, ProcessId = 123, StartTicks = 638000000000000000,
                ExecutablePath = root + "\\app\\ChatGPT.exe", UserSid = "S-1-5-21-1-2-3-1001", SessionId = 1,
                WindowClass = "Chrome_WidgetWin_1", PackageRoot = root,
                PackageFamilyName = Navigation.OfficialPackageFamily,
                PackageFullName = "OpenAI.Codex_26.1.2.3_x64__2p2nqsd0c76g0"
            };
        }
        public static DocumentSnapshot Document()
        {
            return new DocumentSnapshot { Title = "云端连接测试 | 工作区", Url = ContextReader.MainDocumentUrl, RuntimeId = new[] { 42, -7, 123 } };
        }
        private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }

        public static void InputAndInertCheck()
        {
            Check(Request() != null, "valid argv rejected");
            var ops = new FixtureOps { Throw = true };
            Check(Program.Execute(new[] { "--check" }, ops) == "{\"version\":1,\"ready\":true}", "check output changed");
            Check(ops.IdentityReads == 0 && ops.DocumentReads == 0 && ops.InputReads == 0, "check accessed native seam");
            string[] rejected = { "", "0", "01", "+1", "-1", " 1", "1 ", "1\n", "1.0", "1e2", "١", "99999999999999999999" };
            foreach (int position in new[] { 1, 3, 5 })
                foreach (string value in rejected)
                {
                    string[] args = (string[])Arguments.Clone(); args[position] = value;
                    Check(ContextRequest.Parse(args) == null, "non-canonical number accepted");
                    Check(Program.Execute(args, ops).Contains("\"status\":\"unavailable\""), "invalid input did not fail closed");
                }
            foreach (string[] args in new[] {
                new[] { "--pid", "2147483648", "--window", "456", "--started", "638000000000000000" },
                new[] { "--pid", "123", "--window", "9223372036854775808", "--started", "638000000000000000" },
                new[] { "--pid", "123", "--window", "456", "--started", "3155378976000000000" },
                new[] { "--check", "--pid", "123" },
                new[] { "--window", "456", "--pid", "123", "--started", "638000000000000000" }
            }) Check(ContextRequest.Parse(args) == null, "malformed argv accepted");
            Check(ContextRequest.Parse(null) == null && ContextRequest.Parse(new string[0]) == null, "missing argv accepted");
            Check(ops.IdentityReads == 0 && ops.DocumentReads == 0 && ops.InputReads == 0, "invalid input accessed native seam");
        }

        public static void StableIdentityAndDocument()
        {
            var ops = new FixtureOps();
            ContextResult result = ContextReader.Read(Request(), ops);
            Check(result.Status == "ready" && result.Title == Document().Title && result.DocumentRuntimeId == "42,-7,123", "stable result was lost");
            Check(result.ProcessId == 123 && result.Window == 456 && result.Started == 638000000000000000, "request identity was changed");
            Check(ops.IdentityReads == 3 && ops.DocumentReads == 2, "identity/document readback was skipped");
            Check(ops.InputReads == 2 && result.LastInputTick == 1234u, "stable input timestamp was not sampled on both sides");
            Check(result.ToJson().Contains("\"started\":\"638000000000000000\""), "ticks were serialized as an imprecise number");
            foreach (int changeAt in new[] { 1, 2, 3 })
            {
                int selected = changeAt;
                foreach (string field in new[] { "pid", "window", "started", "sid", "session", "path", "package", "family", "class" })
                {
                    string selectedField = field;
                    ops = new FixtureOps { Identity = delegate(int call) {
                        WindowIdentity item = Identity();
                        if (call != selected) return item;
                        switch (selectedField) {
                            case "pid": item.ProcessId++; break;
                            case "window": item.Handle++; break;
                            case "started": item.StartTicks++; break;
                            case "sid": item.UserSid = "S-1-5-21-1-2-3-1002"; break;
                            case "session": item.SessionId++; break;
                            case "path": item.ExecutablePath = "C:\\untrusted\\ChatGPT.exe"; break;
                            case "package": item.PackageFullName = "OpenAI.Codex_27.1.2.3_x64__2p2nqsd0c76g0"; break;
                            case "family": item.PackageFamilyName = "other"; break;
                            case "class": item.WindowClass = "Other"; break;
                        }
                        return item;
                    } };
                    result = ContextReader.Read(Request(), ops);
                    // Identity fields unrelated to explicit argv may establish
                    // the baseline, but any later change must be rejected.
                    if (selected == 1 && (field == "sid" || field == "session" || field == "package" || field == "class"))
                        Check(result.Status == "unavailable", "changed baseline was not caught by readback");
                    else Check(result.Status == "unavailable", "process/package identity drift was accepted");
                    Check(result.Title == "" && result.DocumentRuntimeId == "", "unavailable result leaked document metadata");
                }
            }
        }

        public static void RejectAmbiguityAndTitleDrift()
        {
            foreach (string invalid in new[] { "missing", "multiple", "url", "empty", "long", "control", "runtimeShort", "runtimeLong" })
            {
                string selected = invalid;
                var ops = new FixtureOps { Documents = delegate {
                    DocumentSnapshot item = Document();
                    switch (selected) {
                        case "missing": return new DocumentSnapshot[0];
                        case "multiple": return new[] { item, Document() };
                        case "url": item.Url += "?other"; break;
                        case "empty": item.Title = ""; break;
                        case "long": item.Title = new string('x', 513); break;
                        case "control": item.Title = "private\nbody"; break;
                        case "runtimeShort": item.RuntimeId = new[] { 1 }; break;
                        case "runtimeLong": item.RuntimeId = new int[33]; break;
                    }
                    return new[] { item };
                } };
                Check(ContextReader.Read(Request(), ops).Status == "unavailable", "invalid document accepted");
            }
            foreach (string change in new[] { "title", "runtime", "url", "count" })
            {
                string selected = change;
                var ops = new FixtureOps { Documents = delegate(int call) {
                    DocumentSnapshot item = Document();
                    if (call == 2) {
                        if (selected == "title") item.Title += " ";
                        if (selected == "runtime") item.RuntimeId[2]++;
                        if (selected == "url") item.Url = "https://example.invalid";
                        if (selected == "count") return new[] { item, Document() };
                    }
                    return new[] { item };
                } };
                Check(ContextReader.Read(Request(), ops).Status == "unavailable", "document drift accepted");
            }
            var exceptional = new FixtureOps { Throw = true };
            Check(ContextReader.Read(Request(), exceptional).Status == "unavailable", "native exception escaped");
        }

        public static void ExactTitleAndJson()
        {
            var ops = new FixtureOps { Documents = delegate {
                DocumentSnapshot item = Document(); item.Title = "  ChatGPT | \"项目\" \\ 😀  "; return new[] { item };
            } };
            ContextResult result = ContextReader.Read(Request(), ops);
            Check(result.Status == "ready" && result.Title == "  ChatGPT | \"项目\" \\ 😀  ", "raw title was normalized or generic title rejected prematurely");
            string json = result.ToJson();
            Check(json.Contains("\\\"项目\\\"") && json.Contains("\\\\") && json.Contains("\\ud83d\\ude00"), "JSON escaping changed exact text");
            ops.Documents = delegate { DocumentSnapshot item = Document(); item.Title = new string('x', 512); return new[] { item }; };
            Check(ContextReader.Read(Request(), ops).Status == "ready", "maximum allowed title rejected");
        }

        public static void InputActivityAndUnknownTick()
        {
            foreach (uint tick in new[] { 0u, 1u, UInt32.MaxValue })
            {
                uint selected = tick;
                var ops = new FixtureOps { InputTick = delegate { return selected; } };
                ContextResult result = ContextReader.Read(Request(), ops);
                Check(result.Status == "ready" && result.LastInputTick == selected, "valid uint input epoch rejected");
                Check(result.ToJson().Contains("\"lastInputTick\":" + selected), "input tick serialized incorrectly");
            }
            foreach (Func<int, uint?> tick in new Func<int, uint?>[] {
                delegate { return null; },
                delegate(int call) { return call == 1 ? (uint?)1234u : null; },
                delegate(int call) { return call == 1 ? 1234u : 1235u; },
                delegate(int call) { return call == 1 ? UInt32.MaxValue : 0u; }
            }) {
                var ops = new FixtureOps { InputTick = tick };
                ContextResult result = ContextReader.Read(Request(), ops);
                Check(result.Status == "unavailable" && !result.LastInputTick.HasValue, "new input or unavailable epoch accepted");
                Check(result.Title == "" && result.DocumentRuntimeId == "", "unstable input leaked page context");
                Check(result.ToJson().Contains("\"lastInputTick\":null"), "unknown input epoch was invented");
            }
        }

        public static string[] BackArguments()
        {
            return new[] { "--back", "--pid", "123", "--window", "456", "--started", "638000000000000000", "--input-tick", "1234", "--document", "42,-7,123", "--title", Document().Title };
        }

        public static void GuardedBackOnce()
        {
            var ops = new FixtureOps();
            BackResult result = BackNavigator.Run(BackRequest.Parse(BackArguments()), ops);
            Check(result.Dispatched && result.Status == "dispatched" && ops.BackButton.Invocations == 1, "one-shot back was not dispatched once");
            Check(ops.IdentityReads == 6 && ops.DocumentReads == 4 && ops.InputReads == 5 && ops.BackReads == 1, "back context checks were skipped");
            foreach (string change in new[] { "title", "document", "pid", "input", "late-input" }) {
                string selected = change;
                ops = new FixtureOps();
                if (selected == "title" || selected == "document") ops.Documents = delegate(int call) {
                    var doc = Document();
                    if (call >= 3) { if (selected == "title") doc.Title += " changed"; else doc.RuntimeId[1]++; }
                    return new[] { doc };
                };
                if (selected == "pid") ops.Identity = delegate(int call) { var item = Identity(); if (call >= 4) item.ProcessId++; return item; };
                if (selected == "input" || selected == "late-input") ops.InputTick = delegate(int call) { return call >= (selected == "input" ? 3 : 5) ? 1235u : 1234u; };
                result = BackNavigator.Run(BackRequest.Parse(BackArguments()), ops);
                Check(!result.Dispatched && result.Status == "context-changed" && ops.BackButton.Invocations == 0, "back ignored page/identity/input drift");
            }
            foreach (int count in new[] { 0, 2 }) {
                int selected = count; ops = new FixtureOps();
                ops.BackButtons = delegate { return selected == 0 ? new IBackButton[0] : new IBackButton[] { new FixtureBackButton(), new FixtureBackButton() }; };
                result = BackNavigator.Run(BackRequest.Parse(BackArguments()), ops);
                Check(!result.Dispatched && result.Status == "back-unavailable" && ops.BackButton.Invocations == 0, "missing/ambiguous back was invoked");
            }
            ops = new FixtureOps(); ops.BackButton.Available = false;
            result = BackNavigator.Run(BackRequest.Parse(BackArguments()), ops);
            Check(!result.Dispatched && result.Status == "back-unavailable" && ops.BackButton.Invocations == 0, "disabled back was invoked");
            ops = new FixtureOps(); ops.BackButton.ThrowOnInvoke = true;
            result = BackNavigator.Run(BackRequest.Parse(BackArguments()), ops);
            Check(!result.Dispatched && result.Status == "outcome-unknown" && ops.BackButton.Invocations == 1, "uncertain back was retried or claimed successful");
        }

        public static void BackInputValidation()
        {
            foreach (uint tick in new[] { 0u, UInt32.MaxValue }) {
                string[] args = BackArguments(); args[8] = tick.ToString(System.Globalization.CultureInfo.InvariantCulture);
                Check(BackRequest.Parse(args).LastInputTick == tick, "valid back uint rejected");
            }
            foreach (string value in new[] { "", "-1", "+1", "01", "4294967296", "1.0", "1e2", " 1" }) {
                string[] args = BackArguments(); args[8] = value;
                var ops = new FixtureOps { Throw = true };
                Check(Program.Execute(args, ops).Contains("\"status\":\"invalid-context\""), "invalid tick admitted");
                Check(ops.InputReads == 0 && ops.IdentityReads == 0 && ops.BackReads == 0, "invalid back input inspected UI");
            }
            foreach (string value in new[] { "1", "1,+2", "1,02", "1,-0", "1,2147483648", "1,2\n" }) {
                string[] args = BackArguments(); args[10] = value;
                Check(BackRequest.Parse(args) == null, "invalid back runtime ID admitted");
            }
            foreach (string value in new[] { "", "private\nbody", new string('x', 513) }) {
                string[] args = BackArguments(); args[12] = value;
                Check(BackRequest.Parse(args) == null, "invalid back title admitted");
            }
            Check(BackRequest.Parse(null) == null && BackRequest.Parse(Arguments) == null, "missing back arguments admitted");
        }
    }

    public static class EntryPoint
    {
        public static int Main()
        {
            try {
                Fixtures.InputAndInertCheck(); Console.WriteLine("PASS strict argv and inert check");
                Fixtures.StableIdentityAndDocument(); Console.WriteLine("PASS immutable process/package and stable document");
                Fixtures.RejectAmbiguityAndTitleDrift(); Console.WriteLine("PASS ambiguous, invalid, drifting and unavailable document rejection");
                Fixtures.ExactTitleAndJson(); Console.WriteLine("PASS exact raw title and UTF-8 JSON contract");
                Fixtures.InputActivityAndUnknownTick(); Console.WriteLine("PASS stable uint input epoch and input-change rejection");
                Fixtures.GuardedBackOnce(); Console.WriteLine("PASS guarded one-shot Back and page/input/identity drift rejection");
                Fixtures.BackInputValidation(); Console.WriteLine("PASS strict Back input without UI access");
                return 0;
            } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
    }
}
