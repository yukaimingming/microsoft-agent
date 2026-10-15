namespace MafHarnessDemo.App.Configuration;

/// <summary>
/// 联网搜索配置。接入方式参考 Agent-Reach（github.com/Panniantong/Agent-Reach）：
/// 它的搜索后端是 Exa 官方 MCP（免费无需 API Key）；本项目用
/// ModelContextProtocol C# SDK 直连同一端点。
/// </summary>
public sealed class WebSearchOptions
{
    public const string SectionName = "WebSearch";

    /// <summary>是否启用联网搜索（Exa MCP）。启用失败（断网/端点变更）会降级为无搜索。</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Exa MCP 端点，streamable HTTP 传输。</summary>
    public string Endpoint { get; set; } = "https://mcp.exa.ai/mcp";

    /// <summary>
    /// 可选的 Exa API Key。免费 MCP 有严格限流（429），在
    /// https://dashboard.exa.ai/api-keys 免费建 Key 后填这里（拼到端点
    /// ?exaApiKey= 上），即可不限流使用。
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;
}
