using Microsoft.Agents.AI;

namespace MafHarnessDemo.App.Infrastructure.FileStore;

/// <summary>
/// 任意盘符路由的文件 store——不预配置白名单，来哪个盘就动态建哪个盘的 store。
///
/// 背景：FileSystemAgentFileStore 是单根的（一个目录），FileAccessProvider 又在调 store
/// 之前用 NormalizeRelativePath 拒绝一切带盘符的路径（"E:/x" 直接被拒，
/// 报 "Paths must be relative and must not start with ... a drive root"）。
/// 本类接管路由，路径形态约定：
///
///   E:/仪器协议文档/x.pdf   带冒号（模型按习惯写的）→ E 盘
///   E/仪器协议文档/x.pdf    无冒号、首段单字母（提示词引导的形态）→ E 盘
///   temp/notes.txt          普通相对路径 → 默认盘
///
/// 每个盘各持有一个 FileSystemAgentFileStore（动态创建并缓存），由它负责自己的安全闸门
/// （规范化、拒绝 .. 段、拒绝符号链接）——本类只做路由，不放松任何盘内检查。
///
/// 注意：这是**完全放开**模式，任何盘符、任何路径都可读写。
/// 风险自负——任何能影响模型输入的内容（粘贴的文档、网页、文件内容）里的
/// 「请写入某路径」指令都可能被执行。本地自用 demo 可以，别接不可信输入。
/// </summary>
public sealed class MultiDriveFileStore : AgentFileStore
{
    private readonly Dictionary<string, FileSystemAgentFileStore> _stores = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _defaultDrive;

    /// <param name="defaultDrive">无盘符相对路径的默认落点盘符，如 "C" 或 "D"。</param>
    public MultiDriveFileStore(string defaultDrive = "C")
    {
        if (!TryNormalizeDrive(defaultDrive, out var normalized))
            throw new ArgumentException($"默认盘无效：{defaultDrive}", nameof(defaultDrive));

        _defaultDrive = normalized;
    }

    /// <summary>无盘符相对路径的默认落点盘符。</summary>
    public string DefaultDrive => _defaultDrive;

    /// <summary>文件成功修改后的通知；供控制台展示实际写入前后的差异。</summary>
    public event Action<FileChange>? FileChanged;

    public override async Task WriteAsync(string path, string content, CancellationToken cancellationToken = default)
    {
        var (store, relative) = Route(path);
        var before = await store.FileExistsAsync(relative, cancellationToken)
            ? await store.ReadAsync(relative, cancellationToken)
            : null;
        await store.WriteAsync(relative, content, cancellationToken);
        if (before != content)
            FileChanged?.Invoke(new FileChange(path, before, content));
    }

    public override Task<string?> ReadAsync(string path, CancellationToken cancellationToken = default)
    {
        var (store, relative) = Route(path);
        return store.ReadAsync(relative, cancellationToken);
    }

    public override Task<bool> DeleteAsync(string path, CancellationToken cancellationToken = default)
    {
        var (store, relative) = Route(path);
        return store.DeleteAsync(relative, cancellationToken);
    }

    public override Task<bool> FileExistsAsync(string path, CancellationToken cancellationToken = default)
    {
        var (store, relative) = Route(path);
        return store.FileExistsAsync(relative, cancellationToken);
    }

    public override Task<IReadOnlyList<FileStoreEntry>> ListChildrenAsync(
        string directory, CancellationToken cancellationToken = default)
    {
        var (store, relative) = Route(directory);
        return store.ListChildrenAsync(relative, cancellationToken);
    }

    public override Task CreateDirectoryAsync(string directory, CancellationToken cancellationToken = default)
    {
        var (store, relative) = Route(directory);
        return store.CreateDirectoryAsync(relative, cancellationToken);
    }

    /// <summary>
    /// 把模型给的路径路由到某个盘的 store。三种形态都认：
    ///   E:/仪器协议文档/x.pdf  带冒号 → E 盘
    ///   E/仪器协议文档/x.pdf   无冒号、首段单字母 → E 盘
    ///   temp/notes.txt         普通相对路径 → 默认盘
    /// 空路径列默认盘根。盘符不预配置——来一个建一个。
    /// </summary>
    private (FileSystemAgentFileStore Store, string RelativePath) Route(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return (StoreFor(_defaultDrive), string.Empty);

        var normalized = path.Replace('\\', '/').Trim();

        // 1. 带冒号：E:/仪器协议文档/x.pdf → E 盘的 仪器协议文档/x.pdf
        if (normalized.Length >= 2 && normalized[1] == ':')
        {
            if (!TryNormalizeDrive(normalized[..1], out var driveLetter))
                throw new ArgumentException($"拒绝访问：无法识别的盘符路径：{path}");

            var rest = normalized[2..].TrimStart('/');
            return (StoreFor(driveLetter), rest);
        }

        // 2. 无冒号：首段是单字母 → 那个盘
        //    （提示词引导模型用这种形态；代价是默认盘下单字母目录会被盘符抢先，
        //     真要访问用 默认盘/xxx 显式绕开。）
        var slash = normalized.IndexOf('/');
        var head = slash < 0 ? normalized : normalized[..slash];
        if (head.Length == 1 && char.IsAsciiLetter(head[0]))
        {
            var driveStore = StoreFor(head);
            var rest = slash < 0 ? string.Empty : normalized[(slash + 1)..];
            return (driveStore, rest);
        }

        // 3. 普通相对路径 → 默认盘
        return (StoreFor(_defaultDrive), normalized.TrimStart('/'));
    }

    /// <summary>按盘符取（或动态创建）该盘的 store。</summary>
    private FileSystemAgentFileStore StoreFor(string driveLetter)
    {
        if (!_stores.TryGetValue(driveLetter, out var store))
        {
            store = new FileSystemAgentFileStore(driveLetter + ":\\");
            _stores[driveLetter] = store;
        }

        return store;
    }

    private static bool TryNormalizeDrive(string value, out string driveLetter)
    {
        driveLetter = string.Empty;
        if (string.IsNullOrWhiteSpace(value)) return false;

        var trimmed = value.Trim();
        if (trimmed.Length == 1 && char.IsAsciiLetter(trimmed[0]))
        {
            driveLetter = char.ToUpperInvariant(trimmed[0]).ToString();
            return true;
        }

        return false;
    }
}
