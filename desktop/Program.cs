using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace RipStitch
{
    /// <summary>
    /// RipStitch for Windows. On first launch the embedded payload (Python, yt-dlp, FFmpeg, Deno,
    /// the engine and the site) is unpacked to %LOCALAPPDATA%\RipStitch\Desktop\app-BUILD. After that,
    /// every launch starts a private engine on 127.0.0.1:8741 and shows the app in a native window.
    /// </summary>
    static class Program
    {
        public const int Port = 8741;
        public static readonly string Base = "http://127.0.0.1:" + Port;
        public static readonly string Home = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RipStitch", "Desktop");
        public static string Root;          // unpacked runtime for this build
        public static string SmokeDir;      // CI self-test output folder (--smoke DIR)
        public static Process Engine;       // the engine this window started (null when reusing one)
        public static Icon AppIcon;

        [STAThread]
        static int Main(string[] args)
        {
            for (int i = 0; i < args.Length - 1; i++)
                if (args[i] == "--smoke") SmokeDir = Path.GetFullPath(args[i + 1]);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try { AppIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { AppIcon = SystemIcons.Application; }

            try
            {
                Directory.CreateDirectory(Home);
                Root = EnsureRuntime();
                if (Root == null) return 1;
                AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
                {
                    var p = Path.Combine(Root, "wv2", new AssemblyName(e.Name).Name + ".dll");
                    return File.Exists(p) ? Assembly.LoadFrom(p) : null;
                };
                return RunWindow();
            }
            catch (Exception ex)
            {
                Log("fatal: " + ex);
                if (SmokeDir == null)
                    MessageBox.Show("RipStitch couldn't start:\n\n" + ex.Message, "RipStitch", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally { StopEngine(); }
        }

        // Kept separate so the WebView2 assemblies load only after the resolver above is in place.
        [MethodImpl(MethodImplOptions.NoInlining)]
        static int RunWindow()
        {
            var form = new MainForm();
            Application.Run(form);
            return form.ExitCode;
        }

        // ------------------------------------------------------------------ first-run unpacking
        static string ReadResource(string name)
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (s == null) return null;
                using (var r = new StreamReader(s)) return r.ReadToEnd();
            }
        }

        static string EnsureRuntime()
        {
            var build = (ReadResource("build.txt") ?? "dev").Trim();
            var root = Path.Combine(Home, "app-" + Regex.Replace(build, @"[^\w.-]", "_"));
            if (File.Exists(Path.Combine(root, ".ready"))) return root;

            Exception error = null;
            using (var setup = new SetupForm())
            {
                setup.Work = () => Unpack(root, setup.Report);
                Application.Run(setup);
                error = setup.Error;
            }
            if (error != null) throw new Exception("Unpacking failed: " + error.Message, error);

            foreach (var old in Directory.GetDirectories(Home, "app-*"))
                if (!string.Equals(old, root, StringComparison.OrdinalIgnoreCase) && !old.EndsWith(".tmp"))
                    try { Directory.Delete(old, true); } catch { /* still in use by another window */ }
            return root;
        }

        static void Unpack(string root, Action<double> report)
        {
            var tmp = root + ".tmp";
            if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
            Directory.CreateDirectory(tmp);
            var tmpFull = Path.GetFullPath(tmp) + Path.DirectorySeparatorChar;
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (s == null) throw new Exception("this build has no payload");
                using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
                {
                    long total = Math.Max(1, zip.Entries.Sum(e => e.Length)), done = 0;
                    foreach (var e in zip.Entries)
                    {
                        var dest = Path.GetFullPath(Path.Combine(tmp, e.FullName.Replace('/', '\\')));
                        if (!dest.StartsWith(tmpFull, StringComparison.OrdinalIgnoreCase)) continue;
                        if (e.FullName.EndsWith("/") || e.FullName.EndsWith("\\")) { Directory.CreateDirectory(dest); continue; }
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        e.ExtractToFile(dest, true);
                        done += e.Length;
                        report((double)done / total);
                    }
                }
            }
            if (Directory.Exists(root)) Directory.Delete(root, true);
            Directory.Move(tmp, root);
            File.WriteAllText(Path.Combine(root, ".ready"), DateTime.Now.ToString("o"));
        }

        // ------------------------------------------------------------------ the private engine
        public static bool Ping()
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(Base + "/api/ping");
                req.Proxy = null; req.Timeout = 1500;
                using (var r = (HttpWebResponse)req.GetResponse()) return r.StatusCode == HttpStatusCode.OK;
            }
            catch { return false; }
        }

        public static string Get(string path)
        {
            var req = (HttpWebRequest)WebRequest.Create(Base + path);
            req.Proxy = null; req.Timeout = 3000;
            using (var r = req.GetResponse())
            using (var sr = new StreamReader(r.GetResponseStream(), Encoding.UTF8)) return sr.ReadToEnd();
        }

        public static void StartEngine()
        {
            if (Ping()) { Log("reusing the engine already on " + Base); return; }
            var psi = new ProcessStartInfo(Path.Combine(Root, "python", "pythonw.exe"),
                "\"" + Path.Combine(Root, "engine", "ripstitch_engine.py") + "\" --background --port " + Port)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Root,
            };
            psi.EnvironmentVariables["RIPSTITCH_HOME"] = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RipStitch", "Desktop");
            Engine = Process.Start(psi);
            Log("engine started, pid " + Engine.Id);
        }

        public static bool WaitForEngine(int ms)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < ms)
            {
                if (Ping()) return true;
                if (Engine != null && Engine.HasExited) return false;
                Thread.Sleep(250);
            }
            return false;
        }

        public static int ActiveDownloads()
        {
            try { return Regex.Matches(Get("/api/jobs"), "\"status\": \"(queued|running|merging)\"").Count; }
            catch { return 0; }
        }

        public static void StopEngine()
        {
            var p = Engine; Engine = null;
            if (p == null) return;
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(Base + "/api/shutdown");
                req.Method = "POST"; req.ContentType = "application/json"; req.Proxy = null; req.Timeout = 3000;
                var body = Encoding.UTF8.GetBytes("{}");
                req.ContentLength = body.Length;
                using (var s = req.GetRequestStream()) s.Write(body, 0, body.Length);
                using (req.GetResponse()) { }
            }
            catch { }
            try { if (!p.WaitForExit(6000)) p.Kill(); } catch { }
        }

        public static string EngineLog => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RipStitch", "Desktop", "engine.log");

        public static void Log(string msg)
        {
            try { File.AppendAllText(Path.Combine(Home, "desktop.log"), DateTime.Now.ToString("s") + "  " + msg + Environment.NewLine); } catch { }
        }
    }

    /// <summary>Small first-launch window with a progress bar while the payload unpacks.</summary>
    sealed class SetupForm : Form
    {
        public Action Work;
        public Exception Error;
        readonly ProgressBar bar;
        int last = -1;

        public SetupForm()
        {
            Text = "RipStitch";
            Icon = Program.AppIcon;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false; MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(460, 150);
            BackColor = Color.FromArgb(16, 20, 26);
            ForeColor = Color.FromArgb(232, 237, 243);
            var title = new Label { Text = "Setting up RipStitch", Font = new Font("Segoe UI Semibold", 13f), AutoSize = true, Location = new Point(22, 20) };
            var sub = new Label
            {
                Text = "First launch only: unpacking the engine, yt-dlp, FFmpeg and Deno.",
                Font = new Font("Segoe UI", 9f), ForeColor = Color.FromArgb(127, 138, 154), AutoSize = true, Location = new Point(24, 56)
            };
            bar = new ProgressBar { Location = new Point(24, 92), Size = new Size(412, 12), Maximum = 1000, Style = ProgressBarStyle.Continuous };
            Controls.Add(title); Controls.Add(sub); Controls.Add(bar);
            Shown += (s, e) => Task.Run(() =>
            {
                try { Work(); } catch (Exception ex) { Error = ex; }
            }).ContinueWith(_ => BeginInvoke(new Action(Close)));
        }

        public void Report(double f)
        {
            var v = (int)(Math.Min(1, Math.Max(0, f)) * 1000);
            if (v - last < 5 || !IsHandleCreated) return;
            last = v;
            BeginInvoke(new Action(() => bar.Value = v));
        }
    }
}
