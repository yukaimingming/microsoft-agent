using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;

namespace MafHarnessDemo.App.Infrastructure.Tools;

/// <summary>
/// 计算机操作：直连 agent-desktop MCP stdio 服务。
/// 提供 desktop_snapshot / desktop_launch / desktop_click / desktop_type / desktop_set_value 等 56 个工具。
/// </summary>
public static class ComputerUseTools
{
    private static readonly SemaphoreSlim _initLock = new(1, 1);
    private static McpClient? _cachedClient;
    private static IReadOnlyList<AITool>? _cachedTools;

    public static async Task<(IReadOnlyList<AITool>? Tools, string? Error)> GetOrCreateToolsAsync(
        string command = "node",
        IList<string>? args = null,
        CancellationToken ct = default)
    {
        if (_cachedTools != null && _cachedTools.Count > 0)
        {
            return (_cachedTools, null);
        }

        await _initLock.WaitAsync(ct);
        try
        {
            if (_cachedTools != null && _cachedTools.Count > 0)
            {
                return (_cachedTools, null);
            }

            var (tools, err) = await TryCreateAsync(command, args, ct);
            if (tools != null && tools.Count > 0)
            {
                _cachedTools = tools;
            }
            return (tools, err);
        }
        finally
        {
            _initLock.Release();
        }
    }

    public static async Task<(IReadOnlyList<AITool>? Tools, string? Error)> TryCreateAsync(
        string command = "node",
        IList<string>? args = null,
        CancellationToken ct = default)
    {
        try
        {
            var resolvedArgs = new List<string>();
            if (args != null && args.Count > 0)
            {
                foreach (var arg in args)
                {
                    if (arg.Contains("mcp-server.js"))
                    {
                        resolvedArgs.Add(ResolveScriptPath(arg));
                    }
                    else
                    {
                        resolvedArgs.Add(arg);
                    }
                }
            }
            else
            {
                resolvedArgs.Add(ResolveScriptPath("backend/tools/agent-desktop/mcp-server.js"));
            }

            var transportOptions = new StdioClientTransportOptions
            {
                Command = command,
                Arguments = resolvedArgs,
            };

            var transport = new StdioClientTransport(transportOptions);
            var client = await McpClient.CreateAsync(transport, cancellationToken: ct);
            _cachedClient = client;
            var tools = await client.ListToolsAsync(cancellationToken: ct);

            return ([.. tools.Select(t => (AITool)t)], null);
        }
        catch (OperationCanceledException)
        {
            return (null, "agent-desktop 连接超时或已取消");
        }
        catch (Exception ex)
        {
            return (null, ex.Message);
        }
    }

    public static string ResolveScriptPath(string scriptPath)
    {
        if (File.Exists(scriptPath)) return Path.GetFullPath(scriptPath);

        var fromBase = Path.Combine(AppContext.BaseDirectory, scriptPath);
        if (File.Exists(fromBase)) return Path.GetFullPath(fromBase);

        var fromCwd = Path.Combine(Directory.GetCurrentDirectory(), scriptPath);
        if (File.Exists(fromCwd)) return Path.GetFullPath(fromCwd);

        if (scriptPath.StartsWith("backend/") || scriptPath.StartsWith("backend\\"))
        {
            var trimmed = scriptPath[8..];
            if (File.Exists(trimmed)) return Path.GetFullPath(trimmed);
            var trimmedFromCwd = Path.Combine(Directory.GetCurrentDirectory(), trimmed);
            if (File.Exists(trimmedFromCwd)) return Path.GetFullPath(trimmedFromCwd);
        }
        else
        {
            var withBackend = Path.Combine("backend", scriptPath);
            if (File.Exists(withBackend)) return Path.GetFullPath(withBackend);
            var withBackendFromCwd = Path.Combine(Directory.GetCurrentDirectory(), withBackend);
            if (File.Exists(withBackendFromCwd)) return Path.GetFullPath(withBackendFromCwd);
        }

        const string globalFallback = @"E:\nodejs\node_modules\agent-desktop\lib\mcp-server.js";
        if (File.Exists(globalFallback)) return globalFallback;

        return scriptPath;
    }
}
