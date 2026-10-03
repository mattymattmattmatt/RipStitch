using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace RipStitch
{
    /// <summary>The app window: the RipStitch site served by the private engine, in Edge WebView2.</summary>
    sealed class MainForm : Form
    {
        public int ExitCode;
        readonly WebView2 web;
        bool confirmedClose;
        static readonly Color Bg = Color.FromArgb(10, 13, 18);
        static string BoundsFile => Path.Combine(Program.Home, "window.txt");

        public MainForm()
        {
            Text = "RipStitch";
            Icon = Program.AppIcon;
            BackColor = Bg;
            MinimumSize = new Size(940, 620);
            StartPosition = FormStartPosition.Manual;
            LoadBounds();
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Bg };
            Controls.Add(web);
            Load += async (s, e) => await Init();
            FormClosing += OnClosing;
        }

        async Task Init()
        {
            try
            {
                CoreWebView2Environment.SetLoaderDllFolderPath(Path.Combine(Program.Root, "wv2"));
                string version = null;
                try { version = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
                catch (WebView2RuntimeNotFoundException) { }
                if (version == null)
                {
                    if (MessageBox.Show(this,
                        "RipStitch needs the Microsoft Edge WebView2 Runtime, which isn't installed on this PC.\n\nOpen Microsoft's download page now?",
                        "RipStitch", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                        Process.Start("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                    ExitCode = 2; confirmedClose = true; Close(); return;
                }

                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.Home, "WebView2"),
                    new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
                await web.EnsureCoreWebView2Async(env);
                var cw = web.CoreWebView2;
                cw.Settings.UserAgent += " RipStitchDesktop/" + Application.ProductVersion;
                cw.Settings.IsStatusBarEnabled = false;
                cw.Settings.IsZoomControlEnabled = true;
                cw.Settings.AreDevToolsEnabled = Program.SmokeDir != null || Environment.GetEnvironmentVariable("RIPSTITCH_DEVTOOLS") == "1";
                cw.DocumentTitleChanged += (s, e) =>
                {
                    var t = cw.DocumentTitle;
                    Text = string.IsNullOrEmpty(t) || t.StartsWith("http") || t.StartsWith("data:") ? "RipStitch" : t;
                };
                cw.NewWindowRequested += (s, e) => { e.Handled = true; OpenOutside(e.Uri); };
                cw.NavigationStarting += (s, e) =>
                {
                    if (IsOurs(e.Uri) || e.Uri.StartsWith("data:") || e.Uri.StartsWith("about:")) return;
                    e.Cancel = true; OpenOutside(e.Uri);
                };
                cw.PermissionRequested += (s, e) => { if (IsOurs(e.Uri)) e.State = CoreWebView2PermissionState.Allow; };
                cw.WebMessageReceived += OnWebMessage;

                cw.NavigateToString(Splash("Starting RipStitch…", null));
                var ok = await Task.Run(() => { Program.StartEngine(); return Program.WaitForEngine(60000); });
                if (!ok)
                {
                    cw.NavigateToString(Splash("The RipStitch engine didn't start.", "Details are in " + Program.EngineLog));
                    Program.Log("engine failed to start");
                    if (Program.SmokeDir != null) { File.WriteAllText(Path.Combine(Program.SmokeDir, "smoke.txt"), "engine-failed"); ExitCode = 3; confirmedClose = true; Close(); }
                    return;
                }
                cw.Navigate(Program.Base + "/");
                if (Program.SmokeDir != null) _ = SelfTest();
            }
            catch (Exception ex)
            {
                Program.Log("init failed: " + ex);
                if (Program.SmokeDir != null) { File.WriteAllText(Path.Combine(Program.SmokeDir, "smoke.txt"), "init-failed: " + ex.Message); ExitCode = 4; confirmedClose = true; Close(); return; }
                MessageBox.Show(this, "RipStitch couldn't open its window:\n\n" + ex.Message, "RipStitch", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        // ------------------------------------------------------------------ requests from the page
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        /// <summary>The page asks the window for things a web page can't do, e.g. {cmd:"pickFolder", id, start, title}.</summary>
        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsOurs(e.Source)) return;
            Dictionary<string, object> msg;
            try { msg = Json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); } catch { return; }
            string Str(string k) => msg != null && msg.TryGetValue(k, out var v) && v != null ? v.ToString() : "";
            var id = Str("id");
            if (Str("cmd") == "pickFolder")
            {
                // Show the dialog after this event returns, so WebView2 isn't held inside its own callback.
                BeginInvoke(new Action(() =>
                {
                    var reply = new Dictionary<string, object> { ["id"] = id };
                    try { reply["path"] = FolderPicker.Pick(Handle, Str("start"), Str("title"), Program.SmokeDir != null ? 1500 : 0); }
                    catch (Exception ex) { Program.Log("folder picker: " + ex); reply["error"] = ex.Message; }
                    web.CoreWebView2?.PostWebMessageAsJson(Json.Serialize(reply));
                }));
            }
        }

        static bool IsOurs(string uri) => uri.StartsWith(Program.Base + "/", StringComparison.OrdinalIgnoreCase) || uri == Program.Base;

        static void OpenOutside(string uri)
        {
            if (string.IsNullOrEmpty(uri) || !(uri.StartsWith("http://") || uri.StartsWith("https://") || uri.StartsWith("mailto:"))) return;
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (!confirmedClose && Program.SmokeDir == null && Program.Engine != null)
            {
                var n = Program.ActiveDownloads();
                if (n > 0 && MessageBox.Show(this,
                        $"{n} download{(n == 1 ? " is" : "s are")} still running. Quit RipStitch anyway?\n\nStopped downloads resume where they left off next time.",
                        "RipStitch", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.No)
                {
                    e.Cancel = true; return;
                }
            }
            SaveBounds();
            Program.StopEngine();
        }

        // ------------------------------------------------------------------ window size memory
        void LoadBounds()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            var w = Math.Min(1500, (int)(wa.Width * 0.86)); var h = Math.Min(960, (int)(wa.Height * 0.88));
            Bounds = new Rectangle(wa.Left + (wa.Width - w) / 2, wa.Top + (wa.Height - h) / 2, w, h);
            try
            {
                var p = File.ReadAllText(BoundsFile).Split(',').Select(int.Parse).ToArray();
                var r = new Rectangle(p[0], p[1], p[2], p[3]);
                if (r.Width >= 600 && r.Height >= 400 && Screen.AllScreens.Any(sc => sc.WorkingArea.IntersectsWith(r))) Bounds = r;
                if (p.Length > 4 && p[4] == 1) WindowState = FormWindowState.Maximized;
            }
            catch { }
        }

        void SaveBounds()
        {
            try
            {
                var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                File.WriteAllText(BoundsFile, $"{r.X},{r.Y},{r.Width},{r.Height},{(WindowState == FormWindowState.Maximized ? 1 : 0)}");
            }
            catch { }
        }

        // ------------------------------------------------------------------ splash while the engine starts
        static string Splash(string title, string detail)
        {
            string logo = "";
            try { logo = File.ReadAllText(Path.Combine(Program.Root, "site", "img", "logo.svg")); } catch { }
            string esc(string s) => (s ?? "").Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
            return "<!doctype html><meta charset=utf-8><style>html,body{height:100%;margin:0;background:#0a0d12;color:#e8edf3;font:14px 'Segoe UI',system-ui,sans-serif}"
                + "body{display:grid;place-items:center;user-select:none}.c{text-align:center}.l{width:84px;height:84px;margin:0 auto 18px;filter:drop-shadow(0 10px 26px rgba(255,120,30,.28))}"
                + "h1{margin:0;font-size:20px;font-weight:700}p{margin:8px 0 0;color:#7f8a9a;font-size:12.5px}"
                + ".s{width:22px;height:22px;margin:20px auto 0;border:2.5px solid #2a333f;border-top-color:#ff8a1f;border-radius:50%;animation:r .8s linear infinite}@keyframes r{to{transform:rotate(360deg)}}</style>"
                + "<div class=c><div class=l>" + logo + "</div><h1>" + esc(title) + "</h1>"
                + (detail != null ? "<p>" + esc(detail) + "</p>" : "<div class=s></div>") + "</div>";
        }

        // ------------------------------------------------------------------ CI self-test (--smoke DIR)
        async Task<string> Js(string script)
        {
            var r = await web.CoreWebView2.ExecuteScriptAsync(script);
            return r != null && r.Length >= 2 && r[0] == '"' ? System.Text.RegularExpressions.Regex.Unescape(r.Substring(1, r.Length - 2)) : r;
        }

        async Task Capture(string name)
        {
            using (var fs = File.Create(Path.Combine(Program.SmokeDir, name)))
                await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
        }

        async Task SelfTest()
        {
            var dir = Program.SmokeDir;
            string state = "timeout";
            for (int i = 0; i < 160; i++)
            {
                await Task.Delay(500);
                try
                {
                    state = await Js("(function(){try{var h=Rip.engine.health;return Rip.engine.state+'|'+(h?h.version+'|'+h.install+'|'+h.ytdlp+'|'+h.ffmpeg+'|'+h.js_runtime:'')+'|'+navigator.userAgent.indexOf('RipStitchDesktop')}catch(e){return 'loading:'+e.message}})()");
                }
                catch (Exception ex) { state = "js-error:" + ex.Message; }
                if (state.StartsWith("online|")) break;
            }
            await Task.Delay(800);
            await Capture("desktop-rip.png");
            await Js("App.go('stitch')"); await Task.Delay(1500);
            await Capture("desktop-stitch.png");
            await Js("App.go('rip')"); await Task.Delay(600);
            File.WriteAllText(Path.Combine(dir, "smoke.txt"), state);

            var read = Path.Combine(dir, "read.txt");
            bool didRead = false;
            while (!File.Exists(Path.Combine(dir, "quit")))
            {
                if (!didRead && File.Exists(read))
                {
                    didRead = true;
                    var url = File.ReadAllText(read).Trim().Replace("\\", "\\\\").Replace("'", "\\'");
                    await Js("Rip.read('" + url + "')");
                    for (int i = 0; i < 60 && await Js("!!document.querySelector('#rPicks')") != "true"; i++) await Task.Delay(500);
                    await Task.Delay(800);
                    await Capture("desktop-read.png");
                    await Js("Settings.open('downloads')"); await Task.Delay(700);
                    await Js("document.querySelector('[data-sa=browse]').click()");
                    string picked = "";
                    for (int i = 0; i < 40 && picked == ""; i++) { await Task.Delay(500); picked = await Js("(document.getElementById('sOut')||{dataset:{}}).dataset.picked||''"); }
                    File.WriteAllText(Path.Combine(dir, "picker.txt"), picked);
                    await Task.Delay(400);
                    await Capture("desktop-settings.png");
                    await Js("document.getElementById('dlgSet').close()");
                    await Js("App.go('stitch')"); await Task.Delay(300);
                    await Js("Settings.open('stitch')"); await Task.Delay(500);
                    await Capture("desktop-settings-stitch.png");
                    await Js("document.getElementById('dlgSet').close();App.go('rip')");
                    File.WriteAllText(Path.Combine(dir, "read-done.txt"), "ok");
                }
                await Task.Delay(400);
            }
            await Task.Delay(1500);
            await Capture("desktop-final.png");
            confirmedClose = true;
            Close();
        }
    }
}
