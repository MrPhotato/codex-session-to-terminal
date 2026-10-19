using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace CodexSessionToTerminal
{
    // Windows runs a nested message loop during menu navigation and resizing.
    // A thread-pool timer keeps the terminal lease alive while that loop owns
    // the UI thread; callbacks never interact with controls or PowerShell.
    public sealed class TrayHeartbeat : IDisposable
    {
        private readonly object gate = new object();
        private readonly string path;
        private System.Threading.Timer timer;
        private bool disposed;

        public TrayHeartbeat(string controlDirectory)
        {
            if (String.IsNullOrWhiteSpace(controlDirectory) || !Path.IsPathRooted(controlDirectory))
                throw new ArgumentException("An absolute control directory is required.", "controlDirectory");
            path = Path.Combine(controlDirectory, "heartbeat");
            Write(null);
            timer = new System.Threading.Timer(Write, null, 2000, 2000);
        }

        private void Write(object state)
        {
            lock (gate)
            {
                if (disposed) return;
                try { File.WriteAllText(path, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture)); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                catch (System.Security.SecurityException) { }
            }
        }

        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true;
                if (timer != null) { timer.Dispose(); timer = null; }
            }
        }
    }

    public sealed class SessionRow
    {
        public string ThreadId;
        public string Title;
        public string Phase;
        public bool ActiveTurn;
        public int TerminalCount;
    }

    public static class SystemAppearance
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetUserPreferredUILanguages(uint flags, out uint count, StringBuilder buffer, ref uint length);

        [DllImport("kernel32.dll")]
        private static extern ushort GetUserDefaultUILanguage();

        public static bool IsDark()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    object value = key == null ? null : key.GetValue("AppsUseLightTheme");
                    return value != null && Convert.ToInt32(value, CultureInfo.InvariantCulture) == 0;
                }
            }
            catch { return false; }
        }

        public static string UiLanguage()
        {
            try
            {
                uint count;
                uint length = 0;
                GetUserPreferredUILanguages(8, out count, null, ref length);
                if (length > 0 && length <= 65536)
                {
                    StringBuilder buffer = new StringBuilder((int)length);
                    if (GetUserPreferredUILanguages(8, out count, buffer, ref length))
                    {
                        string language = buffer.ToString().Split('\0')[0];
                        if (!String.IsNullOrWhiteSpace(language)) return language;
                    }
                }
                return CultureInfo.GetCultureInfo((int)GetUserDefaultUILanguage()).Name;
            }
            catch { return CultureInfo.CurrentUICulture.Name; }
        }
    }

    // The tray owns the window and supplies metadata only. This panel never
    // reads conversations or opens an additional connection to ChatGPT.
    public sealed class SessionPanel : Form
    {
        private const string Brand = "Codex Session to Terminal";
        private SessionRow[] rows = new SessionRow[0];
        private bool dark;
        private bool chinese;
        private float scale = 1;
        private float scroll;
        private bool draggingScroll;
        private float dragOffset;
        private RectangleF viewport;
        private RectangleF scrollTrack;
        private RectangleF scrollThumb;
        private Font brandFont;
        private Font headingFont;
        private Font titleFont;
        private Font bodyFont;
        private Font smallFont;
        private Font keyFont;
        private Icon ownedIcon;

        public bool AllowClose { get; set; }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

        public SessionPanel(string iconPath)
        {
            SuspendLayout();
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            AutoScaleDimensions = new SizeF(96, 96);
            AutoScaleMode = AutoScaleMode.Dpi;
            ClientSize = new Size(760, 570);
            MinimumSize = new Size(530, 420);
            StartPosition = FormStartPosition.CenterScreen;
            Text = Brand;
            ShowInTaskbar = true;
            KeyPreview = true;
            try
            {
                if (!String.IsNullOrEmpty(iconPath))
                {
                    ownedIcon = new Icon(iconPath);
                    Icon = ownedIcon;
                }
            }
            catch { }
            BuildFonts();
            ApplyColors();
            ResumeLayout(false);
        }

        public void UpdateView(SessionRow[] sessions, bool useDarkTheme, bool useChinese)
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                BeginInvoke(new Action(() => UpdateView(sessions, useDarkTheme, useChinese)));
                return;
            }
            SessionRow[] next = new SessionRow[sessions == null ? 0 : sessions.Length];
            for (int i = 0; i < next.Length; i++)
            {
                SessionRow source = sessions[i] ?? new SessionRow();
                next[i] = new SessionRow {
                    ThreadId = source.ThreadId,
                    Title = CleanTitle(source.Title),
                    Phase = source.Phase ?? "disconnected",
                    ActiveTurn = source.ActiveTurn,
                    TerminalCount = Math.Max(1, source.TerminalCount)
                };
            }
            bool themeChanged = dark != useDarkTheme;
            bool languageChanged = chinese != useChinese;
            rows = next;
            dark = useDarkTheme;
            chinese = useChinese;
            if (languageChanged) BuildFonts();
            Text = (chinese ? "终端会话" : "Terminal sessions") + " — " + Brand;
            AccessibleName = Text;
            StringBuilder description = new StringBuilder(Summary());
            foreach (SessionRow row in rows)
            {
                description.Append(". ");
                description.Append(String.IsNullOrEmpty(row.Title) ? (chinese ? "未命名会话" : "Untitled session") : row.Title);
                description.Append(": ");
                description.Append(StatusText(row));
            }
            AccessibleDescription = description.ToString();
            ApplyColors();
            if (themeChanged && IsHandleCreated) ApplyTitleBarTheme();
            ClampScroll(ClientSize.Height);
            Invalidate();
        }

        public void ShowPanel()
        {
            if (IsDisposed) return;
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Show();
            BringToFront();
            Activate();
        }

        // Component previews can be rendered without showing a window or
        // changing Windows appearance. Dimensions are pixels at current DPI.
        public Bitmap RenderPreview(int width, int height)
        {
            if (width < 400 || height < 300 || width > 4096 || height > 4096)
                throw new ArgumentOutOfRangeException("width", "Preview dimensions must be between 400 x 300 and 4096 x 4096.");
            Bitmap bitmap = new Bitmap(width, height);
            using (Graphics graphics = Graphics.FromImage(bitmap)) PaintContent(graphics, width, height);
            return bitmap;
        }

        private static string CleanTitle(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return "";
            StringBuilder result = new StringBuilder();
            int characters = 0;
            for (int i = 0; i < value.Length && characters < 200; i++)
            {
                char character = value[i];
                if (Char.IsControl(character) || character == '\u061c' || character == '\u200e' || character == '\u200f' || (character >= '\u202a' && character <= '\u202e') || (character >= '\u2066' && character <= '\u2069')) continue;
                if (Char.IsHighSurrogate(character))
                {
                    if (i + 1 < value.Length && Char.IsLowSurrogate(value[i + 1]))
                    {
                        result.Append(character);
                        result.Append(value[++i]);
                        characters++;
                    }
                    continue;
                }
                if (Char.IsLowSurrogate(character)) continue;
                result.Append(character);
                characters++;
            }
            return result.ToString().Trim();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            BuildFonts();
            ApplyTitleBarTheme();
        }

        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            BuildFonts();
            ClampScroll(ClientSize.Height);
            Invalidate();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!AllowClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
            base.OnFormClosing(e);
        }

        private void BuildFonts()
        {
            DisposeFonts();
            scale = Math.Max(1, DeviceDpi / 96f);
            brandFont = MakeFont(14, FontStyle.Bold);
            headingFont = MakeFont(25, FontStyle.Bold);
            // Session titles can contain Chinese even when Windows uses English.
            titleFont = new Font("Microsoft YaHei UI", 16 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
            bodyFont = MakeFont(13, FontStyle.Regular);
            smallFont = MakeFont(12, FontStyle.Regular);
            keyFont = MakeFont(12, FontStyle.Regular);
        }

        private Font MakeFont(float pixels, FontStyle style) { return new Font(chinese ? "Microsoft YaHei UI" : "Segoe UI", pixels * scale, style, GraphicsUnit.Pixel); }
        private Color BackgroundColor { get { return dark ? Color.FromArgb(33, 33, 33) : Color.White; } }
        private Color CardColor { get { return dark ? Color.FromArgb(47, 47, 47) : Color.FromArgb(247, 247, 248); } }
        private Color MainColor { get { return dark ? Color.FromArgb(236, 236, 236) : Color.FromArgb(22, 22, 22); } }
        private Color MutedColor { get { return dark ? Color.FromArgb(166, 166, 166) : Color.FromArgb(106, 106, 106); } }
        private Color LineColor { get { return dark ? Color.FromArgb(62, 62, 62) : Color.FromArgb(228, 228, 228); } }

        private void ApplyColors() { BackColor = BackgroundColor; ForeColor = MainColor; }

        private void ApplyTitleBarTheme()
        {
            try
            {
                int enabled = dark ? 1 : 0;
                if (DwmSetWindowAttribute(Handle, 20, ref enabled, sizeof(int)) != 0)
                    DwmSetWindowAttribute(Handle, 19, ref enabled, sizeof(int));
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
        }

        private string Summary()
        {
            int connected = 0;
            for (int i = 0; i < rows.Length; i++) if (rows[i].Phase == "ready") connected++;
            if (rows.Length == 0) return chinese ? "已打开的终端会话会显示在这里" : "Your open terminal sessions appear here";
            if (chinese) return rows.Length + " 个会话 · " + connected + " 已连接";
            return rows.Length + (rows.Length == 1 ? " session" : " sessions") + " · " + connected + " connected";
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            PaintContent(e.Graphics, ClientSize.Width, ClientSize.Height);
        }

        private void PaintContent(Graphics graphics, int width, int height)
        {
            graphics.Clear(BackgroundColor);
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            float margin = 30 * scale;
            RectangleF iconBounds = new RectangleF(margin, 28 * scale, 27 * scale, 27 * scale);
            if (ownedIcon != null) graphics.DrawIcon(ownedIcon, Rectangle.Round(iconBounds));
            else DrawTerminal(graphics, iconBounds, MainColor, 1.5f * scale);
            DrawText(graphics, Brand, brandFont, MainColor, new RectangleF(margin + 39 * scale, 28 * scale, width - margin * 2 - 39 * scale, 28 * scale));
            DrawText(graphics, chinese ? "终端会话" : "Terminal sessions", headingFont, MainColor, new RectangleF(margin - scale, 86 * scale, width - margin * 2, 36 * scale));
            DrawText(graphics, Summary(), bodyFont, MutedColor, new RectangleF(margin, 129 * scale, width - margin * 2, 24 * scale));

            viewport = new RectangleF(margin, 175 * scale, Math.Max(1, width - margin * 2), Math.Max(1, height - 253 * scale));
            float maxScroll = Math.Max(0, ContentHeight() - viewport.Height);
            scroll = Math.Max(0, Math.Min(scroll, maxScroll));
            GraphicsState saved = graphics.Save();
            graphics.SetClip(viewport);
            if (rows.Length == 0) DrawEmpty(graphics, viewport);
            else
            {
                float cardWidth = viewport.Width - (maxScroll > 0 ? 14 * scale : 0);
                for (int i = 0; i < rows.Length; i++)
                {
                    RectangleF bounds = new RectangleF(viewport.Left, viewport.Top + i * 96 * scale - scroll, cardWidth, 84 * scale);
                    if (bounds.Bottom >= viewport.Top && bounds.Top <= viewport.Bottom) DrawRow(graphics, rows[i], bounds);
                }
            }
            graphics.Restore(saved);
            scrollTrack = RectangleF.Empty;
            scrollThumb = RectangleF.Empty;
            if (maxScroll > 0)
            {
                scrollTrack = new RectangleF(viewport.Right - 6 * scale, viewport.Top, 5 * scale, viewport.Height);
                float thumbHeight = Math.Max(28 * scale, viewport.Height * viewport.Height / ContentHeight());
                scrollThumb = new RectangleF(scrollTrack.Left, scrollTrack.Top + scroll / maxScroll * (scrollTrack.Height - thumbHeight), scrollTrack.Width, thumbHeight);
                FillRounded(graphics, scrollThumb, 2.5f * scale, dark ? Color.FromArgb(97, 97, 97) : Color.FromArgb(190, 190, 190));
            }
            float footerY = height - 48 * scale;
            using (Pen pen = new Pen(LineColor)) graphics.DrawLine(pen, margin, height - 65 * scale, width - margin, height - 65 * scale);
            RectangleF keyBounds = new RectangleF(margin, footerY, 88 * scale, 25 * scale);
            FillRounded(graphics, keyBounds, 5 * scale, CardColor);
            DrawText(graphics, "Ctrl+Alt+L", keyFont, MutedColor, keyBounds, TextFormatFlags.HorizontalCenter);
            DrawText(graphics, chinese ? "在 ChatGPT 中打开当前会话" : "Open the current chat from ChatGPT", smallFont, MutedColor,
                new RectangleF(keyBounds.Right + 12 * scale, footerY, width - margin - keyBounds.Right - 12 * scale, 25 * scale));
        }

        private void DrawEmpty(Graphics graphics, RectangleF bounds)
        {
            float center = bounds.Left + bounds.Width / 2;
            bool compact = bounds.Height < 164 * scale;
            float iconSize = (compact ? 48 : 62) * scale;
            float top = bounds.Top + Math.Max(0, (bounds.Height - (compact ? 126 : 164) * scale) / 2);
            FillRounded(graphics, new RectangleF(center - iconSize / 2, top, iconSize, iconSize), (compact ? 16 : 20) * scale, CardColor);
            DrawTerminal(graphics, new RectangleF(center - 15 * scale, top + (iconSize - 25 * scale) / 2, 30 * scale, 25 * scale), MutedColor, 1.6f * scale);
            DrawText(graphics, chinese ? "还没有终端会话" : "No terminal sessions yet", titleFont, MainColor,
                new RectangleF(bounds.Left, top + (compact ? 64 : 83) * scale, bounds.Width, 30 * scale), TextFormatFlags.HorizontalCenter);
            DrawText(graphics, chinese ? "打开一个会话，就能在这里查看连接状态。" : "Open a session to see its connection here.", bodyFont, MutedColor,
                new RectangleF(bounds.Left, top + (compact ? 99 : 119) * scale, bounds.Width, 27 * scale), TextFormatFlags.HorizontalCenter);
        }

        private void DrawRow(Graphics graphics, SessionRow row, RectangleF bounds)
        {
            FillRounded(graphics, bounds, 12 * scale, CardColor);
            DrawTerminal(graphics, new RectangleF(bounds.Left + 20 * scale, bounds.Top + 27 * scale, 27 * scale, 24 * scale), MutedColor, 1.4f * scale);
            float left = bounds.Left + 64 * scale;
            float countWidth = row.TerminalCount > 1 ? (chinese ? 83 : 103) * scale : 0;
            string title = String.IsNullOrEmpty(row.Title) ? (chinese ? "未命名会话" : "Untitled session") : row.Title;
            DrawText(graphics, title, titleFont, MainColor, new RectangleF(left, bounds.Top + 14 * scale, Math.Max(1, bounds.Right - left - 18 * scale - countWidth), 28 * scale));
            string status = StatusText(row);
            Color statusColor;
            if (row.Phase == "ready")
            {
                statusColor = row.ActiveTurn ? (dark ? Color.FromArgb(130, 175, 236) : Color.FromArgb(67, 115, 175)) : (dark ? Color.FromArgb(113, 184, 147) : Color.FromArgb(54, 138, 95));
            }
            else if (row.Phase == "syncing" || row.Phase == "connecting" || row.Phase == "initializing" || row.Phase == "discovering" || row.Phase == "idle")
            {
                statusColor = dark ? Color.FromArgb(216, 178, 103) : Color.FromArgb(162, 122, 52);
            }
            else
            {
                statusColor = MutedColor;
            }
            using (Brush brush = new SolidBrush(statusColor)) graphics.FillEllipse(brush, left + scale, bounds.Top + 54 * scale, 6 * scale, 6 * scale);
            DrawText(graphics, status, bodyFont, MutedColor, new RectangleF(left + 15 * scale, bounds.Top + 43 * scale, Math.Max(1, bounds.Right - left - 32 * scale), 28 * scale));
            if (row.TerminalCount > 1)
            {
                string count = chinese ? row.TerminalCount + " 个终端" : row.TerminalCount + " terminals";
                DrawText(graphics, count, smallFont, MutedColor, new RectangleF(bounds.Right - 20 * scale - countWidth, bounds.Top + 17 * scale, countWidth, 24 * scale), TextFormatFlags.Right);
            }
        }

        private string StatusText(SessionRow row)
        {
            if (row.Phase == "ready") return row.ActiveTurn ? (chinese ? "正在运行" : "Running") : (chinese ? "已连接" : "Connected");
            if (row.Phase == "syncing") return chinese ? "正在同步" : "Syncing";
            if (row.Phase == "connecting" || row.Phase == "initializing" || row.Phase == "discovering" || row.Phase == "idle") return chinese ? "正在连接" : "Connecting";
            if (row.Phase == "owner-unavailable") return chinese ? "会话暂不可用" : "Session unavailable";
            return chinese ? "已断开" : "Disconnected";
        }

        private void DrawTerminal(Graphics graphics, RectangleF bounds, Color color, float stroke)
        {
            using (GraphicsPath outline = Rounded(bounds, 4 * scale))
            using (Pen pen = new Pen(color, stroke))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                graphics.DrawPath(pen, outline);
                float x = bounds.Left + bounds.Width * .25f;
                float y = bounds.Top + bounds.Height * .34f;
                graphics.DrawLines(pen, new PointF[] {
                    new PointF(x, y), new PointF(x + bounds.Width * .14f, y + bounds.Height * .17f), new PointF(x, y + bounds.Height * .34f)
                });
                graphics.DrawLine(pen, bounds.Left + bounds.Width * .53f, bounds.Top + bounds.Height * .68f, bounds.Left + bounds.Width * .73f, bounds.Top + bounds.Height * .68f);
            }
        }

        private static GraphicsPath Rounded(RectangleF rectangle, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float diameter = Math.Min(Math.Min(rectangle.Width, rectangle.Height), radius * 2);
            if (diameter <= 0) { path.AddRectangle(rectangle); return path; }
            path.AddArc(rectangle.Left, rectangle.Top, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Top, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.Left, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        private static void FillRounded(Graphics graphics, RectangleF rectangle, float radius, Color color)
        {
            using (GraphicsPath path = Rounded(rectangle, radius))
            using (Brush brush = new SolidBrush(color)) graphics.FillPath(brush, path);
        }

        private static void DrawText(Graphics graphics, string text, Font font, Color color, RectangleF bounds, TextFormatFlags alignment = TextFormatFlags.Left)
        {
            using (StringFormat format = new StringFormat())
            using (Brush brush = new SolidBrush(color))
            {
                format.Alignment = (alignment & TextFormatFlags.HorizontalCenter) != 0 ? StringAlignment.Center :
                    (alignment & TextFormatFlags.Right) != 0 ? StringAlignment.Far : StringAlignment.Near;
                format.LineAlignment = StringAlignment.Center;
                format.Trimming = StringTrimming.EllipsisCharacter;
                format.FormatFlags = StringFormatFlags.NoWrap;
                graphics.DrawString(text, font, brush, bounds, format);
            }
        }

        private float ContentHeight() { return Math.Max(0, rows.Length * 96 * scale - 12 * scale); }
        private void ClampScroll(int height) { scroll = Math.Max(0, Math.Min(scroll, Math.Max(0, ContentHeight() - Math.Max(1, height - 253 * scale)))); }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            ClampScroll(ClientSize.Height);
            Invalidate();
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            scroll -= e.Delta / 120f * 60 * scale;
            ClampScroll(ClientSize.Height);
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left || scrollTrack.IsEmpty) return;
            RectangleF hitArea = scrollTrack;
            hitArea.Inflate(5 * scale, 0);
            if (!hitArea.Contains(e.Location)) return;
            draggingScroll = true;
            Capture = true;
            dragOffset = scrollThumb.Contains(e.Location) ? e.Y - scrollThumb.Top : scrollThumb.Height / 2;
            MoveScroll(e.Y);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (draggingScroll) MoveScroll(e.Y);
        }

        private void MoveScroll(float y)
        {
            float travel = scrollTrack.Height - scrollThumb.Height;
            if (travel <= 0) return;
            float ratio = Math.Max(0, Math.Min(1, (y - dragOffset - scrollTrack.Top) / travel));
            scroll = ratio * Math.Max(0, ContentHeight() - viewport.Height);
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button == MouseButtons.Left) { draggingScroll = false; Capture = false; }
        }

        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            base.OnMouseCaptureChanged(e);
            if (!Capture) draggingScroll = false;
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape) { Hide(); e.Handled = true; return; }
            if (e.KeyCode == Keys.Down) scroll += 48 * scale;
            else if (e.KeyCode == Keys.Up) scroll -= 48 * scale;
            else if (e.KeyCode == Keys.PageDown) scroll += viewport.Height * .8f;
            else if (e.KeyCode == Keys.PageUp) scroll -= viewport.Height * .8f;
            else if (e.KeyCode == Keys.Home) scroll = 0;
            else if (e.KeyCode == Keys.End) scroll = ContentHeight();
            else return;
            ClampScroll(ClientSize.Height);
            e.Handled = true;
            e.SuppressKeyPress = true;
            Invalidate();
        }

        private void DisposeFonts()
        {
            if (brandFont != null) brandFont.Dispose();
            if (headingFont != null) headingFont.Dispose();
            if (titleFont != null) titleFont.Dispose();
            if (bodyFont != null) bodyFont.Dispose();
            if (smallFont != null) smallFont.Dispose();
            if (keyFont != null) keyFont.Dispose();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                DisposeFonts();
                if (ownedIcon != null) { ownedIcon.Dispose(); ownedIcon = null; }
            }
            base.Dispose(disposing);
        }
    }
}
