#requires -Version 7.4
# Private binary transport: stdout must contain only framed Desktop IPC bytes.
$ErrorActionPreference = 'Stop'
try {
    $allowed = @(Get-AppxPackage -Name 'OpenAI.Codex' | ForEach-Object {
        Join-Path $_.InstallLocation 'app\ChatGPT.exe'
    })
    if (!$allowed.Count) { throw 'The installed OpenAI.Codex package was not found.' }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class CstVerifiedPipe {
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Verify(NamedPipeClientStream pipe, string[] allowed) {
        uint pid;
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid)) throw new IOException("Cannot identify the Desktop pipe owner.");
        IntPtr process = OpenProcess(0x1000, false, pid), token = IntPtr.Zero;
        if (process == IntPtr.Zero) throw new IOException("Cannot inspect the Desktop pipe owner.");
        try {
            uint size = 32768; var name = new StringBuilder((int)size);
            if (!QueryFullProcessImageName(process, 0, name, ref size)) throw new IOException("Cannot verify the Desktop executable.");
            bool found = false;
            foreach (var path in allowed) if (String.Equals(Path.GetFullPath(path), name.ToString(), StringComparison.OrdinalIgnoreCase)) found = true;
            if (!found) throw new IOException("The local pipe is not owned by the installed ChatGPT Desktop.");
            if (!OpenProcessToken(process, 8, out token)) throw new IOException("Cannot verify the Desktop user.");
            using (var peer = new WindowsIdentity(token)) using (var current = WindowsIdentity.GetCurrent()) {
                if (peer.User == null || !peer.User.Equals(current.User)) throw new IOException("The Desktop pipe belongs to another Windows user.");
            }
        } finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
    }
    public static async Task Run(string[] allowed) {
        // A same-name hostile server must not be able to impersonate this user
        // while we are still establishing and verifying the connection.
        using (var pipe = new NamedPipeClientStream(".", "codex-ipc", PipeDirection.InOut, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification)) {
            await pipe.ConnectAsync(8000);
            Verify(pipe, allowed); // Same handle used for verification and all subsequent traffic.
            Console.Error.WriteLine("CST_PIPE_VERIFIED");
            Console.Error.Flush();
            var input = Console.OpenStandardInput(); var output = Console.OpenStandardOutput();
            var upstream = input.CopyToAsync(pipe); var downstream = pipe.CopyToAsync(output);
            var completed = await Task.WhenAny(upstream, downstream);
            await completed;
            await output.FlushAsync();
        }
    }
}
'@
    [CstVerifiedPipe]::Run([string[]]$allowed).GetAwaiter().GetResult()
} catch {
    [Console]::Error.WriteLine('CST Desktop connection failed: ' + $_.Exception.Message)
    exit 1
}
