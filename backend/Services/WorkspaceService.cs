using MafHarness.Web.Models;

namespace MafHarness.Web.Services;

public sealed class WorkspaceService
{
    private string _currentWorkspaceRoot;

    public WorkspaceService(IConfiguration configuration)
    {
        var configured = configuration["Workspace:Root"];
        _currentWorkspaceRoot = !string.IsNullOrWhiteSpace(configured)
            ? Path.GetFullPath(configured)
            : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "workspace"));
        
        Directory.CreateDirectory(_currentWorkspaceRoot);
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
