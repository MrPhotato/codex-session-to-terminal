using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
using CstDesktopNavigation;

namespace CstDesktopContext
{
    public sealed class ContextRequest
    {
        public int ProcessId;
        public long Window;
        public long Started;

        private static bool PositiveDecimal(string text, long maximum, out long value)
        {
            value = 0;
            if (String.IsNullOrEmpty(text) || text.Length > 19 || text[0] < '1' || text[0] > '9') return false;
            foreach (char item in text) if (item < '0' || item > '9') return false;
            return Int64.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value) && value > 0 && value <= maximum;
        }

        public static ContextRequest Parse(string[] args)
        {
            if (args == null || args.Length != 6 || args[0] != "--pid" || args[2] != "--window" || args[4] != "--started") return null;
            long pid, window, started;
            if (!PositiveDecimal(args[1], Int32.MaxValue, out pid) || !PositiveDecimal(args[3], Int64.MaxValue, out window) ||
                !PositiveDecimal(args[5], DateTime.MaxValue.Ticks, out started)) return null;
            return new ContextRequest { ProcessId = (int)pid, Window = window, Started = started };
        }
    }

    public sealed class DocumentSnapshot
    {
        public string Title;
        public string Url;
        public int[] RuntimeId;
    }

    public interface IContextOps
    {
        WindowIdentity InspectTarget(long window);
        DocumentSnapshot[] ReadDocuments(long window);
        uint? ReadLastInputTick();
    }

    public interface IBackButton
    {
        bool CanInvoke();
        void Invoke();
    }

    public interface IBackOps : IContextOps
    {
        IBackButton[] FindBackButtons(long window);
    }

    public sealed class BackRequest
    {
        public ContextRequest Identity;
        public uint LastInputTick;
        public string DocumentRuntimeId;
        public string Title;

        public static BackRequest Parse(string[] args)
        {
            if (args == null || args.Length != 13 || args[0] != "--back" || args[7] != "--input-tick" ||
                args[9] != "--document" || args[11] != "--title") return null;
            ContextRequest identity = ContextRequest.Parse(new[] { args[1], args[2], args[3], args[4], args[5], args[6] });
            uint tick;
            if (identity == null || !UInt32.TryParse(args[8], NumberStyles.None, CultureInfo.InvariantCulture, out tick) ||
                tick.ToString(CultureInfo.InvariantCulture) != args[8] || String.IsNullOrEmpty(args[10]) || args[10].Length > 384) return null;
            string[] parts = args[10].Split(',');
            if (parts.Length < 2 || parts.Length > 32) return null;
            var runtime = new int[parts.Length];
            for (int index = 0; index < parts.Length; index++)
                if (!Int32.TryParse(parts[index], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out runtime[index]) ||
                    runtime[index].ToString(CultureInfo.InvariantCulture) != parts[index]) return null;
            if (!ContextReader.ValidDocument(new DocumentSnapshot { Title = args[12], Url = ContextReader.MainDocumentUrl, RuntimeId = runtime })) return null;
            return new BackRequest { Identity = identity, LastInputTick = tick, DocumentRuntimeId = args[10], Title = args[12] };
        }
    }

    public sealed class BackResult
    {
        public string Status;
        public bool Dispatched;
        public BackResult(string status, bool dispatched = false) { Status = status; Dispatched = dispatched; }
        public string ToJson() { return "{\"version\":1,\"status\":\"" + Status + "\",\"dispatched\":" + (Dispatched ? "true" : "false") + "}"; }
    }

    public static class BackNavigator
    {
        private static bool Matches(BackRequest request, ContextResult actual)
        {
            return actual.Status == "ready" && actual.ProcessId == request.Identity.ProcessId && actual.Window == request.Identity.Window &&
                actual.Started == request.Identity.Started && actual.LastInputTick == request.LastInputTick &&
                actual.Title == request.Title && actual.DocumentRuntimeId == request.DocumentRuntimeId;
        }

        public static BackResult Run(BackRequest request, IBackOps ops)
        {
            if (request == null) return new BackResult("invalid-context");
            bool attempted = false;
            try {
                if (ops == null) ops = new NativeContextOps();
                if (!Matches(request, ContextReader.Read(request.Identity, ops))) return new BackResult("context-changed");
                IBackButton[] buttons = ops.FindBackButtons(request.Identity.Window);
                if (buttons == null || buttons.Length != 1 || buttons[0] == null) return new BackResult("back-unavailable");
                // The UIA element is scoped to this HWND. Re-read the whole
                // context after discovery and validate the element once more.
                if (!Matches(request, ContextReader.Read(request.Identity, ops))) return new BackResult("context-changed");
                if (!buttons[0].CanInvoke()) return new BackResult("back-unavailable");
                uint? tick = ops.ReadLastInputTick();
                if (!tick.HasValue || tick.Value != request.LastInputTick) return new BackResult("context-changed");
                attempted = true;
                buttons[0].Invoke();
                return new BackResult("dispatched", true);
            } catch { return new BackResult(attempted ? "outcome-unknown" : "back-unavailable"); }
        }
    }

    public sealed class ContextResult
    {
        public string Status;
        public string Title;
        public string DocumentRuntimeId;
        public int ProcessId;
        public long Window;
        public long Started;
        public uint? LastInputTick;

        public static ContextResult Unavailable(ContextRequest request)
        {
            return new ContextResult {
                Status = "unavailable", Title = "", DocumentRuntimeId = "",
                ProcessId = request == null ? 0 : request.ProcessId,
                Window = request == null ? 0 : request.Window,
                Started = request == null ? 0 : request.Started
            };
        }

        private static string JsonString(string value)
        {
            var result = new StringBuilder("\"");
            foreach (char item in value ?? "")
            {
                if (item == '"' || item == '\\') { result.Append('\\'); result.Append(item); }
                else if (item < 0x20 || Char.IsSurrogate(item)) result.Append("\\u" + ((int)item).ToString("x4", CultureInfo.InvariantCulture));
                else result.Append(item);
            }
            return result.Append('"').ToString();
        }

        public string ToJson()
        {
            return "{\"version\":1,\"status\":" + JsonString(Status) + ",\"title\":" + JsonString(Title) +
                ",\"documentRuntimeId\":" + JsonString(DocumentRuntimeId) + ",\"pid\":" + ProcessId.ToString(CultureInfo.InvariantCulture) +
                ",\"window\":" + Window.ToString(CultureInfo.InvariantCulture) + ",\"started\":" +
                JsonString(Started.ToString(CultureInfo.InvariantCulture)) + ",\"lastInputTick\":" +
                (LastInputTick.HasValue ? LastInputTick.Value.ToString(CultureInfo.InvariantCulture) : "null") + "}";
        }
    }

    public static class ContextReader
    {
        public const string MainDocumentUrl = "app://-/index.html";

        public static bool ValidDocument(DocumentSnapshot document)
        {
            if (document == null || document.Url != MainDocumentUrl || String.IsNullOrEmpty(document.Title) || document.Title.Length > 512 ||
                document.RuntimeId == null || document.RuntimeId.Length < 2 || document.RuntimeId.Length > 32) return false;
            foreach (char item in document.Title) if (Char.IsControl(item)) return false;
            return true;
        }

        private static bool MatchesRequest(ContextRequest request, WindowIdentity identity)
        {
            return request != null && Navigation.ValidIdentity(identity, false) && identity.ProcessId == request.ProcessId &&
                identity.Handle == request.Window && identity.StartTicks == request.Started;
        }

        private static bool SameDocument(DocumentSnapshot first, DocumentSnapshot second)
        {
            if (!ValidDocument(first) || !ValidDocument(second) || first.Title != second.Title || first.RuntimeId.Length != second.RuntimeId.Length) return false;
            for (int index = 0; index < first.RuntimeId.Length; index++) if (first.RuntimeId[index] != second.RuntimeId[index]) return false;
            return true;
        }

        public static ContextResult Read(ContextRequest request, IContextOps ops)
        {
            ContextResult result = ContextResult.Unavailable(request);
            if (request == null) return result;
            try
            {
                if (ops == null) ops = new NativeContextOps();
                uint? inputBefore = ops.ReadLastInputTick();
                if (!inputBefore.HasValue) return result;
                WindowIdentity before = ops.InspectTarget(request.Window);
                if (!MatchesRequest(request, before)) return result;
                DocumentSnapshot[] first = ops.ReadDocuments(request.Window);
                if (first == null || first.Length != 1 || !ValidDocument(first[0])) return result;
                WindowIdentity between = ops.InspectTarget(request.Window);
                if (!MatchesRequest(request, between) || !Navigation.SameIdentity(before, between)) return result;
                DocumentSnapshot[] second = ops.ReadDocuments(request.Window);
                if (second == null || second.Length != 1 || !SameDocument(first[0], second[0])) return result;
                WindowIdentity after = ops.InspectTarget(request.Window);
                if (!MatchesRequest(request, after) || !Navigation.SameIdentity(before, after)) return result;
                uint? inputAfter = ops.ReadLastInputTick();
                // Reading a stable page must not require holding the mouse still.
                // Navigation/Back separately compare this final input epoch with
                // their saved epoch immediately before acting.
                if (!inputAfter.HasValue) return result;
                string[] id = new string[first[0].RuntimeId.Length];
                for (int index = 0; index < id.Length; index++) id[index] = first[0].RuntimeId[index].ToString(CultureInfo.InvariantCulture);
                result.Status = "ready";
                result.Title = first[0].Title;
                result.DocumentRuntimeId = String.Join(",", id);
                result.LastInputTick = inputAfter;
                return result;
            }
            catch { return result; }
        }
    }

    public static class Program
    {
        public static string Execute(string[] args, IContextOps ops)
        {
            if (args != null && args.Length == 1 && args[0] == "--check") return "{\"version\":1,\"ready\":true}";
            if (args != null && args.Length > 0 && args[0] == "--back") {
                if (ops != null && !(ops is IBackOps)) return new BackResult("back-unavailable").ToJson();
                return BackNavigator.Run(BackRequest.Parse(args), ops as IBackOps).ToJson();
            }
            return ContextReader.Read(ContextRequest.Parse(args), ops).ToJson();
        }

        [MTAThread]
        public static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine(Execute(args, null));
            return 0;
        }
    }

    internal sealed class NativeContextOps : IBackOps
    {
        private readonly CstDesktopNavigation.NativeOps identity = new CstDesktopNavigation.NativeOps();
        private const int MaximumNodes = 256;
        private const int MaximumDepth = 12;

        private sealed class PendingNode
        {
            public AutomationElement Element;
            public int Depth;
        }

        public WindowIdentity InspectTarget(long window) { return identity.InspectTarget(window); }

        [StructLayout(LayoutKind.Sequential)]
        private struct LastInputInfo { public uint Size; public uint Time; }
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetLastInputInfo(ref LastInputInfo info);

        public uint? ReadLastInputTick()
        {
            var info = new LastInputInfo { Size = (uint)Marshal.SizeOf(typeof(LastInputInfo)) };
            return GetLastInputInfo(ref info) ? (uint?)info.Time : null;
        }

        [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);

        private static System.Windows.Rect BackArea(long window, AutomationElement root)
        {
            System.Windows.Rect bounds = root.Current.BoundingRectangle;
            uint dpi = GetDpiForWindow(new IntPtr(window));
            if (bounds.IsEmpty || dpi < 48 || dpi > 960) return System.Windows.Rect.Empty;
            // Only the application chrome's first row, never the conversation
            // toolbar or sidebar content below it. Coordinates are DPI-scaled.
            double scale = dpi / 96.0;
            return new System.Windows.Rect(bounds.Left, bounds.Top, Math.Min(bounds.Width, 120 * scale), Math.Min(bounds.Height, 50 * scale));
        }

        private sealed class NativeBackButton : IBackButton
        {
            private readonly AutomationElement element;
            private readonly long window;
            public NativeBackButton(AutomationElement element, long window) { this.element = element; this.window = window; }
            public bool CanInvoke()
            {
                AutomationElement root = AutomationElement.FromHandle(new IntPtr(window));
                if (root == null) return false;
                System.Windows.Rect area = BackArea(window, root), bounds = element.Current.BoundingRectangle;
                object pattern;
                if (area.IsEmpty || bounds.IsEmpty || !area.Contains(bounds) || !element.Current.IsEnabled || element.Current.IsOffscreen ||
                    element.Current.ControlType != ControlType.Button || (element.Current.Name != "Back" && element.Current.Name != "返回") ||
                    !element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) return false;
                // Re-prove ancestry for this cached UIA element before invoking.
                AutomationElement parent = element;
                for (int depth = 0; parent != null && depth <= 20; depth++) {
                    if (Automation.Compare(parent, root)) return true;
                    parent = TreeWalker.RawViewWalker.GetParent(parent);
                }
                return false;
            }
            public void Invoke()
            {
                object pattern;
                if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw new InvalidOperationException("Back pattern unavailable.");
                ((InvokePattern)pattern).Invoke();
            }
        }

        public IBackButton[] FindBackButtons(long window)
        {
            AutomationElement root = AutomationElement.FromHandle(new IntPtr(window));
            if (root == null) return null;
            System.Windows.Rect area = BackArea(window, root);
            if (area.IsEmpty) return null;
            var found = new List<IBackButton>();
            var pending = new Stack<PendingNode>();
            pending.Push(new PendingNode { Element = root, Depth = 0 });
            int discovered = 1;
            TreeWalker walker = TreeWalker.RawViewWalker;
            while (pending.Count != 0) {
                PendingNode node = pending.Pop();
                System.Windows.Rect bounds = node.Element.Current.BoundingRectangle;
                if (bounds.IsEmpty || !area.IntersectsWith(bounds) || node.Element.Current.IsOffscreen) continue;
                ControlType type = node.Element.Current.ControlType;
                if (type == ControlType.Button) {
                    var button = new NativeBackButton(node.Element, window);
                    if (button.CanInvoke()) found.Add(button);
                    if (found.Count > 1) return found.ToArray();
                    continue;
                }
                // Text, editor and list content are not chrome containers.
                if (type == ControlType.Text || type == ControlType.Edit || type == ControlType.List || type == ControlType.Tree ||
                    type == ControlType.DataGrid || type == ControlType.MenuItem) continue;
                if (type == ControlType.Document && DocumentUrl(node.Element) != ContextReader.MainDocumentUrl) continue;
                AutomationElement child = walker.GetFirstChild(node.Element);
                if (child != null && node.Depth >= 20) return null;
                while (child != null) {
                    if (++discovered > MaximumNodes) return null;
                    pending.Push(new PendingNode { Element = child, Depth = node.Depth + 1 });
                    child = walker.GetNextSibling(child);
                }
            }
            return found.ToArray();
        }

        private static string DocumentUrl(AutomationElement element)
        {
            object value = element.GetCurrentPropertyValue(ValuePattern.ValueProperty, true);
            if (value is string && !String.IsNullOrEmpty((string)value)) return (string)value;
            // Some providers expose the document URL through LegacyIAccessible.
            // Unknown/unsupported property IDs fail closed; never read body text.
            // https://learn.microsoft.com/windows/win32/winauto/uiauto-control-pattern-propids
            AutomationProperty legacyValue = AutomationProperty.LookupById(30093);
            return legacyValue == null ? null : element.GetCurrentPropertyValue(legacyValue, true) as string;
        }

        public DocumentSnapshot[] ReadDocuments(long window)
        {
            AutomationElement root = AutomationElement.FromHandle(new IntPtr(window));
            if (root == null) return null;
            var documents = new List<DocumentSnapshot>();
            var pending = new Stack<PendingNode>();
            pending.Push(new PendingNode { Element = root, Depth = 0 });
            int discovered = 1;
            TreeWalker walker = TreeWalker.RawViewWalker;
            while (pending.Count != 0)
            {
                PendingNode node = pending.Pop();
                object type = node.Element.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty, true);
                if (Object.Equals(type, ControlType.Document))
                {
                    // Stop at each Document. Never descend into messages, forms,
                    // credentials, contenteditable fields, or any document body.
                    documents.Add(new DocumentSnapshot {
                        Title = node.Element.GetCurrentPropertyValue(AutomationElement.NameProperty, true) as string,
                        Url = DocumentUrl(node.Element), RuntimeId = node.Element.GetRuntimeId()
                    });
                    if (documents.Count > 1) return documents.ToArray();
                    continue;
                }
                AutomationElement child = walker.GetFirstChild(node.Element);
                if (child != null && node.Depth >= MaximumDepth) return null;
                while (child != null)
                {
                    if (++discovered > MaximumNodes) return null;
                    pending.Push(new PendingNode { Element = child, Depth = node.Depth + 1 });
                    child = walker.GetNextSibling(child);
                }
            }
            return documents.ToArray();
        }
    }
}
