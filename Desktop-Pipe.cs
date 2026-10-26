using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
using CstDesktopNavigation;

namespace CstDesktopPipe
{
    // No UI, app launch, credentials, owner registration or message dispatch.
    // Package/user verification and traffic use the same open pipe handle.
    public static class Program
    {
        private static readonly Regex AppTools = new Regex(@"\Acodex-app-tools-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private delegate int ReadPackageString(ref uint length, StringBuilder value);

        public static bool ValidPipeName(string name)
        {
            return String.Equals(name, "codex-ipc", StringComparison.OrdinalIgnoreCase) || name != null && AppTools.IsMatch(name);
        }

        private static string ReadPackageValue(ReadPackageString read, uint maximum)
        {
            uint length = 0;
            if (read(ref length, null) != 122 || length < 2 || length > maximum) throw new IOException("Invalid Desktop package identity.");
            StringBuilder value = new StringBuilder((int)length);
            if (read(ref length, value) != 0) throw new IOException("Cannot read Desktop package identity.");
            return value.ToString();
        }

        private static void Verify(NamedPipeClientStream pipe)
        {
            uint pid;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid)) throw new IOException("Cannot identify Desktop pipe owner.");
            IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
            if (process == IntPtr.Zero) throw new IOException("Cannot inspect Desktop pipe owner.");
            try
            {
                uint size = 32768; StringBuilder path = new StringBuilder((int)size);
                if (!QueryFullProcessImageName(process, 0, path, ref size)) throw new IOException("Cannot inspect Desktop executable.");
                WindowIdentity identity = new WindowIdentity();
                identity.ExecutablePath = path.ToString();
                identity.PackageFullName = ReadPackageValue(delegate(ref uint length, StringBuilder value) { return GetPackageFullName(process, ref length, value); }, 1024);
                identity.PackageFamilyName = ReadPackageValue(delegate(ref uint length, StringBuilder value) { return GetPackageFamilyName(process, ref length, value); }, 1024);
                identity.PackageRoot = ReadPackageValue(delegate(ref uint length, StringBuilder value) { return GetPackagePathByFullName(identity.PackageFullName, ref length, value); }, 32768);
                if (!Navigation.ValidPackageIdentity(identity)) throw new IOException("Pipe owner is not the installed ChatGPT Desktop.");
                if (!OpenProcessToken(process, 8, out token)) throw new IOException("Cannot inspect Desktop user.");
                using (WindowsIdentity peer = new WindowsIdentity(token))
                using (WindowsIdentity current = WindowsIdentity.GetCurrent())
                {
                    if (peer.User == null || !peer.User.Equals(current.User)) throw new IOException("Desktop belongs to a different Windows user.");
                }
                uint exitCode;
                if (!GetExitCodeProcess(process, out exitCode) || exitCode != 259) throw new IOException("Desktop exited during verification.");
            }
            finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
        }

        private static async Task<NamedPipeClientStream> Connect(string pipeName)
        {
            if (!ValidPipeName(pipeName)) throw new ArgumentException("Unsupported Desktop pipe.");
            // Identification prevents an unverified same-name server from
            // impersonating this Windows user while accepting the connection.
            NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
                PipeOptions.Asynchronous, TokenImpersonationLevel.Identification);
            try { await pipe.ConnectAsync(8000); Verify(pipe); return pipe; }
            catch { pipe.Dispose(); throw; }
        }

        public static async Task CopyToStdout(Stream input)
        {
            IntPtr output = GetStdHandle(-11);
            if (output == IntPtr.Zero || output == new IntPtr(-1)) throw new IOException("Binary output is unavailable.");
            byte[] buffer = new byte[81920]; GCHandle pinned = GCHandle.Alloc(buffer, GCHandleType.Pinned);
            try
            {
                int count;
                while ((count = await input.ReadAsync(buffer, 0, buffer.Length)) != 0)
                {
                    int offset = 0; Stopwatch stalled = Stopwatch.StartNew();
                    while (offset < count)
                    {
                        uint written;
                        if (!WriteFile(output, IntPtr.Add(pinned.AddrOfPinnedObject(), offset), (uint)(count - offset), out written, IntPtr.Zero))
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        if (written > count - offset) throw new IOException("Invalid output byte count.");
                        if (written == 0)
                        {
                            if (stalled.ElapsedMilliseconds > 30000) throw new IOException("Binary output remained blocked.");
                            await Task.Delay(1);
                        }
                        else { offset += (int)written; stalled.Restart(); }
                    }
                }
            }
            finally { pinned.Free(); }
        }

        private static async Task Relay(string pipeName)
        {
            using (NamedPipeClientStream pipe = await Connect(pipeName))
            {
                Console.Error.WriteLine("CST_PIPE_VERIFIED"); Console.Error.Flush();
                Task upstream = Console.OpenStandardInput().CopyToAsync(pipe), downstream = CopyToStdout(pipe);
                await await Task.WhenAny(upstream, downstream);
            }
        }

        private static async Task Discover()
        {
            string selected = null;
            foreach (string path in Directory.GetFiles(@"\\.\pipe\"))
            {
                string name = Path.GetFileName(path);
                if (!AppTools.IsMatch(name)) continue;
                if (selected != null) throw new IOException("More than one Desktop endpoint is available.");
                selected = name;
            }
            if (selected == null) throw new IOException("Desktop endpoint is unavailable.");
            using (NamedPipeClientStream pipe = await Connect(selected))
            {
                // The strict pipe-name vocabulary contains no JSON escapes.
                Console.Out.WriteLine("{\"pipeName\":\"" + selected + "\"}");
            }
        }

        public static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--check")
            { Console.WriteLine("{\"version\":1,\"ready\":true}"); return 0; }
            try
            {
                if (args.Length == 1 && args[0] == "--discover-app-tools") Discover().GetAwaiter().GetResult();
                else if (args.Length == 2 && args[0] == "--pipe" && ValidPipeName(args[1])) Relay(args[1]).GetAwaiter().GetResult();
                else throw new ArgumentException("Unsupported arguments.");
                return 0;
            }
            catch { Console.Error.WriteLine("Codex Session to Terminal could not verify the Desktop connection."); return 1; }
        }

        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int handle);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool WriteFile(IntPtr handle, IntPtr buffer, uint length, out uint written, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder value);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder value);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetPackagePathByFullName(string fullName, ref uint length, StringBuilder value);
    }
}
