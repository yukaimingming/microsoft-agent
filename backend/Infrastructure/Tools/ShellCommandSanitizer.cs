using System.ComponentModel;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.AI;
using MafHarnessDemo.App.Infrastructure.FileStore;

namespace MafHarnessDemo.App.Infrastructure.Tools;

/// <summary>
/// shell 命令的 AIFunction 包装器——修 MAF LocalShellExecutor 的一个 bug，
/// 并拦截用 shell 改文件内容的命令。
///
/// 1. 实测（探针复现）：命令里只要出现 Format-List / Format-Table / Format-Wide，
///    LocalShellExecutor 就返回 exit=1 + stderr「未将对象引用设置到对象的实例」，
///    stdout 全丢（2026-09 的 1.22.0-preview.260918.1 仍存在）。
///    而 Format-* 只是改变输出的排版，剥掉之后 PowerShell 默认输出内容完全一样，
///    对 agent 没有任何信息损失——模型爱用 Format-Table -AutoSize，拦不住，
///    就在这一层统一剥掉。
/// 2. 模型追加/修改文件内容时偏爱 Add-Content / Set-Content（比读改写省事），
///    但 shell 写文件不经过 MultiDriveFileStore，差异展示（FileChanged）不触发、
///    编码也不可控（实测踩过）。这里直接拒绝并提示改用 file_access 工具——
///    模型收到错误后会照做。
/// </summary>
public sealed class ShellCommandSanitizer(AIFunction inner)
    : DelegatingAIFunction(inner)
{
    /// <summary>匹配「| Format-Table -AutoSize」这类管道尾段（含其参数）。</summary>
    private static readonly Regex FormatCmdlet =
        new(@"\|\s*Format-(?:List|Table|Wide)\b[^|;]*", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// 匹配用 shell 改文件内容的常见形态（尽力拦截，不是可靠边界——
    /// [IO.File]::WriteAllText / -EncodedCommand 等仍可绕过）。要点：
    /// - New-Item 缺省 -ItemType 即建文件，只有显式 -ItemType Directory/Container
    ///   （建目录，结构操作）放行；
    /// - 重定向 > 与 >> 都可能无空格直连文件名（>file 与 > file 等价，实测踩过），
    ///   2>&1 输出合并会放行（不写文件）；> $null 输出抑制会被误拦，
    ///   属宽口径守卫的已知代价。
    /// </summary>
    private static readonly Regex ContentWriteCmdlet =
        new(@"\b(?:Add-Content|Set-Content|Out-File|Clear-Content|Export-Csv|Tee-Object)\b|\bNew-Item\b(?![^\r\n|;]*-ItemT\w*\s+(?:Dir|Con))(?![^\r\n|;]*-Ty\w*\s+(?:Dir|Con))|(?:>>|>\s?)[^\s&|;]",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private const string ContentWriteRejected =
        "错误：禁止用 shell 命令写入/修改文件内容（Add-Content/Set-Content/Out-File/重定向等）。"
        + "请改用 file_access_write（overwrite=true）或 file_access_replace / file_access_replace_lines 完成内容变更。";

    protected override ValueTask<object?> InvokeCoreAsync(
        AIFunctionArguments arguments, CancellationToken cancellationToken)
    {
        // 注意：AIFunctionArguments 里的值可能是 string 也可能是 JsonElement
        // （审批续跑路径回传的参数就是 JsonElement），不能只 is string。
        var cmd = rawAsString(arguments.TryGetValue("command", out var raw) ? raw : null);
        if (!string.IsNullOrEmpty(cmd))
        {
            var cleaned = FormatCmdlet.Replace(cmd, string.Empty);
            if (ContentWriteCmdlet.IsMatch(cleaned))
            {
                return new ValueTask<object?>(ContentWriteRejected);
            }

            arguments["command"] = cleaned;
        }

        return base.InvokeCoreAsync(arguments, cancellationToken);
    }

    private static string? rawAsString(object? value) => value switch
    {
        null => null,
        string s => s,
        System.Text.Json.JsonElement { ValueKind: System.Text.Json.JsonValueKind.String } e => e.GetString(),
        _ => value.ToString(),
    };
}
