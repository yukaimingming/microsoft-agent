using System.Text.RegularExpressions;

namespace MafHarnessDemo.App.Infrastructure.Tools;

/// <summary>
/// shell 命令的只读分类器：判定一条 PowerShell 命令是否属于"纯读取/无副作用"。
/// 用于 run_shell 的动态审批规则——只读命令自动放行（不弹审批），
/// 修改数据、删除数据、账号权限类命令仍走人工审批。
///
/// 判定规则（fail-closed）：
/// - 按管道/分号切成段，每一段的首个命令都必须命中只读白名单；
/// - 整条命令的任何位置出现改写类 cmdlet（Set/Add/Remove/New/Move/Copy/
///   Rename/Clear/Stop/Invoke/…）、账号权限类命令（icacls / Set-Acl /
///   Set-ExecutionPolicy / net user 等）都判定为非只读；
/// - 未知首 token（python、git、curl 等可执行物）一律不算只读。
/// 注意：这是审批体验的启发式，不是安全边界——内容写命令另有
/// ShellCommandSanitizer 的强制拦截层。
/// </summary>
public static partial class ShellCommandClassifier
{
    /// <summary>只读白名单：匹配每段的首个命令 token。</summary>
    [GeneratedRegex(@"^\s*(?:Get-\w|Test-\w|Measure-Object\b|Measure-Command\b|Select-\w|Compare-\w|Sort-Object\b|Group-Object\b|Start-Sleep\b|Write-(?:Host|Output|Verbose|Information|Progress)\b|Out-String\b|Out-Null\b|Out-Host\b|Get-Date\b|Get-Location\b|Set-Location\b|Push-Location\b|Pop-Location\b|Get-Help\b|Get-Member\b|Get-Command\b|Get-Content\b|Get-Item\b|Get-ChildItem\b|Get-Process\b|Get-Service\b|Get-ComputerInfo\b|dir\b|ls\b|cat\b|type\b|whoami\b|hostname\b|where\.exe\b|ping\b|Get-AuthenticodeSignature\b)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled)]
    private static partial Regex ReadOnlyFirstToken();

    /// <summary>改写类/账号权限类黑名单：整条命令任意位置命中即非只读。
    /// Set-Location（cd）白名单放行，故 Set- 后面排除 Location。</summary>
    [GeneratedRegex(@"\b(?:Set-(?!Location)\w|Add-\w|Remove-\w|New-\w|Move-\w|Copy-\w|Rename-\w|Clear-\w|Stop-\w|Restart-\w|Invoke-\w|Export-\w|Import-\w|Register-\w|Unregister-\w|Enable-\w|Disable-\w|Update-\w|Reset-\w|Suspend-\w|Resume-\w|Out-File\b|Out-GridView\b|Tee-Object\b|Start-Process\b|Start-Job\b|icacls\b|cacls\b|takeown\b|Set-Acl\b|Set-ExecutionPolicy\b|net\s+(?:user|localgroup|share)\b|\[IO\.File\]::Write|\[System\.IO\.File\]::Write|\bmklink\b|\bdel\b|\brd\b|\bmd\b|\bcopy\b|\bmove\b|\bren\b|\brm\b)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled)]
    private static partial Regex MutatingToken();

    /// <summary>判定命令是否只读（可自动放行）。空命令/无法识别的命令都返回 false（fail-closed）。</summary>
    public static bool IsReadOnly(string? command)
    {
        if (string.IsNullOrWhiteSpace(command)) return false;

        var segments = command.Split(['|', ';'], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0) return false;

        foreach (var segment in segments)
        {
            if (!ReadOnlyFirstToken().IsMatch(segment) || MutatingToken().IsMatch(segment))
            {
                return false;
            }
        }

        return true;
    }
}
