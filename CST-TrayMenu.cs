using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace CodexSessionToTerminal
{
    // This remains a native menu: Windows owns focus, keyboard navigation,
    // accessibility, dismissal and placement at the edge of the screen.
    public sealed class TrayMenu : ContextMenuStrip
    {
        public const string Brand = "Codex Session to Terminal";
        public readonly ToolStripMenuItem SessionsItem;
        public readonly ToolStripMenuItem ExitItem;
        private readonly ToolStripLabel heading;
        private readonly ToolStripLabel status;
        private readonly ToolStripLabel hint;
        private readonly ToolStripSeparator separator;
        private readonly MenuRenderer menuRenderer;
        private bool dark;
        private bool chinese;
        private bool desktopReady;
        private bool appearanceInitialized;
        private bool highContrast;
        private float scale = 1;
        private float previewScale;
        private Font bodyFont;
        private Font headingFont;
        private Font smallFont;

        public TrayMenu()
        {
            AutoSize = false;
            ShowImageMargin = false;
            ShowCheckMargin = false;
            ShowItemToolTips = false;
            AccessibleName = Brand;
            AccessibleRole = AccessibleRole.MenuPopup;
            menuRenderer = new MenuRenderer(this);
            heading = Info("heading");
            status = Info("status");
            hint = Info("hint");
            SessionsItem = ActionItem("sessions");
            ExitItem = ActionItem("exit");
            separator = new ToolStripSeparator { AutoSize = false, Margin = Padding.Empty };
            Items.AddRange(new ToolStripItem[] { heading, status, SessionsItem, separator, ExitItem, hint });
            UpdateAppearance(false, false, false);
        }

        private static ToolStripLabel Info(string tag)
        {
            return new ToolStripLabel {
                Tag = tag, AutoSize = false, TextAlign = ContentAlignment.MiddleLeft,
                Margin = Padding.Empty, AccessibleRole = AccessibleRole.StaticText
            };
        }

        private static ToolStripMenuItem ActionItem(string tag)
        {
            return new ToolStripMenuItem {
                Tag = tag, AutoSize = false, TextAlign = ContentAlignment.MiddleLeft,
                Margin = Padding.Empty, AccessibleRole = AccessibleRole.MenuItem
            };
        }

        public void UpdateAppearance(bool useDarkTheme, bool useChinese, bool isDesktopReady)
        {
            if (IsDisposed) return;
            bool nextHighContrast = SystemInformation.HighContrast;
            float nextScale = previewScale > 0 ? previewScale : Math.Max(1, DeviceDpi / 96f);
            bool metricsChanged = !appearanceInitialized || chinese != useChinese || Math.Abs(scale - nextScale) > 0.001f;
            if (appearanceInitialized && dark == useDarkTheme && chinese == useChinese && desktopReady == isDesktopReady &&
                highContrast == nextHighContrast && !metricsChanged) return;
            dark = useDarkTheme;
            chinese = useChinese;
            desktopReady = isDesktopReady;
            highContrast = nextHighContrast;
            heading.Text = Brand;
            status.Text = chinese ? (desktopReady ? "已就绪 · ChatGPT 正在运行" : "等待 ChatGPT 启动")
                : (desktopReady ? "Ready · ChatGPT is running" : "Waiting for ChatGPT");
            SessionsItem.Text = chinese ? "查看终端会话" : "View terminal sessions";
            ExitItem.Text = chinese ? "退出" : "Exit";
            hint.Text = chinese ? "在 ChatGPT 中按 Ctrl+Alt+L" : "In ChatGPT, press Ctrl+Alt+L";
            AccessibleDescription = status.Text;
            foreach (ToolStripItem item in Items) item.AccessibleName = item.Text;
            Renderer = highContrast ? (ToolStripRenderer)new ToolStripSystemRenderer() : menuRenderer;
            BackColor = Background;
            ForeColor = Foreground;
            if (metricsChanged) ApplyMetrics(nextScale);
            else
            {
                foreach (ToolStripMenuItem item in new[] { SessionsItem, ExitItem }) item.ForeColor = Foreground;
                foreach (ToolStripLabel item in new[] { heading, status, hint }) item.ForeColor = item == heading ? Foreground : Muted;
            }
            appearanceInitialized = true;
            Invalidate();
        }

        private int Px(float value) { return Math.Max(1, (int)Math.Round(value * scale)); }
        private Color Background { get { return SystemInformation.HighContrast ? SystemColors.Menu : dark ? Color.FromArgb(33, 33, 35) : Color.FromArgb(252, 252, 253); } }
        private Color Foreground { get { return SystemInformation.HighContrast ? SystemColors.MenuText : dark ? Color.FromArgb(238, 238, 240) : Color.FromArgb(38, 38, 41); } }
        private Color Muted { get { return SystemInformation.HighContrast ? SystemColors.MenuText : dark ? Color.FromArgb(166, 166, 174) : Color.FromArgb(100, 100, 110); } }
        private Color Edge { get { return dark ? Color.FromArgb(63, 63, 68) : Color.FromArgb(221, 221, 227); } }

        private void ApplyMetrics(float nextScale)
        {
            scale = Math.Max(1, Math.Min(4, nextScale));
            SuspendLayout();
            Font previousBody = bodyFont, previousHeading = headingFont, previousSmall = smallFont;
            bodyFont = new Font(chinese ? "Microsoft YaHei UI" : "Segoe UI", 13 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
            headingFont = new Font("Segoe UI", 14 * scale, FontStyle.Bold, GraphicsUnit.Pixel);
            smallFont = new Font(chinese ? "Microsoft YaHei UI" : "Segoe UI", 12 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
            Font = bodyFont;
            Padding = new Padding(Px(6), Px(8), Px(6), Px(4));
            int width = Px(280), itemWidth = width - Padding.Horizontal;
            heading.Size = new Size(itemWidth, Px(25));
            status.Size = new Size(itemWidth, Px(25));
            heading.Font = headingFont;
            status.Font = smallFont;
            hint.Font = smallFont;
            hint.Size = new Size(itemWidth, Px(30));
            foreach (ToolStripMenuItem item in new[] { SessionsItem, ExitItem })
            {
                item.Size = new Size(itemWidth, Px(32));
                item.Font = bodyFont;
                item.Padding = Padding.Empty;
                item.ForeColor = Foreground;
            }
            foreach (ToolStripLabel item in new[] { heading, status, hint })
            {
                item.Padding = new Padding(Px(9), 0, Px(9), 0);
                item.ForeColor = item == heading ? Foreground : Muted;
            }
            separator.Size = new Size(itemWidth, Px(7));
            Size = new Size(width, Padding.Vertical + heading.Height + status.Height + 2 * SessionsItem.Height + separator.Height + hint.Height);
            ResumeLayout(true);
            if (previousBody != null) previousBody.Dispose();
            if (previousHeading != null) previousHeading.Dispose();
            if (previousSmall != null) previousSmall.Dispose();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (heading != null) ApplyMetrics(previewScale > 0 ? previewScale : Math.Max(1, DeviceDpi / 96f));
        }

        protected override void OnOpening(CancelEventArgs e)
        {
            UpdateAppearance(dark, chinese, desktopReady);
            base.OnOpening(e);
        }

        protected override void WndProc(ref Message m)
        {
            const int WmDpiChanged = 0x02E0;
            base.WndProc(ref m);
            if (m.Msg == WmDpiChanged && heading != null && previewScale == 0)
                ApplyMetrics(Math.Max(1, ((long)m.WParam & 0xFFFF) / 96f));
        }

        // Renders the same native menu without showing it or taking focus.
        public Bitmap RenderPreview(float dpiScale)
        {
            if (dpiScale < 1 || dpiScale > 4) throw new ArgumentOutOfRangeException("dpiScale");
            previewScale = dpiScale;
            try
            {
                ApplyMetrics(dpiScale);
                CreateControl();
                PerformLayout();
                Bitmap bitmap = new Bitmap(Width, Height);
                DrawToBitmap(bitmap, new Rectangle(Point.Empty, Size));
                return bitmap;
            }
            finally
            {
                previewScale = 0;
                ApplyMetrics(Math.Max(1, DeviceDpi / 96f));
            }
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing)
            {
                if (bodyFont != null) { bodyFont.Dispose(); bodyFont = null; }
                if (headingFont != null) { headingFont.Dispose(); headingFont = null; }
                if (smallFont != null) { smallFont.Dispose(); smallFont = null; }
            }
        }

        private sealed class MenuRenderer : ToolStripProfessionalRenderer
        {
            private readonly TrayMenu menu;
            public MenuRenderer(TrayMenu owner) { menu = owner; RoundedEdges = false; }

            protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
            {
                e.Graphics.Clear(menu.Background);
            }

            protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
            {
                using (Pen pen = new Pen(menu.Edge, 1))
                    e.Graphics.DrawRectangle(pen, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
            }

            protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
            protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e) { }

            protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
            {
                GraphicsState previous = e.Graphics.Save();
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                if (e.Item.Enabled && e.Item.Selected)
                {
                    Color selected = menu.dark ? Color.FromArgb(52, 52, 57) : Color.FromArgb(236, 236, 241);
                    using (Brush brush = new SolidBrush(selected))
                    using (GraphicsPath path = Rounded(new RectangleF(1, 1, e.Item.Width - 2, e.Item.Height - 2), menu.Px(5)))
                        e.Graphics.FillPath(brush, path);
                }
                DrawIcon(e.Graphics, Convert.ToString(e.Item.Tag), e.Item.Height, e.Item.Enabled ? menu.Foreground : menu.Muted);
                e.Graphics.Restore(previous);
            }

            protected override void OnRenderLabelBackground(ToolStripItemRenderEventArgs e)
            {
                if (Convert.ToString(e.Item.Tag) != "status") return;
                GraphicsState previous = e.Graphics.Save();
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Color color = menu.desktopReady ? (menu.dark ? Color.FromArgb(104, 202, 148) : Color.FromArgb(38, 143, 83)) : menu.Muted;
                using (Brush brush = new SolidBrush(color))
                    e.Graphics.FillEllipse(brush, menu.Px(10), (e.Item.Height - menu.Px(6)) / 2f, menu.Px(6), menu.Px(6));
                e.Graphics.Restore(previous);
            }

            protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
            {
                string tag = Convert.ToString(e.Item.Tag);
                int left = menu.Px(tag == "status" ? 24 : e.Item is ToolStripMenuItem ? 38 : 9);
                Rectangle bounds = new Rectangle(left, 0, e.Item.Width - left - menu.Px(9), e.Item.Height);
                Color color = tag == "status" || tag == "hint" || !e.Item.Enabled ? menu.Muted : menu.Foreground;
                TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, bounds, color,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);
            }

            protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
            {
                using (Pen pen = new Pen(menu.Edge, 1))
                    e.Graphics.DrawLine(pen, menu.Px(9), e.Item.Height / 2, e.Item.Width - menu.Px(9), e.Item.Height / 2);
            }

            private void DrawIcon(Graphics graphics, string tag, int rowHeight, Color color)
            {
                float s = menu.scale * 0.85f, x = 11 * menu.scale, y = (rowHeight - 18 * s) / 2;
                using (Pen pen = new Pen(color, Math.Max(1, 1.35f * s)))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    if (tag == "sessions")
                    {
                        using (GraphicsPath path = Rounded(new RectangleF(x, y + 1 * s, 19 * s, 15 * s), 2 * s)) graphics.DrawPath(pen, path);
                        graphics.DrawLines(pen, new[] { new PointF(x + 4 * s, y + 5 * s), new PointF(x + 7 * s, y + 8 * s), new PointF(x + 4 * s, y + 11 * s) });
                        graphics.DrawLine(pen, x + 10 * s, y + 11 * s, x + 14 * s, y + 11 * s);
                    }
                    else if (tag == "legacy")
                    {
                        graphics.DrawLines(pen, new[] { new PointF(x + 8 * s, y + 2 * s), new PointF(x + 7 * s, y), new PointF(x, y), new PointF(x, y + 16 * s), new PointF(x + 19 * s, y + 16 * s), new PointF(x + 19 * s, y + 4 * s), new PointF(x + 10 * s, y + 4 * s), new PointF(x + 8 * s, y + 2 * s) });
                    }
                    else if (tag == "exit")
                    {
                        graphics.DrawArc(pen, x + 2 * s, y + 2 * s, 15 * s, 15 * s, -48, 276);
                        graphics.DrawLine(pen, x + 9.5f * s, y, x + 9.5f * s, y + 8 * s);
                    }
                }
            }

            private static GraphicsPath Rounded(RectangleF rectangle, float radius)
            {
                GraphicsPath path = new GraphicsPath();
                float size = radius * 2;
                path.AddArc(rectangle.Left, rectangle.Top, size, size, 180, 90);
                path.AddArc(rectangle.Right - size, rectangle.Top, size, size, 270, 90);
                path.AddArc(rectangle.Right - size, rectangle.Bottom - size, size, size, 0, 90);
                path.AddArc(rectangle.Left, rectangle.Bottom - size, size, size, 90, 90);
                path.CloseFigure();
                return path;
            }
        }
    }
}
