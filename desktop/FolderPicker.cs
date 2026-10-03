// The modern Windows "Select Folder" dialog (IFileOpenDialog with FOS_PICKFOLDERS).
// Shared by RipStitch Desktop and the RipStitch Engine, which compiles this same text through
// PowerShell's Add-Type (C# 5), so it sticks to C# 5. tests/test_engine.py keeps the two copies equal.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace RipStitch
{
    public static class FolderPicker
    {
        /// <summary>Shows the picker over a window. Returns the chosen folder, or null if cancelled.
        /// autoAcceptMs is only for automated tests: it presses Select Folder after that delay.</summary>
        public static string Pick(IntPtr owner, string start, string title, int autoAcceptMs)
        {
            IFileDialog dlg = (IFileDialog)new FileOpenDialogCom();
            Timer timer = null;
            try
            {
                uint opts;
                dlg.GetOptions(out opts);
                dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
                if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
                IShellItem folder = ItemFor(start);
                if (folder != null) dlg.SetFolder(folder);
                if (autoAcceptMs > 0)
                {
                    int ticks = 0;
                    timer = new Timer();
                    timer.Interval = autoAcceptMs;
                    timer.Tick += delegate
                    {
                        ticks++;
                        IntPtr h = FindDialog();
                        if (ticks <= 3 && h != IntPtr.Zero) PostMessage(h, WM_COMMAND, (IntPtr)IDOK, IntPtr.Zero);
                        else if (ticks > 3) { timer.Stop(); dlg.Close(ERROR_CANCELLED); }
                    };
                    timer.Start();
                }
                int hr = dlg.Show(owner);
                if (hr == ERROR_CANCELLED) return null;
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                IShellItem result;
                dlg.GetResult(out result);
                string path;
                result.GetDisplayName(SIGDN_FILESYSPATH, out path);
                return path;
            }
            finally
            {
                if (timer != null) timer.Dispose();
                Marshal.ReleaseComObject(dlg);
            }
        }

        /// <summary>For a background process (the engine): the picker above every other window,
        /// with a taskbar button so it can't get lost behind the browser.</summary>
        public static string PickOnTop(string start, string title, int autoAcceptMs)
        {
            using (Form f = new Form())
            {
                f.Text = string.IsNullOrEmpty(title) ? "Choose a folder" : title;
                f.FormBorderStyle = FormBorderStyle.None;
                f.StartPosition = FormStartPosition.CenterScreen;
                f.Size = new System.Drawing.Size(1, 1);
                f.Opacity = 0;
                f.TopMost = true;
                f.Show();
                SetForegroundWindow(f.Handle);
                return Pick(f.Handle, start, title, autoAcceptMs);
            }
        }

        static IShellItem ItemFor(string path)
        {
            try
            {
                while (!string.IsNullOrEmpty(path) && !System.IO.Directory.Exists(path)) path = System.IO.Path.GetDirectoryName(path);
                if (string.IsNullOrEmpty(path)) return null;
                Guid iid = typeof(IShellItem).GUID;
                IShellItem item;
                SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
                return item;
            }
            catch { return null; }
        }

        static IntPtr FindDialog()
        {
            IntPtr found = IntPtr.Zero;
            EnumThreadWindows(GetCurrentThreadId(), delegate (IntPtr h, IntPtr l)
            {
                StringBuilder cls = new StringBuilder(64);
                GetClassName(h, cls, cls.Capacity);
                if (cls.ToString() == "#32770" && IsWindowVisible(h)) { found = h; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint threadId, EnumWindowsProc callback, IntPtr lParam);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(string path, IntPtr bindCtx, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

        const uint FOS_NOCHANGEDIR = 0x8, FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
        const uint SIGDN_FILESYSPATH = 0x80058000;
        const uint WM_COMMAND = 0x0111;
        const int IDOK = 1;
        const int ERROR_CANCELLED = unchecked((int)0x800704C7);

        [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        class FileOpenDialogCom { }

        [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IFileDialog
        {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint count, IntPtr filterSpecs);
            void SetFileTypeIndex(uint index);
            void GetFileTypeIndex(out uint index);
            void Advise(IntPtr events, out uint cookie);
            void Unadvise(uint cookie);
            void SetOptions(uint options);
            void GetOptions(out uint options);
            void SetDefaultFolder(IShellItem item);
            void SetFolder(IShellItem item);
            void GetFolder(out IShellItem item);
            void GetCurrentSelection(out IShellItem item);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
            void GetResult(out IShellItem item);
            void AddPlace(IShellItem item, int where);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
            void Close(int hr);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr filter);
        }

        [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItem
        {
            void BindToHandler(IntPtr bindCtx, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem parent);
            void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
            void GetAttributes(uint mask, out uint attributes);
            void Compare(IShellItem other, uint hint, out int order);
        }
    }
}
