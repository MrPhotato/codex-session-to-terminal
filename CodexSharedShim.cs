using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// Build with Framework64 csc.exe /r:System.Web.Extensions.dll. No app files patched.
public static class CodexSharedShim
{
    // Also works when a desktop tool keeps CODEX_CLI_PATH but filters our config
    // variable. Prepare generates this local path after exact version checking.
    // The generated file lives in protected local build output, outside source.
    const string FallbackCliPath = SharedShimPaths.Cli;
    static readonly HashSet<string> GlobalValues = new HashSet<string> {
        "-c", "--config", "--enable", "--disable", "-m", "--model", "-p", "--profile",
        "-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval", "--remote",
        "--remote-bearer-token", "--add-dir", "-i", "--image"
    };
    static readonly HashSet<string> ServerValues = new HashSet<string> {
        "-c", "--config", "--enable", "--disable", "--listen", "--code-mode-host",
        "--ws-auth", "--ws-token-file", "--ws-token-sha256", "--ws-shared-secret-file",
        "--ws-issuer", "--ws-audience", "--ws-max-clock-skew-seconds"
    };

    static string Field(Dictionary<string, object> config, string key, string fallback = null)
    {
        object value;
        return config.TryGetValue(key, out value) && value is string ? (string)value : fallback;
    }

    static bool IsMainBackend(string[] args, string originator)
    {
        if (Environment.GetEnvironmentVariable("CODEX_INTERNAL_ORIGINATOR_OVERRIDE") != originator) return false;
        foreach (string arg in args) {
            if (arg == "--stdio" || arg == "--listen" || arg.StartsWith("--listen=") || arg.StartsWith("--ws-")) return false;
        }
        int command = -1;
        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "--") return false;
            if (GlobalValues.Contains(args[i])) { i++; continue; }
            if (args[i].StartsWith("-")) continue;
            command = i; break;
        }
        if (command < 0 || args[command] != "app-server") return false;
        for (int i = command + 1; i < args.Length; i++) {
            if (ServerValues.Contains(args[i])) { i++; continue; }
            if (!args[i].StartsWith("-") || args[i] == "--help" || args[i] == "-h") return false;
        }
        return true;
    }

    // Windows CommandLineToArgvW-compatible quoting, including trailing slashes.
    static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(ch);
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    static async Task Pump(Stream source, Stream destination)
    {
        byte[] buffer = new byte[16384];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) > 0) {
            await destination.WriteAsync(buffer, 0, count);
            await destination.FlushAsync();
        }
    }

    public static int Main(string[] args)
    {
        IntPtr job = IntPtr.Zero;
        Mutex ownership = null;
        bool ownsEndpoint = false;
        Process child = null;
        try {
            string configPath = Environment.GetEnvironmentVariable("CODEX_SHARED_SESSION_CONFIG");
            var config = new Dictionary<string, object>();
            bool hasConfig = !String.IsNullOrEmpty(configPath);
            if (hasConfig) {
                if (!Path.IsPathRooted(configPath)) throw new InvalidOperationException();
                config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath));
            }
            bool mainBackend = hasConfig && IsMainBackend(args, Field(config, "interceptOriginator", "Codex Desktop"));
            string realCliPath = Field(config, "realCliPath", FallbackCliPath);
            if (!Path.IsPathRooted(realCliPath) || !File.Exists(realCliPath)) throw new InvalidOperationException();
            string executable = realCliPath;
            var command = new StringBuilder();
            if (mainBackend) {
                string root = Field(config, "root");
                if (String.IsNullOrEmpty(root) || !Path.IsPathRooted(root)) throw new InvalidOperationException();
                string canonical = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).ToUpperInvariant();
                string mutexName;
                using (SHA256 hash = SHA256.Create()) {
                    mutexName = @"Local\CodexSharedSession_" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(canonical))).Replace("-", "");
                }
                ownership = new Mutex(false, mutexName);
                try { ownsEndpoint = ownership.WaitOne(0); }
                catch (AbandonedMutexException) { ownsEndpoint = true; }
                if (!ownsEndpoint) {
                    Console.Error.WriteLine("[codex shared-session shim] Another Desktop bridge already owns this endpoint.");
                    return 1;
                }
                string nodePath = Field(config, "nodePath");
                string bridgePath = Field(config, "bridgePath", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bridge-shim.mjs"));
                if (String.IsNullOrEmpty(nodePath) || !Path.IsPathRooted(nodePath) || !File.Exists(nodePath) || !Path.IsPathRooted(bridgePath) || !File.Exists(bridgePath)) throw new InvalidOperationException();
                executable = nodePath;
                command.Append(Quote(bridgePath));
                job = CreateKillOnCloseJob();
            }
            foreach (string arg in args) {
                if (command.Length > 0) command.Append(' ');
                command.Append(Quote(arg));
            }
            bool redirect = Console.IsInputRedirected || Console.IsOutputRedirected || Console.IsErrorRedirected;
            var start = new ProcessStartInfo(executable, command.ToString()) {
                UseShellExecute = false, CreateNoWindow = redirect,
                RedirectStandardInput = redirect, RedirectStandardOutput = redirect, RedirectStandardError = redirect
            };
            start.EnvironmentVariables["CODEX_SHARED_SHIM_PID"] = Process.GetCurrentProcess().Id.ToString();
            if (!mainBackend) start.EnvironmentVariables["CODEX_CLI_PATH"] = realCliPath;
            child = Process.Start(start);
            if (child == null) throw new InvalidOperationException();
            if (job != IntPtr.Zero && !AssignProcessToJobObject(job, child.Handle)) {
                try { child.Kill(); child.WaitForExit(); } catch { }
                throw new InvalidOperationException();
            }
            Task output = null, error = null;
            if (redirect) {
                output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                error = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
                Task.Run(async delegate {
                    try { await Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                    catch { }
                    finally { try { child.StandardInput.Close(); } catch { } }
                });
            }
            child.WaitForExit();
            if (redirect) { try { Task.WaitAll(new Task[] { output, error }); } catch { } }
            return child.ExitCode;
        }
        catch {
            Console.Error.WriteLine("[codex shared-session shim] Could not start the configured CLI bridge.");
            return 1;
        }
        finally {
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child != null) child.Dispose();
            if (ownsEndpoint) ownership.ReleaseMutex();
            if (ownership != null) ownership.Dispose();
        }
    }

    static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException();
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(length);
        try {
            Marshal.StructureToPtr(info, pointer, false);
            if (!SetInformationJobObject(job, 9, pointer, (uint)length)) { CloseHandle(job); throw new InvalidOperationException(); }
        }
        finally { Marshal.FreeHGlobal(pointer); }
        return job;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
}
