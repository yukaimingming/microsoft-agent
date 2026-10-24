using MafHarness.Web.Models;

namespace MafHarness.Web.Services;

public sealed class WorkspaceService
{
    private string _currentWorkspaceRoot;

    public WorkspaceService(IConfiguration configuration)
    {
        var configured = configuration["Workspace:Root"] ?? configuration["FileAccess:WorkspaceRoot"];
        _currentWorkspaceRoot = ResolveWorkspaceRoot(configured);
        Directory.CreateDirectory(_currentWorkspaceRoot);
    }

    /// <summary>
    /// 解析本地根目录下的 workspace 目录，杜绝落入系统盘根目录。
    /// </summary>
    public static string ResolveWorkspaceRoot(string? configured)
    {
        // 1. 若显式配置了绝对路径，直接使用
        if (!string.IsNullOrWhiteSpace(configured) && Path.IsPathRooted(configured))
        {
            return Path.GetFullPath(configured);
        }

        var folderName = string.IsNullOrWhiteSpace(configured) ? "workspace" : configured.Trim();

        // 2. 向上探测 Git 仓库根目录或本地项目根目录（包含 .git，或同时包含 backend 和 frontend）
        var candidate = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (candidate != null)
        {
            if (Directory.Exists(Path.Combine(candidate.FullName, ".git")) ||
                (Directory.Exists(Path.Combine(candidate.FullName, "backend")) && Directory.Exists(Path.Combine(candidate.FullName, "frontend"))))
            {
                return Path.GetFullPath(Path.Combine(candidate.FullName, folderName));
            }
            candidate = candidate.Parent;
        }

        // 3. 基于 AppContext.BaseDirectory 向上探测（应对从 bin/Debug 目录下直接执行）
        var appBase = new DirectoryInfo(AppContext.BaseDirectory);
        while (appBase != null)
        {
            if (Directory.Exists(Path.Combine(appBase.FullName, ".git")) ||
                (Directory.Exists(Path.Combine(appBase.FullName, "backend")) && Directory.Exists(Path.Combine(appBase.FullName, "frontend"))))
            {
                return Path.GetFullPath(Path.Combine(appBase.FullName, folderName));
            }
            appBase = appBase.Parent;
        }

        // 4. 若未找到仓库根，尝试查找已存在的 workspace 目录
        var current = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (current != null)
        {
            var wsCandidate = Path.Combine(current.FullName, folderName);
            if (Directory.Exists(wsCandidate) && !string.Equals(current.Name, "backend", StringComparison.OrdinalIgnoreCase))
            {
                return Path.GetFullPath(wsCandidate);
            }
            current = current.Parent;
        }

        return Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), folderName));
    }

    public string CurrentWorkspaceRoot => _currentWorkspaceRoot;

    public void SetCurrentWorkspaceRoot(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        var full = Path.GetFullPath(path);
        Directory.CreateDirectory(full);
        _currentWorkspaceRoot = full;
    }

    public List<Dictionary<string, object>> GetWorkspaceTree(string root, int depth)
    {
        var fullRoot = Path.GetFullPath(string.IsNullOrWhiteSpace(root) ? _currentWorkspaceRoot : root);
        if (!Directory.Exists(fullRoot))
        {
            Directory.CreateDirectory(fullRoot);
        }

        return BuildDirectoryTree(new DirectoryInfo(fullRoot), depth, 1);
    }

    private List<Dictionary<string, object>> BuildDirectoryTree(DirectoryInfo dir, int maxDepth, int currentDepth)
    {
        var list = new List<Dictionary<string, object>>();
        try
        {
            foreach (var d in dir.GetDirectories().OrderBy(x => x.Name))
            {
                if (d.Name.StartsWith('.') || d.Name is "bin" or "obj" or "node_modules") continue;

                var node = new Dictionary<string, object>
                {
                    ["name"] = d.Name,
                    ["path"] = d.FullName.Replace('\\', '/'),
                    ["type"] = "directory"
                };

                if (currentDepth < maxDepth)
                {
                    node["children"] = BuildDirectoryTree(d, maxDepth, currentDepth + 1);
                }
                list.Add(node);
            }

            foreach (var f in dir.GetFiles().OrderBy(x => x.Name))
            {
                if (f.Name.StartsWith('.')) continue;

                list.Add(new Dictionary<string, object>
                {
                    ["name"] = f.Name,
                    ["path"] = f.FullName.Replace('\\', '/'),
                    ["type"] = "file",
                    ["size"] = f.Length
                });
            }
        }
        catch
        {
            // 权限或访问异常忽略
        }
        return list;
    }

    public void Mkdir(string? parentDir, string dirName)
    {
        var parent = string.IsNullOrWhiteSpace(parentDir) ? _currentWorkspaceRoot : Path.GetFullPath(parentDir);
        var target = Path.Combine(parent, dirName.Trim());
        Directory.CreateDirectory(target);
    }

    public BrowseResultDto Browse(string? path)
    {
        var target = !string.IsNullOrWhiteSpace(path) ? Path.GetFullPath(path) : _currentWorkspaceRoot;
        if (!Directory.Exists(target))
        {
            try
            {
                Directory.CreateDirectory(target);
            }
            catch
            {
                target = _currentWorkspaceRoot;
            }
        }

        var result = new BrowseResultDto
        {
            Ok = true,
            Current = target,
            Parent = GetParentDirectory(target),
            Folders = [],
            QuickPaths = GetQuickPaths()
        };

        try
        {
            var di = new DirectoryInfo(target);
            foreach (var d in di.GetDirectories().OrderBy(x => x.Name))
            {
                if (d.Name.StartsWith('.') || d.Name is "bin" or "obj" or "node_modules" or "$RECYCLE.BIN" or "System Volume Information")
                    continue;

                result.Folders.Add(new BrowseFolderItem
                {
                    Name = d.Name,
                    Path = d.FullName
                });
            }
        }
        catch (Exception ex)
        {
            result.Error = ex.Message;
        }

        return result;
    }

    private static string? GetParentDirectory(string path)
    {
        try
        {
            var di = new DirectoryInfo(path);
            if (di.Parent == null) return null;
            // 已经是根目录（如 C:\ 或 D:\）
            if (string.Equals(di.FullName.TrimEnd('\\', '/'), di.Root.FullName.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }
            return di.Parent.FullName;
        }
        catch
        {
            return null;
        }
    }

    private List<BrowseQuickPath> GetQuickPaths()
    {
        var list = new List<BrowseQuickPath>();

        // 1. 默认工作区
        list.Add(new BrowseQuickPath
        {
            Name = "默认工作区",
            Path = _currentWorkspaceRoot
        });

        // 2. 本机磁盘驱动器 (C:\, D:\, etc.)
        try
        {
            var drives = DriveInfo.GetDrives();
            foreach (var d in drives)
            {
                if (d.IsReady)
                {
                    var driveName = d.Name.TrimEnd('\\');
                    var label = !string.IsNullOrWhiteSpace(d.VolumeLabel) ? d.VolumeLabel : "本地磁盘";
                    list.Add(new BrowseQuickPath
                    {
                        Name = $"{label} ({driveName})",
                        Path = d.RootDirectory.FullName
                    });
                }
            }
        }
        catch { }

        // 3. 桌面与常用系统路径
        try
        {
            var desktop = Environment.GetFolderPath(Environment.SpecialFolder.Desktop);
            if (!string.IsNullOrWhiteSpace(desktop) && Directory.Exists(desktop))
            {
                list.Add(new BrowseQuickPath { Name = "桌面", Path = desktop });
            }
            var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            if (!string.IsNullOrWhiteSpace(docs) && Directory.Exists(docs))
            {
                list.Add(new BrowseQuickPath { Name = "文档", Path = docs });
            }
        }
        catch { }

        return list;
    }

    public List<Dictionary<string, object>> BrowseDirectory(string? path)
    {
        var target = string.IsNullOrWhiteSpace(path) ? _currentWorkspaceRoot : Path.GetFullPath(path);
        var entries = new List<Dictionary<string, object>>();

        if (!Directory.Exists(target)) return entries;

        var di = new DirectoryInfo(target);
        foreach (var d in di.GetDirectories().OrderBy(x => x.Name))
        {
            entries.Add(new Dictionary<string, object>
            {
                ["name"] = d.Name,
                ["path"] = d.FullName.Replace('\\', '/'),
                ["type"] = "directory"
            });
        }

        foreach (var f in di.GetFiles().OrderBy(x => x.Name))
        {
            entries.Add(new Dictionary<string, object>
            {
                ["name"] = f.Name,
                ["path"] = f.FullName.Replace('\\', '/'),
                ["type"] = "file",
                ["size"] = f.Length
            });
        }

        return entries;
    }
}
