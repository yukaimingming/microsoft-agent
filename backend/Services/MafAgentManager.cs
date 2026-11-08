using System.Collections.Concurrent;
using System.Text.Json;
using MafHarness.Web.Models;
using MafHarnessDemo.App.Configuration;
using MafHarnessDemo.App.Infrastructure.Agents;
using MafHarnessDemo.App.Infrastructure.FileStore;
using MafHarnessDemo.App.Infrastructure.Tools;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace MafHarness.Web.Services;

public sealed class MafAgentManager
{
    private readonly IConfiguration _configuration;
    private readonly ProviderService _providerService;
    private readonly WorkspaceService _workspaceService;
    private readonly OAuthService _oauthService;
    private readonly ILogger<MafAgentManager> _logger;

    // 会话与执行管理
    private readonly ConcurrentDictionary<string, AgentSession> _sessions = new();
    private readonly ConcurrentDictionary<string, AIAgent> _agents = new();
    private readonly ConcurrentDictionary<string, bool> _agentWebSearch = new();
    private readonly ConcurrentDictionary<string, bool> _agentPlanEnabled = new();
    private readonly ConcurrentDictionary<string, bool> _agentComputerUse = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _activeCts = new();
    private readonly ConcurrentDictionary<string, List<ToolApprovalRequestContent>> _pendingApprovals = new();

    // 记忆沉淀节流
    private DateTime _lastFlushAt = DateTime.MinValue;

    public MafAgentManager(
        IConfiguration configuration,
        ProviderService providerService,
        WorkspaceService workspaceService,
        OAuthService oauthService,
        ILogger<MafAgentManager> logger)
    {
        _configuration = configuration;
        _providerService = providerService;
        _workspaceService = workspaceService;
        _oauthService = oauthService;
        _logger = logger;
    }

    public async Task ExecuteAsync(
        RunAgentInput input,
        Func<string, Task> sseWriter,
        Func<Task> onComplete,
        CancellationToken cancellationToken)
    {
        var threadId = input.ThreadId;
        var runId = input.RunId;
        var forwardedProps = input.ForwardedProps ?? [];

        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _activeCts[threadId] = linkedCts;
        var ct = linkedCts.Token;

        // 解析工作区路径（默认必须是本地根目录下的 workspace 目录）
        var workspaceRoot = forwardedProps.TryGetValue("workspaceRoot", out var wsObj) &&
                            wsObj is not null &&
                            !string.IsNullOrWhiteSpace(wsObj.ToString()) &&
                            !string.Equals(wsObj.ToString(), "DIRECT_CHAT", StringComparison.OrdinalIgnoreCase)
            ? wsObj.ToString()!
            : _workspaceService.CurrentWorkspaceRoot;

        // 解析模型提供商
        var providerId = forwardedProps.TryGetValue("providerId", out var pObj) && pObj is not null ? pObj.ToString() : null;
        var requestedModelId = forwardedProps.TryGetValue("modelId", out var mObj) && mObj is not null ? mObj.ToString() : null;

        // 联网搜索开关：仅当输入明确携带 webSearch=true 时才挂载 Exa 搜索工具，
        // 否则模型只能凭自身知识回答（兼容 bool 与 JSON JsonElement 两种反序列化形态）。
        var webSearchRaw = forwardedProps.TryGetValue("webSearch", out var wsFlagObj) && wsFlagObj is not null
            ? wsFlagObj.ToString()
            : null;
        var webSearchRequested = string.Equals(webSearchRaw, "True", StringComparison.OrdinalIgnoreCase)
            || string.Equals(webSearchRaw, "true", StringComparison.OrdinalIgnoreCase);

        // 计划模式约束开关：当 planEnabled=true 时，向 system prompt 注入约束指令
        var planEnabled = false;
        if (forwardedProps.TryGetValue("planEnabled", out var peObj) && peObj is not null)
        {
            if (peObj is bool b)
            {
                planEnabled = b;
            }
            else if (peObj is JsonElement je)
            {
                planEnabled = je.ValueKind == JsonValueKind.True
                    || (je.ValueKind == JsonValueKind.String && string.Equals(je.GetString(), "true", StringComparison.OrdinalIgnoreCase));
            }
            else
            {
                var s = peObj.ToString();
                planEnabled = string.Equals(s, "true", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(s, "True", StringComparison.OrdinalIgnoreCase);
            }
        }

        var llm = _configuration.GetSection(LlmOptions.SectionName).Get<LlmOptions>() ?? new LlmOptions();
        var provider = _providerService.GetActive(providerId);
        if (provider != null)
        {
            if (!string.IsNullOrWhiteSpace(provider.ApiKey)) llm.ApiKey = provider.ApiKey;
            if (!string.IsNullOrWhiteSpace(provider.BaseUrl)) llm.EndPoint = provider.BaseUrl;
            if (!string.IsNullOrWhiteSpace(requestedModelId)) llm.ModelId = requestedModelId;
            else if (!string.IsNullOrWhiteSpace(provider.DefaultModel)) llm.ModelId = provider.DefaultModel;
        }
        else if (!string.IsNullOrWhiteSpace(requestedModelId))
        {
            llm.ModelId = requestedModelId;
        }

        var adapter = new AguiStreamAdapter(runId, threadId, sseWriter, workspaceRoot);

        // agent-desktop（Computer Use）挂载句柄与挂载状态：在 try 内赋值，finally/catch 兜底释放与反馈
        ComputerUseHandle? desktopHandle = null;
        var computerUseMounted = false;

        try
        {
            // 0. 订阅登录（OAuth）厂商调用准备：解析此刻可用的密钥（Copilot 动态 Bearer、
            //    Qwen/Kimi 到期自动刷新）与必须附加的 HTTP 头；协议不兼容的厂商
            //    （Google / Anthropic 原生协议）直接拒绝本轮调用，不假装支持。
            IReadOnlyDictionary<string, string> oauthExtraHeaders = new Dictionary<string, string>();
            if (provider is { AuthMode: "oauth" })
            {
                var callPrep = await _oauthService.PrepareForCallAsync(provider, ct);
                if (callPrep.BlockedMessage != null)
                {
                    await adapter.EmitRunErrorAsync(callPrep.BlockedMessage);
                    return;
                }
                if (!string.IsNullOrWhiteSpace(callPrep.ApiKey)) llm.ApiKey = callPrep.ApiKey;
                if (callPrep.ExtraHeaders.Count > 0) oauthExtraHeaders = callPrep.ExtraHeaders;
            }

        // 1. 初始化文件存储与权限审核模式
        var permissionMode = forwardedProps.TryGetValue("permissionMode", out var pmObj) && pmObj is not null
            ? pmObj.ToString()?.ToLowerInvariant()
            : "ask";

        var fileAccess = _configuration.GetSection(FileAccessOptions.SectionName).Get<FileAccessOptions>() ?? new FileAccessOptions();
        if (permissionMode == "full")
        {
            fileAccess.DisableWriteToolApproval = true;
            fileAccess.DisableReadOnlyToolApproval = true;
        }
        else if (permissionMode == "auto")
        {
            fileAccess.DisableWriteToolApproval = true;
            fileAccess.DisableReadOnlyToolApproval = true;
        }
        else // ask: 写入与命令执行必须人工确认审批
        {
            fileAccess.DisableWriteToolApproval = false;
            fileAccess.DisableReadOnlyToolApproval = true;
        }

        var fileStore = new MultiDriveFileStore(fileAccess.DefaultDrive, workspaceRoot);
        fileStore.FileChanged += change =>
        {
            _ = adapter.RecordFileChangedAsync(change.Path, change.Before, change.After);
        };

            // 2. 联网搜索（Exa MCP）——仅当本轮请求开启 webSearch 时挂载
            var webSearch = _configuration.GetSection(WebSearchOptions.SectionName).Get<WebSearchOptions>() ?? new WebSearchOptions();
            IReadOnlyList<AITool>? webSearchTools = null;
            if (webSearch.Enabled && webSearchRequested)
            {
                using var startupCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                var (tools, _) = await WebSearchTools.TryCreateAsync(webSearch.Endpoint, webSearch.ApiKey, startupCts.Token);
                webSearchTools = tools;
            }

            // 2.1 计算机操作（agent-desktop MCP）——仅在设置启用 Computer Use 时挂载
            var computerUse = _configuration.GetSection(ComputerUseOptions.SectionName).Get<ComputerUseOptions>() ?? new ComputerUseOptions();
            var computerUseRequested = computerUse.Enabled;
            if (forwardedProps.TryGetValue("computerUseEnabled", out var cuObj) && cuObj is not null)
            {
                if (cuObj is bool cuBool)
                {
                    computerUseRequested = cuBool;
                }
                else if (cuObj is JsonElement cuJe)
                {
                    if (cuJe.ValueKind == JsonValueKind.True) computerUseRequested = true;
                    else if (cuJe.ValueKind == JsonValueKind.False) computerUseRequested = false;
                    else if (cuJe.ValueKind == JsonValueKind.String)
                    {
                        computerUseRequested = string.Equals(cuJe.GetString(), "true", StringComparison.OrdinalIgnoreCase);
                    }
                }
                else
                {
                    var cuStr = cuObj.ToString();
                    computerUseRequested = string.Equals(cuStr, "true", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(cuStr, "True", StringComparison.OrdinalIgnoreCase);
                }
            }

            IReadOnlyList<AITool>? computerUseTools = null;
            if (computerUse.Enabled && computerUseRequested)
            {
                try
                {
                    // 每轮独立挂载、轮末 finally 释放：desktop_* 工具绑定本轮的 MCP 客户端，
                    // 轮末随客户端一起关闭并兜底终结 node 进程树与 overlay 渲染子进程，不跨轮残留。
                    using var cuCts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                    var (cuHandle, cuErr) = await ComputerUseTools.MountAsync(computerUse.Command, computerUse.Args, cuCts.Token);
                    if (cuHandle != null)
                    {
                        desktopHandle = cuHandle;
                        computerUseTools = cuHandle.Tools;
                        computerUseMounted = true;
                    }
                    else if (!string.IsNullOrEmpty(cuErr))
                    {
                        _logger.LogWarning("[ComputerUse] agent-desktop MCP 启动未就绪，降级运行: {Error}", cuErr);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[ComputerUse] agent-desktop MCP 启动异常，降级运行");
                }
            }

            // 3. 长期记忆存储
            var memoryDir = Path.Combine(workspaceRoot, "agent-file-memory", "current");
            Directory.CreateDirectory(memoryDir);
            var memoryStore = new FileSystemAgentFileStore(memoryDir);

            // 4. 工作区人格与示例文档（供「文档子Agent」等主面板提示词开箱即用分析）
            Directory.CreateDirectory(workspaceRoot);
            EnsureSampleWorkspaceSpreadsheet(workspaceRoot);
            var agentsMdPath = Path.Combine(workspaceRoot, "AGENTS.md");
            if (!File.Exists(agentsMdPath))
            {
                const string defaultPersona = """
                    # Demo 助手

                    你是 MAF Harness 的全功能演示助手，名叫「kelefie」。请始终用中文与用户交流。

                    ## 行为约定

                    - 回答简洁直接，先给结论再给细节。
                    - 写文件、执行命令等有副作用的操作前，简单说明你要做什么。
                    - 涉及删除等危险操作，务必先征求用户同意。
                    - 工具分工与路径规则以系统提示里的使用规则为准。

                    ## 防空转（重要）

                    - 同一工具同样参数连续调用超过 2 次即为异常，立即换思路或求助用户。
                    - 单个任务尝试 3 次仍未成功，停下来向用户说明情况和已尝试的方案，请求指示。
                    """;
                File.WriteAllText(agentsMdPath, defaultPersona + "\n");
            }
            var workspacePersona = File.ReadAllText(agentsMdPath);
            if (planEnabled)
            {
                workspacePersona = workspacePersona.TrimEnd() + "\n\n## 计划模式约束\n先输出实施计划，等用户确认后再执行。\n";
            }

            // 5. 反思裁判状态
            var reflectionState = new ReflectionState
            {
                OnReflection = line => _ = adapter.RecordReflectionAsync(line)
            };

            var isResume = input.Resume != null && input.Resume.Count > 0;

            // 6. 装配 ChatClient 与 AIAgent（若是审批恢复续跑，必须复用同一个 AIAgent 实例，以确保 ToolApprovalAgent 内部挂起状态匹配！）
            var chatClient = llm.CreateChatClient(oauthExtraHeaders.Count > 0 ? oauthExtraHeaders : null);
            AIAgent agent;
            // 审批续跑复用既有 Agent；但若本轮 webSearch 开关与建 Agent 时不一致，
            // 必须重建（工具列表在创建时固化），保证开关即时生效。
            // 本轮挂载了 Computer Use 时也必须重建：desktop_* 工具绑定本轮独立挂载的
            // MCP 客户端，轮末随 finally 释放，复用旧 Agent 会拿到已关闭客户端的工具。
            var existingAgent = isResume ? _agents.GetValueOrDefault(threadId) : null;
            var hasCuTools = computerUseTools != null && computerUseTools.Count > 0;
            bool reuseExisting = existingAgent is not null
                && !hasCuTools
                && _agentWebSearch.TryGetValue(threadId, out var lastWebSearch)
                && lastWebSearch == webSearchRequested
                && _agentPlanEnabled.TryGetValue(threadId, out var lastPlanEnabled)
                && lastPlanEnabled == planEnabled
                && _agentComputerUse.TryGetValue(threadId, out var lastCu)
                && lastCu == hasCuTools;
            if (reuseExisting && existingAgent is not null)
            {
                agent = existingAgent;
            }
            else
            {
                agent = chatClient.AsHarnessAgent(FileAgentFactory.BuildOptions(
                    fileStore, chatClient, fileAccess, webSearchTools, memoryStore, workspacePersona, reflectionState, permissionMode ?? "ask", workspaceRoot, planEnabled, computerUseTools,
                    // llm.ModelId 是本轮解析后的实际模型（用户选择 > 厂商默认 > 全局默认），供运行时身份澄清使用
                    llm.ModelId));
                _agents[threadId] = agent;
                _agentWebSearch[threadId] = webSearchRequested;
                _agentPlanEnabled[threadId] = planEnabled;
                _agentComputerUse[threadId] = hasCuTools;
            }

            // 7. 获取或恢复会话
            var session = await GetOrCreateSessionAsync(agent, threadId, workspaceRoot, ct);

            // 8. 构造本轮执行输入
            ChatMessage message;
            if (isResume)
            {
                // 恢复人工审批
                _pendingApprovals.TryRemove(threadId, out var pending);
                pending ??= [];

                var responses = new List<AIContent>();
                foreach (var approval in pending)
                {
                    // 默认批准，除非前端明确指定 reject
                    var isRejected = input.Resume!.Any(r =>
                        "rejected".Equals(r.Status, StringComparison.OrdinalIgnoreCase) ||
                        (r.Payload is System.Text.Json.JsonElement je && je.TryGetProperty("type", out var t) && "reject".Equals(t.GetString(), StringComparison.OrdinalIgnoreCase)) ||
                        r.Payload?.ToString()?.Contains("reject", StringComparison.OrdinalIgnoreCase) == true);
                    responses.Add(approval.CreateResponse(!isRejected));
                }
                message = new ChatMessage(ChatRole.User, responses);
            }
            else
            {
                var lastUserText = ExtractLastUserText(input.Messages);
                reflectionState.LastUserInput = lastUserText;
                message = new ChatMessage(ChatRole.User, lastUserText);
            }

            var replyText = new System.Text.StringBuilder();
            var pendingApprovalsList = new List<ToolApprovalRequestContent>();

            // 9. 执行流式调用
            await foreach (var update in agent.RunStreamingAsync(message, session, cancellationToken: ct))
            {
                var isNonAssistantRole = update.Role is { } role && (role == ChatRole.User || role == ChatRole.System);
                if (isNonAssistantRole)
                {
                    await adapter.NotifyIterationBoundaryAsync();
                }

                foreach (var content in update.Contents)
                {
                    if (isNonAssistantRole && content is TextContent or TextReasoningContent)
                    {
                        continue;
                    }

                    if (content is TextContent text && !string.IsNullOrEmpty(text.Text))
                    {
                        replyText.Append(text.Text);
                    }
                    else if (content is ToolApprovalRequestContent approval)
                    {
                        pendingApprovalsList.Add(approval);
                    }

                    await adapter.HandleContentAsync(content);
                }
            }

            if (pendingApprovalsList.Count > 0)
            {
                // 审批中断
                _pendingApprovals[threadId] = pendingApprovalsList;
            }
            else
            {
                // 正常完成
                await adapter.EmitRunFinishedAsync();

                // 异步后台记忆沉淀与会话持久化
                var userText = reflectionState.LastUserInput ?? string.Empty;
                var assistantText = replyText.ToString();
                _ = Task.Run(async () =>
                {
                    await FlushMemoryAsync(chatClient, agent, session, reflectionState, userText, assistantText);
                    await PersistSessionAsync(agent, session, threadId, workspaceRoot);
                }, CancellationToken.None);
            }
        }
        catch (OperationCanceledException)
        {
            _logger.LogInformation("会话 [{ThreadId}] 执行已被客户端或用户取消", threadId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "会话 [{ThreadId}] 执行发生异常", threadId);
            // 任何异常都必须给用户可见的中文反馈（RUN_ERROR），尤其防止模型幻觉调用
            // 未挂载的 desktop_* 工具时静默断流（用户实测：输出一半就断开且无任何提示）。
            await adapter.EmitRunErrorAsync(BuildRunErrorMessage(ex, computerUseMounted));
        }
        finally
        {
            _activeCts.TryRemove(threadId, out _);
            // 轮末兜底释放本轮挂载的 agent-desktop MCP：关闭客户端并依据 pidfile
            // 终结 node 进程树、清理遗留的光标 overlay 渲染子进程（未挂载时为空操作）。
            await ComputerUseTools.ReleaseAsync(desktopHandle);
            await onComplete();
        }
    }

    /// <summary>
    /// 将任意执行异常转换为用户可见的中文友好错误信息（RUN_ERROR），保证前端一定收到反馈而非静默断流。
    /// Computer Use 相关异常（含模型幻觉调用未挂载的 desktop_* 工具）按真实挂载状态给出明确指引。
    /// </summary>
    private static string BuildRunErrorMessage(Exception err, bool computerUseMounted)
    {
        var chain = new System.Text.StringBuilder();
        var t = err;
        var depth = 0;
        while (t != null && depth < 6)
        {
            if (!string.IsNullOrEmpty(t.Message))
            {
                chain.Append(t.Message).Append(' ');
            }
            chain.Append(t.GetType().FullName).Append(' ');
            t = t.InnerException == t ? null : t.InnerException;
            depth++;
        }
        var lowered = chain.ToString().ToLowerInvariant();
        var computerUseRelated = lowered.Contains("computer-use") || lowered.Contains("computer_use")
            || lowered.Contains("computeruse") || lowered.Contains("desktop_")
            || lowered.Contains("agent-desktop");
        if (computerUseRelated)
        {
            return computerUseMounted
                ? "本轮执行中断：Computer Use 工具调用失败，请重试；若持续失败请检查「设置→电脑」页的 Computer Use 开关与配置。"
                : "本轮执行中断：Computer Use 未启用或调用失败，请在「设置→电脑」开启后重试。";
        }
        var first = !string.IsNullOrWhiteSpace(err.Message) ? err.Message.Trim() : err.GetType().Name;
        return "本轮执行中断：" + first;
    }

    public bool CancelThread(string threadId)
    {
        if (_activeCts.TryRemove(threadId, out var cts))
        {
            try
            {
                cts.Cancel();
                _pendingApprovals.TryRemove(threadId, out _);
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("取消线程 [{ThreadId}] 异常: {Error}", threadId, ex.Message);
            }
        }
        return false;
    }

    private async Task<AgentSession> GetOrCreateSessionAsync(
        AIAgent agent,
        string threadId,
        string workspaceRoot,
        CancellationToken ct)
    {
        if (_sessions.TryGetValue(threadId, out var existingSession))
        {
            return existingSession;
        }

        var sessionsDir = Path.Combine(workspaceRoot, "sessions");
        Directory.CreateDirectory(sessionsDir);
        var sessionFile = Path.Combine(sessionsDir, $"{threadId}.json");

        if (File.Exists(sessionFile))
        {
            try
            {
                var restored = JsonDocument.Parse(await File.ReadAllTextAsync(sessionFile, ct)).RootElement;
                var restoredSession = await agent.DeserializeSessionAsync(restored.Clone(), cancellationToken: ct);
                _sessions[threadId] = restoredSession;
                return restoredSession;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("无法从磁盘恢复会话 [{ThreadId}]: {Error}，将开启新会话", threadId, ex.Message);
            }
        }

        var newSession = await agent.CreateSessionAsync(ct);
        _sessions[threadId] = newSession;
        return newSession;
    }

    private async Task PersistSessionAsync(
        AIAgent agent,
        AgentSession session,
        string threadId,
        string workspaceRoot)
    {
        try
        {
            var sessionsDir = Path.Combine(workspaceRoot, "sessions");
            Directory.CreateDirectory(sessionsDir);
            var sessionFile = Path.Combine(sessionsDir, $"{threadId}.json");

            var json = await agent.SerializeSessionAsync(session);
            await File.WriteAllTextAsync(sessionFile, JsonSerializer.Serialize(json));
        }
        catch (Exception ex)
        {
            _logger.LogWarning("持久化会话 [{ThreadId}] 失败: {Error}", threadId, ex.Message);
        }
    }

    private async Task FlushMemoryAsync(
        IChatClient chatClient,
        AIAgent agent,
        AgentSession session,
        ReflectionState reflectionState,
        string userText,
        string assistantText)
    {
        try
        {
            if ((DateTime.UtcNow - _lastFlushAt).TotalSeconds < 30) return;
            if (string.IsNullOrWhiteSpace(userText) || string.IsNullOrWhiteSpace(assistantText)) return;
            if (assistantText.Length + userText.Length < 20) return;

            var extraction = await chatClient.GetResponseAsync(
            [
                new(ChatRole.System, """
                    从用户与助手的对话中提取值得跨会话长期记住的用户事实（称呼、偏好、背景、
                    项目、约定等）。只输出事实本身，简短中文，多条用分号分隔；
                    没有任何值得记住的内容时只输出 NONE。不要输出任何解释。
                    """),
                new(ChatRole.User, $"【原始请求】{Environment.NewLine}{userText}{Environment.NewLine}{Environment.NewLine}【最新回答】{Environment.NewLine}{assistantText}"),
            ]);

            var facts = extraction.Text?.Trim();
            if (string.IsNullOrEmpty(facts)
                || facts.Contains("NONE", StringComparison.OrdinalIgnoreCase)
                || facts.Length < 4)
            {
                return;
            }

            _lastFlushAt = DateTime.UtcNow;
            reflectionState.SuppressReflection = true;
            try
            {
                await agent.RunAsync(
                    "（系统维护消息，用户不可见，无需向用户复述）请把以下用户事实存入长期记忆：" + facts,
                    session,
                    cancellationToken: CancellationToken.None);
            }
            finally
            {
                reflectionState.SuppressReflection = false;
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug("记忆沉淀跳过: {Error}", ex.Message);
        }
    }

    /// <summary>
    /// 供微信 ClawBot (iLink 协议) 等外部 IM 通道直接调用个人 Agent 并获取完整文本回复
    /// </summary>
    public async Task<string> ExecuteTextPromptAsync(
        string threadId,
        string userText,
        CancellationToken cancellationToken = default)
    {
        var runId = "wx-" + Guid.NewGuid().ToString("N")[..10];
        var input = new RunAgentInput
        {
            ThreadId = threadId,
            RunId = runId,
            Messages =
            [
                new AguiMessage
                {
                    Id = "msg-" + Guid.NewGuid().ToString("N")[..8],
                    Role = "user",
                    Content = userText
                }
            ],
            ForwardedProps = new Dictionary<string, object?>
            {
                ["permissionMode"] = "full",
                ["workspaceRoot"] = _workspaceService.CurrentWorkspaceRoot
            }
        };

        var replyBuilder = new System.Text.StringBuilder();
        var processMessageIds = new HashSet<string>(StringComparer.Ordinal);
        string? errorMsg = null;

        await ExecuteAsync(
            input,
            chunk =>
            {
                // 解析 AG-UI SSE data 行中的最终总结 TEXT_MESSAGE_CONTENT delta（忽略 isProcess 中间过程消息）与 RUN_ERROR
                foreach (var line in chunk.Split('\n', StringSplitOptions.RemoveEmptyEntries))
                {
                    var trimmed = line.Trim();
                    if (!trimmed.StartsWith("data:", StringComparison.Ordinal)) continue;
                    var jsonPart = trimmed["data:".Length..].Trim();
                    if (string.IsNullOrEmpty(jsonPart)) continue;
                    try
                    {
                        using var doc = JsonDocument.Parse(jsonPart);
                        var root = doc.RootElement;
                        if (root.TryGetProperty("type", out var typeProp))
                        {
                            var eventType = typeProp.GetString();
                            if (eventType == AguiEventType.TEXT_MESSAGE_START &&
                                root.TryGetProperty("messageId", out var startIdProp) &&
                                root.TryGetProperty("isProcess", out var isProcProp) &&
                                isProcProp.ValueKind == JsonValueKind.True)
                            {
                                var msgId = startIdProp.GetString();
                                if (!string.IsNullOrEmpty(msgId))
                                {
                                    processMessageIds.Add(msgId);
                                }
                            }
                            else if (eventType == AguiEventType.TEXT_MESSAGE_CONTENT &&
                                     root.TryGetProperty("delta", out var deltaProp))
                            {
                                var msgId = root.TryGetProperty("messageId", out var idProp) ? idProp.GetString() : null;
                                if (msgId == null || !processMessageIds.Contains(msgId))
                                {
                                    replyBuilder.Append(deltaProp.GetString());
                                }
                            }
                            else if (eventType == AguiEventType.RUN_ERROR &&
                                     root.TryGetProperty("message", out var msgProp))
                            {
                                errorMsg = msgProp.GetString();
                            }
                        }
                    }
                    catch
                    {
                        // 忽略非 JSON 行
                    }
                }
                return Task.CompletedTask;
            },
            () => Task.CompletedTask,
            cancellationToken);

        var finalReply = replyBuilder.ToString().Trim();
        if (!string.IsNullOrEmpty(finalReply))
        {
            return finalReply;
        }
        if (!string.IsNullOrEmpty(errorMsg))
        {
            return $"⚠️ Agent 执行遇到问题：{errorMsg}";
        }
        return "我已收到您的消息并处理完成。";
    }

    private static void EnsureSampleWorkspaceSpreadsheet(string workspaceRoot)
    {
        try
        {
            var hasExcelOrPdf = Directory.EnumerateFiles(workspaceRoot, "*.xlsx", SearchOption.TopDirectoryOnly).Any()
                                || Directory.EnumerateFiles(workspaceRoot, "*.pdf", SearchOption.TopDirectoryOnly).Any();
            if (hasExcelOrPdf) return;

            var sampleXlsxPath = Path.Combine(workspaceRoot, "project-overview.xlsx");
            using var workbook = new ClosedXML.Excel.XLWorkbook();
            var sheet = workbook.Worksheets.Add("项目指标与条款");
            sheet.Cell(1, 1).Value = "编号";
            sheet.Cell(1, 2).Value = "模块/条款名称";
            sheet.Cell(1, 3).Value = "核心指标与配额";
            sheet.Cell(1, 4).Value = "当前达成值";
            sheet.Cell(1, 5).Value = "风险结论与建议";

            var rows = new (string Id, string Name, string Target, string Actual, string Risk)[]
            {
                ("SLA-01", "AG-UI 流式首字响应延迟 (TTFT)", "<= 800 ms", "420 ms", "低风险：达标，需持续监控高峰期网关抖动"),
                ("SLA-02", "多智能体并发任务吞吐率", ">= 50 会话/分钟", "68 会话/分钟", "低风险：并发会话隔离正常"),
                ("SEC-01", "高影响 Shell 与文件写入审批拦截率", "100% 强制拦截或策略放行", "100%", "合规：生产环境建议保持 ask/auto 审批模式"),
                ("MEM-01", "长期记忆单文件容量上限", "<= 64 KB / 文件", "48 KB", "中风险：接近阈值 75%，建议定期归档历史偏好记录"),
                ("COST-01", "月度模型 Token 预算与联网搜索配额", "Token <= 5000万 / Exa <= 1000次", "Token 3820万 / Exa 860次", "高关注：Exa 搜索额度已用 86%，需控制单次 numResults <= 5")
            };

            for (var i = 0; i < rows.Length; i++)
            {
                var r = i + 2;
                sheet.Cell(r, 1).Value = rows[i].Id;
                sheet.Cell(r, 2).Value = rows[i].Name;
                sheet.Cell(r, 3).Value = rows[i].Target;
                sheet.Cell(r, 4).Value = rows[i].Actual;
                sheet.Cell(r, 5).Value = rows[i].Risk;
            }

            workbook.SaveAs(sampleXlsxPath);
        }
        catch
        {
            // 忽略示例文档生成失败，不影响主流程
        }
    }

    private static string ExtractLastUserText(List<AguiMessage>? messages)
    {
        if (messages == null || messages.Count == 0) return "你好";
        for (var i = messages.Count - 1; i >= 0; i--)
        {
            var m = messages[i];
            if ("user".Equals(m.Role, StringComparison.OrdinalIgnoreCase))
            {
                return m.GetTextContent();
            }
        }
        return messages[^1].GetTextContent();
    }
}
