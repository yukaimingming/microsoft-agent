namespace MafHarnessDemo.App.Configuration;

/// <summary>
/// 文件访问配置。这三个开关之前只写在 appsettings.json 里却没人读取
/// （实际行为硬编码在 FileAgentFactory），配置改了不生效；现在绑定后
/// 由 <c>FileAgentFactory.BuildOptions</c> 装进 FileAccessProviderOptions，
/// 环境变量 MAF_HARNESS_FileAccess__XX 也能覆盖。
/// </summary>
public sealed class FileAccessOptions
{
    public const string SectionName = "FileAccess";

    /// <summary>无盘符相对路径的默认落点盘符，如 "C" 或 "D"。</summary>
    public string DefaultDrive { get; set; } = "D";

    /// <summary>true 时只保留读工具（read/read_lines/ls/grep），不注册任何写工具。</summary>
    public bool DisableWriteTools { get; set; }

    /// <summary>true 时读工具免人工审批（默认，读操作不打断对话）。</summary>
    public bool DisableReadOnlyToolApproval { get; set; } = true;

    /// <summary>false（默认）时每次写操作前 REPL 会问 [y]批准 / [n]拒绝。</summary>
    public bool DisableWriteToolApproval { get; set; }
}
