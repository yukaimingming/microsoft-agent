using System.Diagnostics;
using System.Text;

namespace MafHarness.Web.Services;

public sealed class GitService
{
    private readonly WorkspaceService _workspaceService;

    public GitService(WorkspaceService workspaceService)
    {
        _workspaceService = workspaceService;
    }

    public Dictionary<string, object> GetStatus(string? root)
    {
        var targetDir = ResolveRoot(root);
        var result = new Dictionary<string, object>
        {
            ["ok"] = true,
            ["root"] = targetDir.Replace('\\', '/')
        };

        if (!Directory.Exists(Path.Combine(targetDir, ".git")))
        {
            result["isGitRepo"] = false;
            result["branch"] = "";
            result["files"] = new List<object>();
            return result;
        }

        result["isGitRepo"] = true;
        var branchOutput = RunCommand("git rev-parse --abbrev-ref HEAD", targetDir);
        result["branch"] = branchOutput.Trim();

        var statusOutput = RunCommand("git status --porcelain=v1", targetDir);
        var files = new List<Dictionary<string, object>>();

        foreach (var line in statusOutput.Split('\n'))
        {
            if (line.Length < 3) continue;
            var indexState = line[0];
            var workState = line[1];
            var path = line[3..].Trim().Replace('\\', '/');

            string status = "modified";
            if (indexState == '?' && workState == '?') status = "untracked";
            else if (indexState == 'A' || workState == 'A') status = "added";
            else if (indexState == 'D' || workState == 'D') status = "deleted";

            files.Add(new Dictionary<string, object>
            {
                ["path"] = path,
                ["status"] = status,
                ["staged"] = indexState != ' ' && indexState != '?'
            });
        }

        result["files"] = files;
        return result;
    }

    public Dictionary<string, object> GetFileDiff(string? root, string path, bool staged, string? commit)
    {
        var targetDir = ResolveRoot(root);
        var args = staged ? $"diff --cached -- \"{path}\"" : $"diff -- \"{path}\"";
        if (!string.IsNullOrWhiteSpace(commit))
        {
            args = $"diff {commit}^ {commit} -- \"{path}\"";
        }

        var diffOutput = RunCommand($"git {args}", targetDir);
        var fullPath = Path.Combine(targetDir, path);
        var isImage = path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
                   || path.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)
                   || path.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase);

        return new Dictionary<string, object>
        {
            ["ok"] = true,
            ["path"] = path,
            ["isImage"] = isImage,
            ["diff"] = diffOutput,
            ["exists"] = File.Exists(fullPath)
        };
    }

    public Dictionary<string, object> Commit(string? root, string message, List<string>? files)
    {
        var targetDir = ResolveRoot(root);
        if (files != null && files.Count > 0)
        {
            foreach (var f in files)
            {
                RunCommand($"git add \"{f}\"", targetDir);
            }
        }
        else
        {
            RunCommand("git add -A", targetDir);
        }

        var safeMsg = message.Replace("\"", "\\\"");
        var output = RunCommand($"git commit -m \"{safeMsg}\"", targetDir);
        return new Dictionary<string, object>
        {
            ["ok"] = true,
            ["output"] = output
        };
    }

    public Dictionary<string, object> ReadFileContent(string? root, string path)
    {
        var targetDir = ResolveRoot(root);
        var full = Path.GetFullPath(Path.Combine(targetDir, path));

        if (!File.Exists(full))
        {
            return new Dictionary<string, object>
            {
                ["ok"] = false,
                ["error"] = "文件不存在"
            };
        }

        return new Dictionary<string, object>
        {
            ["ok"] = true,
            ["content"] = File.ReadAllText(full)
        };
    }

    public Dictionary<string, object> ExecuteTerminalCommand(string? root, string command)
    {
        var targetDir = ResolveRoot(root);
        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -ExecutionPolicy Bypass -Command \"{command.Replace("\"", "\\\"")}\"",
            WorkingDirectory = targetDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };

        using var proc = Process.Start(psi);
        if (proc == null)
        {
            return new Dictionary<string, object>
            {
                ["ok"] = false,
                ["output"] = "启动终端进程失败",
                ["exitCode"] = -1
            };
        }

        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit(30000);

        var output = string.IsNullOrWhiteSpace(stderr) ? stdout : $"{stdout}\n{stderr}".Trim();

        return new Dictionary<string, object>
        {
            ["ok"] = proc.ExitCode == 0,
            ["output"] = output,
            ["exitCode"] = proc.ExitCode
        };
    }

    private string ResolveRoot(string? root)
    {
        return !string.IsNullOrWhiteSpace(root)
            ? Path.GetFullPath(root)
            : _workspaceService.CurrentWorkspaceRoot;
    }

    private static string RunCommand(string commandLine, string workingDir)
    {
        try
        {
            var parts = commandLine.Split(' ', 2);
            var exe = parts[0];
            var args = parts.Length > 1 ? parts[1] : "";

            var psi = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = args,
                WorkingDirectory = workingDir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };

            using var proc = Process.Start(psi);
            if (proc == null) return string.Empty;

            var stdout = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(10000);
            return stdout;
        }
        catch (Exception ex)
        {
            return $"[Command Error] {ex.Message}";
        }
    }
}
