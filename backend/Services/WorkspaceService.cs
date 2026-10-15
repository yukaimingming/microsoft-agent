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
