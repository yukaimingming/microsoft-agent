namespace MafHarnessDemo.App.Infrastructure.FileStore;

/// <summary>
/// 把模型给的各种路径形态归一成 .NET 文件 API 能认的形态。
///
/// 模型被提示词教成用无冒号形态（D/temp/x.txt），这对 MAF 内置的
/// file_access_* 是必需的（它的 NormalizeRelativePath 只放行无冒号相对路径），
/// 但 .NET 自己的 File/Directory API 要带冒号（D:\temp\x.txt 或 D:/temp/x.txt）。
/// 自有工具（read_pdf/read_excel）直接用文件 API，所以在入口做这一层转换：
///
///   E/仪器协议文档/x.pdf   → E:\仪器协议文档\x.pdf
///   E:/仪器协议文档/x.pdf  → E:\仪器协议文档\x.pdf
///   E:\仪器协议文档\x.pdf  → 原样（已规范）
///   temp/x.txt（无盘符）   → {默认盘}:\temp\x.txt
/// </summary>
internal static class FilePathNormalizer
{
    public static string ToSystemPath(string path, string? defaultDrive = null, string? workspaceRoot = null)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("路径不能为空", nameof(path));

        var normalized = path.Replace('\\', '/').Trim();

        var ws = !string.IsNullOrWhiteSpace(workspaceRoot)
            ? Path.GetFullPath(workspaceRoot).Replace('\\', '/').TrimEnd('/')
            : null;

        if (ws != null)
        {
            // 特殊前缀：workspace/ 或 ./workspace/ 或纯 workspace
            if (normalized.Equals("workspace", StringComparison.OrdinalIgnoreCase) ||
                normalized.Equals("./workspace", StringComparison.OrdinalIgnoreCase))
            {
                return ws.Replace('/', '\\');
            }
            if (normalized.StartsWith("workspace/", StringComparison.OrdinalIgnoreCase))
            {
                normalized = normalized[10..].TrimStart('/');
            }
            else if (normalized.StartsWith("./workspace/", StringComparison.OrdinalIgnoreCase))
            {
                normalized = normalized[12..].TrimStart('/');
            }
            else if (normalized.StartsWith(ws, StringComparison.OrdinalIgnoreCase))
            {
                normalized = normalized[ws.Length..].TrimStart('/');
            }
            else if ((normalized.Length >= 2 && normalized[1] == ':') || (normalized.IndexOf('/') == 1 && char.IsAsciiLetter(normalized[0])))
            {
                throw new UnauthorizedAccessException($"拒绝访问：操作已严格绑定在用户工作区目录 [{ws}]，禁止访问外部路径 [{path}]。");
            }

            // 目录穿越防范
            var segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
            var stack = new List<string>();
            foreach (var seg in segments)
            {
                if (seg == ".") continue;
                if (seg == "..")
                {
                    if (stack.Count > 0) stack.RemoveAt(stack.Count - 1);
                    else throw new UnauthorizedAccessException($"拒绝访问：检测到目录穿越，禁止访问工作区外部路径 [{path}]。");
                }
                else
                {
                    stack.Add(seg);
                }
            }

            return Path.Combine(ws, string.Join('/', stack)).Replace('/', '\\');
        }

        return Path.GetFullPath(normalized);
    }
}
