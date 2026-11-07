using System.Diagnostics;
using Microsoft.Extensions.AI;
using ModelContextProtocol.Client;

namespace MafHarnessDemo.App.Infrastructure.Tools;

/// <summary>
/// 一次 Computer Use 挂载的句柄：MCP 客户端 + pidfile 凭据 + 工具清单。
/// 每轮执行独立挂载、轮末 ReleaseAsync 释放，保证 node 进程与 overlay 渲染子进程不跨轮残留。
/// </summary>
public sealed record ComputerUseHandle(McpClient Client, string PidFile, IReadOnlyList<AITool> Tools);

/// <summary>
/// 计算机操作：直连 agent-desktop MCP stdio 服务。
/// 提供 desktop_snapshot / desktop_launch / desktop_click / desktop_type / desktop_set_value 等 56 个工具。
///
/// 进程生命周期（与 agentscope-harness 同款 pidfile 方案）：
/// node mcp-server.js 启动时经环境变量 AGENT_DESKTOP_MCP_PIDFILE 拿到凭据文件路径并写入 {pid, session}；
/// 轮末 ReleaseAsync 兜底释放——MCP SDK 对 node 进程是 Windows 硬终止（TerminateProcess，不触发
/// node 的信号清理），因此依据 pidfile 先 taskkill /T /F 终结进程树，再通过 agent-desktop.exe
/// 关闭可能遗留的光标 overlay 渲染子进程与会话，防止孤儿 overlay 进程。
/// </summary>
public static class ComputerUseTools
{
    /// <summary>
    /// 挂载一次 agent-desktop MCP：启动 node 子进程、拿回工具清单。
    /// 返回 null 表示挂载失败（本轮按「未启用」降级，提示词与实际工具集保持一致）。
    /// </summary>
    public static async Task<(ComputerUseHandle? Handle, string? Error)> MountAsync(
        string command = "node",
        IList<string>? args = null,
        CancellationToken ct = default)
    {
        McpClient? client = null;
        var pidFile = Path.Combine(Path.GetTempPath(), $"agent-desktop-mcp-{Guid.NewGuid():N}.pid");
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
                // 默认继承当前进程全部环境变量，额外注入 pidfile 凭据供 node 退出清理与宿主兜底释放使用
                EnvironmentVariables = new Dictionary<string, string?>
                {
                    ["AGENT_DESKTOP_MCP_PIDFILE"] = pidFile,
                },
            };

            var transport = new StdioClientTransport(transportOptions);
            client = await McpClient.CreateAsync(transport, cancellationToken: ct);
            var tools = await client.ListToolsAsync(cancellationToken: ct);
            if (tools.Count == 0)
            {
                await DisposeClientQuietlyAsync(client);
                DeleteFileQuietly(pidFile);
                return (null, "agent-desktop MCP 未返回任何工具");
            }

            return (new ComputerUseHandle(client, pidFile, [.. tools.Select(t => (AITool)t)]), null);
        }
        catch (OperationCanceledException)
        {
            await DisposeClientQuietlyAsync(client);
            DeleteFileQuietly(pidFile);
            return (null, "agent-desktop 连接超时或已取消");
        }
        catch (Exception ex)
        {
            await DisposeClientQuietlyAsync(client);
            DeleteFileQuietly(pidFile);
            return (null, ex.Message);
        }
    }

    /// <summary>
    /// 轮末释放：关闭 MCP 客户端（SDK 对 node 为硬终止），再依据 pidfile 兜底
    /// taskkill 进程树并关闭遗留的光标 overlay 会话。幂等，失败不抛出。
    /// </summary>
    public static async Task ReleaseAsync(ComputerUseHandle? handle)
    {
        if (handle is null) return;

        await DisposeClientQuietlyAsync(handle.Client);
        ReleaseDesktopProcessResources(handle.PidFile);
    }

    /// <summary>
    /// 兜底释放 agent-desktop 相关子进程资源：
    /// 读取 node 启动时写入的凭据（pid + session），先 taskkill /T /F 终结其进程树，
    /// 再通过 agent-desktop.exe 关闭可能遗留的光标 overlay 渲染子进程与会话，最后删除 pidfile。
    /// </summary>
    private static void ReleaseDesktopProcessResources(string pidFile)
    {
        string? pid = null;
        string? sessionId = null;
        try
        {
            if (File.Exists(pidFile))
            {
                var json = System.Text.Json.JsonDocument.Parse(File.ReadAllText(pidFile)).RootElement;
                if (json.TryGetProperty("pid", out var pidProp)) pid = pidProp.ToString();
                if (json.TryGetProperty("session", out var sessionProp) && sessionProp.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    sessionId = sessionProp.GetString();
                }
            }
        }
        catch
        {
            // 凭据文件缺失或损坏：仅能跳过 overlay 清理，进程树终结依赖 SDK 自身的进程关闭
        }

        if (!string.IsNullOrWhiteSpace(pid) && int.TryParse(pid, out var pidNum) && pidNum > 0)
        {
            RunQuiet("taskkill", $"/F /T /PID {pidNum}");
        }

        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            var nativeExe = ResolveNativeExe();
            if (nativeExe != null)
            {
                RunQuiet(nativeExe, $"cursor-overlay disable --session {sessionId}");
                RunQuiet(nativeExe, $"session end --session {sessionId}");
            }
        }

        DeleteFileQuietly(pidFile);
    }

    /// <summary>静默执行外部命令（限时 5 秒），失败不抛出。</summary>
    private static void RunQuiet(string fileName, string arguments)
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                },
                EnableRaisingEvents = false,
            };
            if (!process.Start()) return;
            if (!process.WaitForExit(5000))
            {
                try { process.Kill(entireProcessTree: true); } catch { }
            }
        }
        catch
        {
            // 兜底清理失败不应影响主流程
        }
    }

    private static async Task DisposeClientQuietlyAsync(McpClient? client)
    {
        if (client is null) return;
        try
        {
            await client.DisposeAsync();
        }
        catch
        {
            // SDK 关闭失败时由 ReleaseDesktopProcessResources 的 pidfile 兜底终结进程树
        }
    }

    private static void DeleteFileQuietly(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            // 忽略临时凭据文件删除失败
        }
    }

    /// <summary>
    /// 解析 agent-desktop 原生 CLI（node 侧 resolveNativeExe 的同源候选顺序）：
    /// 优先 mcp-server.js 同目录，其次其 ../bin，最后全局 node_modules 安装位置。
    /// </summary>
    private static string? ResolveNativeExe()
    {
        var arch = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
        {
            System.Runtime.InteropServices.Architecture.Arm64 => "win32-arm64",
            _ => "win32-x64",
        };
        var binaryName = $"agent-desktop-{arch}.exe";

        var scriptPath = ResolveScriptPath("backend/tools/agent-desktop/mcp-server.js");
        var candidates = new List<string>();
        if (File.Exists(scriptPath))
        {
            var scriptDir = Path.GetDirectoryName(scriptPath);
            if (!string.IsNullOrEmpty(scriptDir))
            {
                candidates.Add(Path.Combine(scriptDir, "agent-desktop.exe"));
                candidates.Add(Path.Combine(scriptDir, binaryName));
                var parentBin = Path.GetFullPath(Path.Combine(scriptDir, "..", "bin"));
                candidates.Add(Path.Combine(parentBin, "agent-desktop.exe"));
                candidates.Add(Path.Combine(parentBin, binaryName));
            }
        }
        candidates.Add(@"E:\nodejs\node_modules\agent-desktop\bin\agent-desktop.exe");
        candidates.Add($@"E:\nodejs\node_modules\agent-desktop\bin\{binaryName}");

        return candidates.FirstOrDefault(File.Exists);
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
