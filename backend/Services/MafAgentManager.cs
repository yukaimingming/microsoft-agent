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
    private readonly ILogger<MafAgentManager> _logger;

    // 会话与执行管理
    private readonly ConcurrentDictionary<string, AgentSession> _sessions = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _activeCts = new();
    private readonly ConcurrentDictionary<string, List<ToolApprovalRequestContent>> _pendingApprovals = new();

    // 记忆沉淀节流
    private DateTime _lastFlushAt = DateTime.MinValue;

    public MafAgentManager(
        IConfiguration configuration,
        ProviderService providerService,
        WorkspaceService workspaceService,
        ILogger<MafAgentManager> logger)
    {
        _configuration = configuration;
        _providerService = providerService;
        _workspaceService = workspaceService;
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

        // 解析工作区路径
        var workspaceRoot = forwardedProps.TryGetValue("workspaceRoot", out var wsObj) && wsObj is not null && !string.IsNullOrWhiteSpace(wsObj.ToString())
            ? wsObj.ToString()!
            : _workspaceService.CurrentWorkspaceRoot;

        // 解析模型提供商
        var providerId = forwardedProps.TryGetValue("providerId", out var pObj) && pObj is not null ? pObj.ToString() : null;
        var requestedModelId = forwardedProps.TryGetValue("modelId", out var mObj) && mObj is not null ? mObj.ToString() : null;

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

        try
        {
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

        var fileStore = new MultiDriveFileStore(fileAccess.DefaultDrive);
        fileStore.FileChanged += change =>
        {
            _ = adapter.RecordFileChangedAsync(change.Path, change.Before, change.After);
        };

            // 2. 联网搜索（Exa MCP）
            var webSearch = _configuration.GetSection(WebSearchOptions.SectionName).Get<WebSearchOptions>() ?? new WebSearchOptions();
            IReadOnlyList<AITool>? webSearchTools = null;
            if (webSearch.Enabled)
            {
                using var startupCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                var (tools, _) = await WebSearchTools.TryCreateAsync(webSearch.Endpoint, webSearch.ApiKey, startupCts.Token);
                webSearchTools = tools;
            }

            // 3. 长期记忆存储
            var memoryDir = Path.Combine(workspaceRoot, "agent-file-memory", "current");
            Directory.CreateDirectory(memoryDir);
            var memoryStore = new FileSystemAgentFileStore(memoryDir);

            // 4. 工作区人格
            Directory.CreateDirectory(workspaceRoot);
            var agentsMdPath = Path.Combine(workspaceRoot, "AGENTS.md");
            if (!File.Exists(agentsMdPath))
            {
                const string defaultPersona = """
                    # Demo 助手

                    你是 MAF Harness 的全功能演示助手，名叫「小哈」。请始终用中文与用户交流。

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

            // 5. 反思裁判状态
            var reflectionState = new ReflectionState
            {
                OnReflection = line => _ = adapter.RecordReflectionAsync(line)
            };

            // 6. 装配 ChatClient 与 AIAgent
            var chatClient = llm.CreateChatClient();
            var agent = chatClient.AsHarnessAgent(FileAgentFactory.BuildOptions(
                fileStore, chatClient, fileAccess, webSearchTools, memoryStore, workspacePersona, reflectionState));

            // 7. 获取或恢复会话
            var session = await GetOrCreateSessionAsync(agent, threadId, workspaceRoot, ct);

            // 8. 构造本轮执行输入
            ChatMessage message;
            var isResume = input.Resume != null && input.Resume.Count > 0;
            if (isResume)
            {
                // 恢复人工审批
                _pendingApprovals.TryRemove(threadId, out var pending);
                pending ??= [];

                var responses = new List<AIContent>();
                foreach (var approval in pending)
                {
                    // 默认全批准，除非状态明确为 rejected
                    var allApproved = input.Resume!.All(r => !"rejected".Equals(r.Status, StringComparison.OrdinalIgnoreCase));
                    responses.Add(approval.CreateResponse(allApproved));
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
                foreach (var content in update.Contents)
                {
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
            await adapter.EmitRunErrorAsync(ex.Message);
        }
        finally
        {
            _activeCts.TryRemove(threadId, out _);
            await onComplete();
        }
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
