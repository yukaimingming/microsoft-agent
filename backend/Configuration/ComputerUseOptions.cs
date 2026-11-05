namespace MafHarnessDemo.App.Configuration;

/// <summary>
/// 计算机操作（agent-desktop MCP）配置
/// </summary>
public sealed class ComputerUseOptions
{
    public const string SectionName = "ComputerUse";

    /// <summary>是否启用 computer-use MCP 子 Agent（默认启用）</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>启动命令（默认 node）</summary>
    public string Command { get; set; } = "node";

    /// <summary>启动参数（默认指向仓库内内联的 mcp-server.js）</summary>
    public List<string> Args { get; set; } = ["backend/tools/agent-desktop/mcp-server.js"];
}
