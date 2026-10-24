using MafHarness.Web.Services;
using Microsoft.Agents.AI;

namespace MafHarnessDemo.App.Infrastructure.FileStore;

/// <summary>
/// 用户工作区强绑定文件存储（Workspace-Scoped File Store）。
/// 
/// 遵循原则：
/// 1. 严格只能绑定在用户工作区目录下，所有文件读写、创建、列出、搜索等操作必须在该工作区内完成。
/// 2. 严禁越界跨盘或逃逸到系统根盘（如 C:\、D:\ 等）。
/// 3. 自动抵御路径穿越（Directory Traversal），确保工作区沙箱安全。
/// </summary>
public sealed class MultiDriveFileStore : AgentFileStore
{
    private readonly string _workspaceRoot;
    private readonly FileSystemAgentFileStore _workspaceStore;

    /// <param name="defaultDrive">已废弃，保留做兼容入参。</param>
    /// <param name="workspaceRoot">用户当前绑定的工作区根目录绝对路径（若为空则自动解析默认工作区）。</param>
    public MultiDriveFileStore(string? defaultDrive = null, string? workspaceRoot = null)
    {
        var resolvedRoot = !string.IsNullOrWhiteSpace(workspaceRoot)
            ? workspaceRoot
            : WorkspaceService.ResolveWorkspaceRoot(null);

        var full = Path.GetFullPath(resolvedRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        Directory.CreateDirectory(full);
        _workspaceRoot = full.Replace('\\', '/');
        _workspaceStore = new FileSystemAgentFileStore(full + Path.DirectorySeparatorChar);
    }

    /// <summary>工作区所在驱动器盘符。</summary>
    public string DefaultDrive => _workspaceRoot.Length >= 2 && _workspaceRoot[1] == ':'
        ? _workspaceRoot[..1].ToUpperInvariant()
        : "D";

    /// <summary>当前绑定的用户工作区根目录绝对路径。</summary>
    public string WorkspaceRoot => _workspaceRoot;

    /// <summary>文件成功修改后的通知；供前端展示实际写入前后的差异。</summary>
    public event Action<FileChange>? FileChanged;

    public override async Task WriteAsync(string path, string content, CancellationToken cancellationToken = default)
    {
        var relative = Route(path);
        var before = await _workspaceStore.FileExistsAsync(relative, cancellationToken)
            ? await _workspaceStore.ReadAsync(relative, cancellationToken)
            : null;
        await _workspaceStore.WriteAsync(relative, content, cancellationToken);
        if (before != content)
            FileChanged?.Invoke(new FileChange(path, before, content));
    }

    public override Task<string?> ReadAsync(string path, CancellationToken cancellationToken = default)
    {
        var relative = Route(path);
        return _workspaceStore.ReadAsync(relative, cancellationToken);
    }

    public override Task<bool> DeleteAsync(string path, CancellationToken cancellationToken = default)
    {
        var relative = Route(path);
        return _workspaceStore.DeleteAsync(relative, cancellationToken);
    }

    public override Task<bool> FileExistsAsync(string path, CancellationToken cancellationToken = default)
    {
        var relative = Route(path);
        return _workspaceStore.FileExistsAsync(relative, cancellationToken);
    }

    public override Task<IReadOnlyList<FileStoreEntry>> ListChildrenAsync(
        string directory, CancellationToken cancellationToken = default)
    {
        var relative = Route(directory);
        return _workspaceStore.ListChildrenAsync(relative, cancellationToken);
    }

    public override Task CreateDirectoryAsync(string directory, CancellationToken cancellationToken = default)
    {
        var relative = Route(directory);
        return _workspaceStore.CreateDirectoryAsync(relative, cancellationToken);
    }

    /// <summary>
    /// 把模型或前端给的路径严格路由限制在当前用户绑定的工作区内。
    /// 严禁任何跨盘或超出工作区范围的访问。
    /// </summary>
    private string Route(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path == "." || path == "./")
        {
            return string.Empty;
        }

        var normalized = path.Replace('\\', '/').Trim();

        // 1. 特殊前缀：workspace/ 或 ./workspace/ 或纯 workspace
        if (normalized.Equals("workspace", StringComparison.OrdinalIgnoreCase) ||
            normalized.Equals("./workspace", StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }
        if (normalized.StartsWith("workspace/", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized[10..].TrimStart('/');
        }
        else if (normalized.StartsWith("./workspace/", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized[12..].TrimStart('/');
        }

        // 2. 检查是否为带工作区前缀的绝对路径（如 D:/temp/Microsoft agent/workspace/demo.txt）
        if (normalized.StartsWith(_workspaceRoot, StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized[_workspaceRoot.Length..].TrimStart('/');
        }
        // 或带盘符首字母无冒号形式（如 D/temp/Microsoft agent/workspace/demo.txt）
        else if (normalized.Length >= 2 && normalized[1] == '/' && char.IsAsciiLetter(normalized[0]))
        {
            var reconstructed = normalized[..1].ToUpperInvariant() + ":" + normalized[1..];
            if (reconstructed.StartsWith(_workspaceRoot, StringComparison.OrdinalIgnoreCase))
            {
                normalized = reconstructed[_workspaceRoot.Length..].TrimStart('/');
            }
        }

        // 3. 严格禁止访问外部绝对路径或其它盘符
        if (normalized.Length >= 2 && normalized[1] == ':')
        {
            throw new UnauthorizedAccessException($"拒绝访问：操作已严格绑定在用户工作区目录 [{_workspaceRoot}]，禁止访问外部路径 [{path}]。");
        }

        var slashIndex = normalized.IndexOf('/');
        if (slashIndex == 1 && char.IsAsciiLetter(normalized[0]))
        {
            throw new UnauthorizedAccessException($"拒绝访问：操作已严格绑定在用户工作区目录 [{_workspaceRoot}]，禁止跨盘访问外部路径 [{path}]。");
        }

        // 4. 防范目录穿越（Directory Traversal）：如 "../" 或 "a/../../b"
        var segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var stack = new List<string>();
        foreach (var seg in segments)
        {
            if (seg == ".") continue;
            if (seg == "..")
            {
                if (stack.Count > 0)
                {
                    stack.RemoveAt(stack.Count - 1);
                }
                else
                {
                    throw new UnauthorizedAccessException($"拒绝访问：检测到目录穿越，禁止访问工作区外部路径 [{path}]。");
                }
            }
            else
            {
                stack.Add(seg);
            }
        }

        return string.Join('/', stack);
    }
}
