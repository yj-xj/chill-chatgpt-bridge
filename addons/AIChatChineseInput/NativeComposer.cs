using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

// Standalone .NET Framework helper. Drafts travel through redirected pipes only.
// Exit 0: one base64 UTF-8 line was committed; exit 2: cancelled, with no stdout.
// Exit 1: failure; stderr contains only the exception's type, never its message.
internal static class NativeComposer
{
    private const int MaximumCharacters = 100000;
    private const int MaximumUtf8Bytes = MaximumCharacters * 3;
    private const int MaximumEncodedCharacters = ((MaximumUtf8Bytes + 2) / 3) * 4;
    private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            int parentId;
            if (args.Length != 1 || !Int32.TryParse(args[0], out parentId) || parentId <= 0)
                throw new ArgumentException();

            Process parent;
            try { parent = Process.GetProcessById(parentId); }
            catch (ArgumentException) { return 2; }
            using (parent)
            {
                if (ParentHasExited(parent)) return 2;
                string encoded = ReadBoundedLine(Console.In);
                if (encoded == null || ParentHasExited(parent)) return 2;
                string draft = DecodeDraft(encoded);
                EnableDpiAwareness();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
                using (var form = new ComposerForm(draft, parent))
                {
                    Application.Run(form);
                    if (!form.WasCommitted || ParentHasExited(parent)) return 2;
                    // An empty committed draft is an empty base64 line, not cancellation.
                    string result = EncodeDraft(form.CommittedText);
                    Console.Out.WriteLine(result);
                    Console.Out.Flush();
                    return 0;
                }
            }
        }
        catch (Exception error)
        {
            try { Console.Error.WriteLine(error.GetType().FullName); }
            catch { /* A closed parent pipe must never open a diagnostic dialog. */ }
            return 1;
        }
    }

    private static string ReadBoundedLine(TextReader reader)
    {
        var line = new StringBuilder();
        for (;;)
        {
            int value = reader.Read();
            if (value < 0) return line.Length == 0 ? null : line.ToString();
            if (value == '\n') return line.ToString();
            if (value == '\r')
            {
                if (reader.Peek() == '\n') reader.Read();
                return line.ToString();
            }
            if (line.Length >= MaximumEncodedCharacters) throw new InvalidDataException();
            line.Append((char)value);
        }
    }

    private static string DecodeDraft(string encoded)
    {
        if (encoded == null || encoded.Length > MaximumEncodedCharacters) throw new InvalidDataException();
        byte[] bytes = Convert.FromBase64String(encoded);
        if (bytes.Length > MaximumUtf8Bytes) throw new InvalidDataException();
        string draft = StrictUtf8.GetString(bytes);
        ValidateDraft(draft);
        return draft;
    }

    private static string EncodeDraft(string draft)
    {
        ValidateDraft(draft);
        byte[] bytes = StrictUtf8.GetBytes(draft);
        if (bytes.Length > MaximumUtf8Bytes) throw new InvalidDataException();
        return Convert.ToBase64String(bytes);
    }

    private static void ValidateDraft(string draft)
    {
        // Win32 edit controls cannot round-trip an embedded NUL character.
        if (draft == null || draft.Length > MaximumCharacters || draft.IndexOf('\0') >= 0)
            throw new InvalidDataException();
    }

    private static bool ParentHasExited(Process parent)
    {
        try { return parent.HasExited; }
        catch { return true; }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDPIAware();

    private static void EnableDpiAwareness()
    {
        try
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, available on recent Windows.
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        }
        catch (EntryPointNotFoundException) { }
        try { SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { }
    }

    private sealed class ComposerForm : Form
    {
        internal readonly TextBox Editor;
        internal readonly Button CommitButton;
        private readonly System.Windows.Forms.Timer parentTimer;
        private readonly Process parent;
        internal bool WasCommitted { get; private set; }
        internal string CommittedText { get; private set; }

        internal ComposerForm(string draft, Process parentProcess)
        {
            ValidateDraft(draft);
            parent = parentProcess;
            Text = "AIChat 中文输入";
            Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Regular, GraphicsUnit.Point);
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96F, 96F);
            ClientSize = new Size(720, 460);
            MinimumSize = new Size(480, 300);
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            TopMost = false;
            KeyPreview = false;
            AcceptButton = null;
            CancelButton = null;

            var layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Padding = new Padding(12);
            layout.ColumnCount = 1;
            layout.RowCount = 3;
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

            var help = new Label();
            help.AutoSize = true;
            help.MaximumSize = new Size(660, 0);
            help.Text = "使用系统输入法编辑。回车用于选词确认或换行；点“填回对话框”后，再回游戏点击发送。";
            help.Margin = new Padding(0, 0, 0, 10);

            Editor = new TextBox();
            Editor.Multiline = true;
            Editor.AcceptsReturn = true;
            Editor.AcceptsTab = false;
            Editor.WordWrap = true;
            Editor.ScrollBars = ScrollBars.Vertical;
            Editor.Dock = DockStyle.Fill;
            Editor.MaxLength = MaximumCharacters;
            Editor.ImeMode = ImeMode.On;
            Editor.ShortcutsEnabled = true;
            Editor.Text = draft;
            Editor.Margin = new Padding(0);

            var buttons = new FlowLayoutPanel();
            buttons.AutoSize = true;
            buttons.Dock = DockStyle.Fill;
            buttons.FlowDirection = FlowDirection.RightToLeft;
            buttons.WrapContents = false;
            buttons.Margin = new Padding(0, 10, 0, 0);

            CommitButton = new Button();
            CommitButton.Text = "填回对话框";
            CommitButton.AutoSize = true;
            CommitButton.MinimumSize = new Size(140, 36);
            CommitButton.Click += delegate
            {
                ValidateDraft(Editor.Text);
                CommittedText = Editor.Text;
                WasCommitted = true;
                Close();
            };
            var cancel = new Button();
            cancel.Text = "取消";
            cancel.AutoSize = true;
            cancel.MinimumSize = new Size(90, 36);
            cancel.Click += delegate { Close(); };
            buttons.Controls.Add(CommitButton);
            buttons.Controls.Add(cancel);
            layout.Controls.Add(help, 0, 0);
            layout.Controls.Add(Editor, 0, 1);
            layout.Controls.Add(buttons, 0, 2);
            Controls.Add(layout);

            parentTimer = new System.Windows.Forms.Timer();
            parentTimer.Interval = 750;
            parentTimer.Tick += delegate
            {
                if (parent != null && ParentHasExited(parent)) Close();
            };
            Shown += delegate
            {
                if (parent != null) parentTimer.Start();
                Editor.Select();
                Editor.SelectionStart = Editor.TextLength;
                Editor.SelectionLength = 0;
                Editor.Focus();
            };
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) parentTimer.Dispose();
            base.Dispose(disposing);
        }
    }

    private static int SelfTest()
    {
        string[] samples = {
            "", "中文输入测试", "English + 中文 + 🌙", "引号\"与反斜杠\\", "第一行\r\n第二行\n第三行", new string('中', MaximumCharacters)
        };
        foreach (string sample in samples)
        {
            if (DecodeDraft(EncodeDraft(sample)) != sample) throw new InvalidOperationException();
        }
        if (ReadBoundedLine(new StringReader("\r\n")) != "") throw new InvalidOperationException();
        if (ReadBoundedLine(new StringReader("")) != null) throw new InvalidOperationException();
        bool tooLongRejected = false;
        try { EncodeDraft(new string('x', MaximumCharacters + 1)); }
        catch (InvalidDataException) { tooLongRejected = true; }
        if (!tooLongRejected) throw new InvalidOperationException();
        bool invalidUtf8Rejected = false;
        try { DecodeDraft(Convert.ToBase64String(new byte[] { 0xC3 })); }
        catch (DecoderFallbackException) { invalidUtf8Rejected = true; }
        if (!invalidUtf8Rejected) throw new InvalidOperationException();

        using (var form = new ComposerForm("离线属性测试", null))
        {
            if (form.Visible || form.WasCommitted || form.AcceptButton != null || form.CancelButton != null || form.KeyPreview)
                throw new InvalidOperationException();
            if (!form.Editor.Multiline || !form.Editor.AcceptsReturn || form.Editor.MaxLength != MaximumCharacters || form.Editor.ImeMode != ImeMode.On)
                throw new InvalidOperationException();
            if (form.AutoScaleMode != AutoScaleMode.Dpi || form.TopMost || !form.ShowInTaskbar)
                throw new InvalidOperationException();
        }
        Console.Out.WriteLine("PASS: protocol round-trip, bounds, strict UTF-8, and non-visible UI properties.");
        return 0;
    }
}
