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
    public static string ToSystemPath(string path, string defaultDrive = "D")
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("路径不能为空", nameof(path));

        var normalized = path.Replace('\\', '/').Trim();

        // 已带冒号：E:/x 或 E:\x —— 统一成反斜杠
        if (normalized.Length >= 2 && normalized[1] == ':')
            return normalized.Replace('/', '\\');

        // 无冒号、首段单字母：E/x → E:\x
        var slash = normalized.IndexOf('/');
        var head = slash < 0 ? normalized : normalized[..slash];
        if (head.Length == 1 && char.IsAsciiLetter(head[0]))
        {
            var rest = slash < 0 ? string.Empty : normalized[(slash + 1)..];
            var drive = char.ToUpperInvariant(head[0]);
            return rest.Length == 0 ? $"{drive}:\\" : $"{drive}:\\{rest.Replace('/', '\\')}";
        }

        // 无盘符相对路径 → 拼默认盘
        var driveLetter = string.IsNullOrWhiteSpace(defaultDrive) ? "D" : defaultDrive.Trim()[..1].ToUpperInvariant();
        return $"{driveLetter}:\\{normalized.Replace('/', '\\')}";
    }
}
