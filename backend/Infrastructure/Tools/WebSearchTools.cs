using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;

namespace MafHarnessDemo.App.Infrastructure.Tools;

/// <summary>
/// 联网搜索：直连 Exa 官方 MCP 服务器（https://mcp.exa.ai/mcp，streamable HTTP，
/// 免费无需 API Key）。
///
/// 接入方式参考 Agent-Reach（github.com/Panniantong/Agent-Reach）：它的搜索后端
/// 同样是 Exa MCP（经 mcporter 桥接）；本项目用官方 ModelContextProtocol C# SDK
/// 直接连接同一个端点，不经过 Python 桥。提供两个工具：
///   web_search_exa  语义搜索（query / numResults / objective）
///   web_fetch_exa   读网页转 Markdown（urls / maxCharacters）
/// McpClientTool 本身实现 AIFunction，可直接挂进 HarnessAgentOptions.ChatOptions.Tools。
/// </summary>
public static class WebSearchTools
{
    /// <summary>
    /// 挂载给模型的工具白名单——必须与 FileAgentFactory 提示词里的联网行保持一致。
    /// 不能把 Exa 服务端返回的工具全量挂载：配 ApiKey 后服务端还会返回
    /// agent_run 等工具，模型看见白名单外的工具会违反"只能调用清单内工具"的约束。
    /// </summary>
    public static readonly string[] AllowedTools = ["web_search_exa", "web_fetch_exa"];

    /// <summary>
    /// 连接 Exa MCP 并列出工具。断网 / 端点失效时返回 null（降级为无搜索，
    /// 不挡启动）。apiKey 非空时拼到端点 ?exaApiKey= 上（免费 MCP 限流，
    /// 报 429 时去 dashboard.exa.ai/api-keys 免费建 Key）。
    /// </summary>
    public static async Task<(IReadOnlyList<AITool>? Tools, string? Error)> TryCreateAsync(
        string endpoint, string apiKey = "", CancellationToken ct = default)
    {
        try
        {
            var effective = endpoint;
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                effective += (endpoint.Contains('?') ? "&" : "?")
                             + "exaApiKey=" + Uri.EscapeDataString(apiKey.Trim());
            }

            var transport = new HttpClientTransport(new HttpClientTransportOptions
            {
                Name = "exa",
                Endpoint = new Uri(effective),
            });

            var client = await McpClient.CreateAsync(transport, cancellationToken: ct);
            var tools = await client.ListToolsAsync(cancellationToken: ct);

            // 按白名单过滤：提示词只声明了这些工具，挂载集必须与之一致
            var allowed = tools.Where(t => AllowedTools.Contains(t.Name)).ToList();
            return ([.. allowed.Select(t => (AITool)t)], null);
        }
        catch (OperationCanceledException)
        {
            // 启动超时/取消：同样降级为无搜索，但如实报告原因（不能当连接失败吞掉）
            return (null, "连接超时或已取消");
        }
        catch (Exception ex)
        {
            return (null, ex.Message);
        }
    }
}
