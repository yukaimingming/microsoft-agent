using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using MafHarness.Web.Models;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using TodoItem = MafHarness.Web.Models.TodoItem;

namespace MafHarness.Web.Services;

public sealed class AguiStreamAdapter
{
    private readonly string _runId;
    private readonly string _threadId;
    private readonly Func<string, Task> _sseWriter;
    private readonly string? _workspaceRoot;
    private readonly long _startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private bool _runStartedEmitted;
    private volatile bool _finished;

    // 当前思考流状态
    private string? _openReasoningId;

    // 当前正文流状态
    private string? _openTextId;
    private readonly StringBuilder _currentTextContent = new();
    private readonly StringBuilder _fullAnswer = new();

    // 工具调用参数与输出缓存
    private readonly ConcurrentDictionary<string, Activity> _activities = new();
    private readonly ConcurrentDictionary<string, StringBuilder> _toolArgBuffers = new();
    private readonly ConcurrentDictionary<string, StringBuilder> _toolOutputBuffers = new();
    private readonly ConcurrentDictionary<string, string> _toolPreContents = new();

    // 任务清单状态
    private readonly ConcurrentDictionary<int, (string Title, bool Done)> _todoItems = new();

    public AguiStreamAdapter(
        string runId,
        string threadId,
        Func<string, Task> sseWriter,
        string? workspaceRoot)
    {
        _runId = runId;
        _threadId = threadId;
        _sseWriter = sseWriter;
        _workspaceRoot = workspaceRoot;
    }

    public async Task EmitRunStartedAsync()
    {
        if (!_runStartedEmitted)
        {
            _runStartedEmitted = true;
            await EmitJsonAsync(new Dictionary<string, object?>
            {
                ["type"] = AguiEventType.RUN_STARTED,
                ["runId"] = _runId,
                ["threadId"] = _threadId
            });

            var snapshot = new RunSnapshot
            {
                Status = "running",
                RunId = _runId,
                ThreadId = _threadId,
                StartedAt = _startedAt,
                ProgressNote = "智能体已就绪，正在分析任务…"
            };
            await EmitRunSnapshotAsync(snapshot);
        }
    }

    public async Task HandleContentAsync(AIContent content)
    {
        await EmitRunStartedAsync();

        switch (content)
        {
            case TextReasoningContent reasoning when !string.IsNullOrEmpty(reasoning.Text):
                await HandleReasoningDeltaAsync(reasoning.Text);
                break;

            case TextContent text when !string.IsNullOrEmpty(text.Text):
                await HandleTextDeltaAsync(text.Text);
                break;

            case FunctionCallContent call:
                await HandleFunctionCallAsync(call);
                break;

            case FunctionResultContent result:
                await HandleFunctionResultAsync(result);
                break;

            case ToolApprovalRequestContent approval:
                await HandleApprovalRequestAsync(approval);
                break;

            case UsageContent usage:
                await HandleUsageAsync(usage);
                break;
        }
    }

    public async Task RecordReflectionAsync(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;

        // 作为过程活动推送到前端时间线（绝不作为文本消息去抢占正文槽位）
        var refId = "reflection:" + Guid.NewGuid().ToString("N")[..8];
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var refActivity = new Activity(
            refId,
            "reflection",
            "completed",
            "反思裁判评估",
            now)
        {
            RunId = _runId,
            Subtitle = line,
            EndedAt = now,
            DurationMs = 5,
            Detail = new ToolDetail("reflection_judge", new Dictionary<string, object?> { ["result"] = line })
            {
                Output = line
            }
        };
        _activities[refId] = refActivity;
        await EmitActivityAsync(refActivity);
    }

    public async Task RecordFileChangedAsync(string path, string? before, string after)
    {
        var fileDiff = CalculateDiff(path, before, after);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // 优先复用当前正在 running 的文件工具活动，注入 Diff 并更新完成状态，杜绝产生孤立 running 卡片
        var matchingActivity = _activities.Values.FirstOrDefault(a =>
            a.Kind == "file" &&
            (a.Status == "running" || a.EndedAt == 0) &&
            (string.IsNullOrEmpty(a.Subtitle) ||
             a.Subtitle.Equals(path, StringComparison.OrdinalIgnoreCase) ||
             a.Subtitle.EndsWith(Path.GetFileName(path), StringComparison.OrdinalIgnoreCase)));

        if (matchingActivity != null)
        {
            matchingActivity.Status = "completed";
            matchingActivity.Title = (before == null ? "新建" : "修改") + " · " + Path.GetFileName(path);
            matchingActivity.Subtitle = path;
            matchingActivity.EndedAt = now;
            matchingActivity.DurationMs = Math.Max(10, now - matchingActivity.StartedAt);
            if (matchingActivity.Detail is FileDetail fd)
            {
                fd.Diff = fileDiff;
                fd.Operation = before == null ? "write" : "edit";
                fd.Path = path;
            }
            else
            {
                matchingActivity.Detail = new FileDetail(path, before == null ? "write" : "edit")
                {
                    Diff = fileDiff
                };
            }
            await EmitActivityAsync(matchingActivity);
            return;
        }

        var callId = Guid.NewGuid().ToString("N")[..8];
        var fileActivityId = "file:" + callId;
        var fileActivity = new Activity(
            fileActivityId,
            "file",
            "completed",
            (before == null ? "新建" : "修改") + " · " + Path.GetFileName(path),
            now)
        {
            RunId = _runId,
            Subtitle = path,
            EndedAt = now,
            DurationMs = 10,
            Detail = new FileDetail(path, before == null ? "write" : "edit")
            {
                Diff = fileDiff
            }
        };

        _activities[fileActivityId] = fileActivity;
        await EmitActivityAsync(fileActivity);
    }

    private async Task StartReasoningAsync()
    {
        if (_openReasoningId == null)
        {
            _openReasoningId = "msg-reasoning-" + Guid.NewGuid();
            await EmitJsonAsync(new Dictionary<string, object?>
            {
                ["type"] = AguiEventType.REASONING_MESSAGE_START,
                ["messageId"] = _openReasoningId,
                ["role"] = "reasoning"
            });
            await EmitSnapshotProgressAsync("模型深度思考中…");
        }
    }

    private bool _inThinkingTag;

    private async Task HandleReasoningDeltaAsync(string delta)
    {
        // 若当前正文流已在输出且未被工具中断，则忽略正文中途零星的思考流重入，避免正文闪跳回思考链
        if (_openTextId != null)
        {
            return;
        }

        if (_openReasoningId == null)
        {
            await StartReasoningAsync();
        }

        await EmitJsonAsync(new Dictionary<string, object?>
        {
            ["type"] = AguiEventType.REASONING_MESSAGE_CONTENT,
            ["messageId"] = _openReasoningId,
            ["delta"] = delta
        });
    }

    private async Task EndReasoningAsync()
    {
        if (_openReasoningId != null)
        {
            await EmitJsonAsync(new Dictionary<string, object?>
            {
                ["type"] = AguiEventType.REASONING_MESSAGE_END,
                ["messageId"] = _openReasoningId
            });
            _openReasoningId = null;
        }
    }

    private async Task StartTextAsync()
    {
        await EndReasoningAsync();
        if (_openTextId == null)
        {
            _openTextId = "msg-text-" + Guid.NewGuid();
            _currentTextContent.Clear();
            await EmitJsonAsync(new Dictionary<string, object?>
            {
                ["type"] = AguiEventType.TEXT_MESSAGE_START,
                ["messageId"] = _openTextId,
                ["role"] = "assistant"
            });
        }
    }

    private async Task HandleTextDeltaAsync(string delta)
    {
        if (string.IsNullOrEmpty(delta))
            return;

        // 兼容模型在 TextContent 中夹带的 <think> 标签
        if (delta.Contains("<think>"))
        {
            _inThinkingTag = true;
            var parts = delta.Split("<think>", 2);
            if (!string.IsNullOrEmpty(parts[0]))
            {
                await AppendTextContentAsync(parts[0]);
            }
            if (!string.IsNullOrEmpty(parts[1]))
            {
                await HandleReasoningDeltaAsync(parts[1]);
            }
            return;
        }

        if (_inThinkingTag)
        {
            if (delta.Contains("</think>"))
            {
                _inThinkingTag = false;
                var parts = delta.Split("</think>", 2);
                if (!string.IsNullOrEmpty(parts[0]))
                {
                    await HandleReasoningDeltaAsync(parts[0]);
                }
                await EndReasoningAsync();
                if (!string.IsNullOrEmpty(parts[1]))
                {
                    await AppendTextContentAsync(parts[1]);
                }
                return;
            }

            await HandleReasoningDeltaAsync(delta);
            return;
        }

        await AppendTextContentAsync(delta);
    }

    private async Task AppendTextContentAsync(string delta)
    {
        if (_openTextId == null && string.IsNullOrWhiteSpace(delta))
            return;

        await EndReasoningAsync();

        if (_openTextId == null)
        {
            await StartTextAsync();
        }

        _fullAnswer.Append(delta);
        _currentTextContent.Append(delta);

        await EmitJsonAsync(new Dictionary<string, object?>
        {
            ["type"] = AguiEventType.TEXT_MESSAGE_CONTENT,
            ["messageId"] = _openTextId,
            ["delta"] = delta
        });
    }

    private async Task EndTextAsync()
    {
        if (_openTextId != null)
        {
            await EmitJsonAsync(new Dictionary<string, object?>
            {
                ["type"] = AguiEventType.TEXT_MESSAGE_END,
                ["messageId"] = _openTextId
            });
            _openTextId = null;
            _currentTextContent.Clear();
        }
    }

    private async Task HandleFunctionCallAsync(FunctionCallContent call)
    {
        await EndReasoningAsync();

        // 伴随过程说明标记
        if (_openTextId != null && !string.IsNullOrWhiteSpace(_currentTextContent.ToString()))
        {
            await EmitJsonAsync(new Dictionary<string, object?>
            {
                ["type"] = AguiEventType.CUSTOM,
                ["name"] = AguiEventType.CUSTOM_PROCESS_MESSAGE,
                ["value"] = new Dictionary<string, object?>
                {
                    ["messageId"] = _openTextId,
                    ["runId"] = _runId
                }
            });
            await EndTextAsync();
        }
        else if (_openTextId != null)
        {
            await EndTextAsync();
        }

        var callId = call.CallId ?? Guid.NewGuid().ToString("N")[..8];
        var toolName = call.Name;

        // 处理 todos_* 工具调用
        if (toolName.StartsWith("todos_", StringComparison.Ordinal))
        {
            ApplyTodoCall(toolName, call.Arguments);
            await EmitTodoActivityAsync();
            return;
        }

        // 处理子智能体委派调用
        if (toolName.StartsWith("background_agents_", StringComparison.Ordinal))
        {
            var subagentId = "subagent:" + callId;
            var agentName = call.Arguments?.TryGetValue("agentName", out var n) == true ? n?.ToString() ?? "subagent" : "subagent";
            var taskDesc = call.Arguments?.TryGetValue("description", out var d) == true ? d?.ToString() ?? "" : "";
            var subActivity = new Activity(
                subagentId,
                "subagent",
                "running",
                "子智能体 · " + agentName,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            {
                RunId = _runId,
                Subtitle = "执行中",
                Detail = new SubagentDetail(agentName, taskDesc)
            };
            _activities[subagentId] = subActivity;
            await EmitActivityAsync(subActivity);
            return;
        }

        // 常规工具卡片
        var toolActivityId = "tool:" + callId;
        var toolActivity = new Activity(
            toolActivityId,
            "tool",
            "running",
            toolName,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
        {
            RunId = _runId,
            Subtitle = "执行中",
            Detail = new ToolDetail(toolName, call.Arguments)
        };
        _activities[toolActivityId] = toolActivity;
        await EmitActivityAsync(toolActivity);

        // 如果是文件工具，同时创建 file 卡片
        if (IsFileTool(toolName))
        {
            var fileActivityId = "file:" + callId;
            var op = MapFileOp(toolName);
            var path = ExtractPath(call.Arguments);
            var fileActivity = new Activity(
                fileActivityId,
                "file",
                "running",
                $"{op} · {toolName}",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            {
                RunId = _runId,
                Subtitle = path,
                Detail = new FileDetail(path, op)
            };
            _activities[fileActivityId] = fileActivity;
            await EmitActivityAsync(fileActivity);
        }
    }

    private async Task HandleFunctionResultAsync(FunctionResultContent result)
    {
        var callId = result.CallId ?? string.Empty;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var rawOutput = result.Result?.ToString() ?? string.Empty;

        // 如果是 todos_* 结果
        if (result.Result is not null)
        {
            ApplyTodoResult(result.Result);
            await EmitTodoActivityAsync();
        }

        // 更新子智能体卡片
        var subagentId = "subagent:" + callId;
        if (_activities.TryGetValue(subagentId, out var subActivity))
        {
            subActivity.EndedAt = now;
            subActivity.DurationMs = Math.Max(0, now - subActivity.StartedAt);
            subActivity.Status = "completed";
            subActivity.Subtitle = "完成";
            if (subActivity.Detail is SubagentDetail sd)
            {
                sd.ResultSummary = rawOutput.Length > 1000 ? rawOutput[..1000] + "…" : rawOutput;
            }
            await EmitActivityAsync(subActivity);
            return;
        }

        // 更新工具卡片
        var toolActivityId = "tool:" + callId;
        if (_activities.TryGetValue(toolActivityId, out var toolActivity))
        {
            toolActivity.EndedAt = now;
            toolActivity.DurationMs = Math.Max(0, now - toolActivity.StartedAt);
            toolActivity.Status = "completed";
            toolActivity.Subtitle = "完成";
            if (toolActivity.Detail is ToolDetail td)
            {
                if (rawOutput.Length > 15000)
                {
                    td.Output = rawOutput[..15000] + "\n…(输出过长，已截断展示)";
                    td.Truncated = true;
                }
                else
                {
                    td.Output = rawOutput;
                    td.Truncated = false;
                }
            }
            await EmitActivityAsync(toolActivity);
        }

        // 更新文件卡片
        var fileActivityId = "file:" + callId;
        if (_activities.TryGetValue(fileActivityId, out var fileActivity))
        {
            fileActivity.EndedAt = now;
            fileActivity.DurationMs = Math.Max(0, now - fileActivity.StartedAt);
            fileActivity.Status = "completed";
            fileActivity.Subtitle = "完成";
            await EmitActivityAsync(fileActivity);
        }
    }

    private async Task HandleApprovalRequestAsync(ToolApprovalRequestContent approval)
    {
        await EndReasoningAsync();
        await EndTextAsync();

        var interruptId = "interrupt-" + Guid.NewGuid().ToString("N")[..8];
        var toolCall = approval.ToolCall as FunctionCallContent;
        var toolName = toolCall?.Name ?? "tool_approval";
        var arguments = toolCall?.Arguments;

        var approvalActivity = new Activity(
            "approval:" + interruptId,
            "approval",
            "waiting_approval",
            "审批请求：" + toolName,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
        {
            RunId = _runId,
            Subtitle = "该操作涉及敏感数据或文件写入，需要您的审批确认",
            Detail = new ApprovalDetail(toolName, arguments, "高影响操作人工审批")
        };
        _activities["approval:" + interruptId] = approvalActivity;
        await EmitActivityAsync(approvalActivity);

        var interruptItem = new InterruptItem(interruptId, "tool_approval", toolName, arguments);
        var snapshot = new RunSnapshot
        {
            Status = "waiting_approval",
            RunId = _runId,
            ThreadId = _threadId,
            StartedAt = _startedAt,
            ProgressNote = "等待用户人工确认审批…",
            Interrupts = [interruptItem]
        };
        await EmitRunSnapshotAsync(snapshot);

        await EmitJsonAsync(new Dictionary<string, object?>
        {
            ["type"] = AguiEventType.RUN_FINISHED,
            ["runId"] = _runId,
            ["threadId"] = _threadId,
            ["outcome"] = new Dictionary<string, object?>
            {
                ["type"] = "interrupt",
                ["interrupts"] = new List<InterruptItem> { interruptItem }
            }
        });

        _finished = true;
    }

    private async Task HandleUsageAsync(UsageContent usage)
    {
        if (usage.Details is { } d && (d.InputTokenCount.HasValue || d.OutputTokenCount.HasValue))
        {
            var runUsage = new RunUsage
            {
                InputTokens = (int?)d.InputTokenCount,
                OutputTokens = (int?)d.OutputTokenCount
            };
            var snapshot = new RunSnapshot
            {
                Status = "running",
                RunId = _runId,
                ThreadId = _threadId,
                StartedAt = _startedAt,
                ProgressNote = $"耗用 Token: 入 {runUsage.InputTokens ?? 0} / 出 {runUsage.OutputTokens ?? 0}",
                Usage = runUsage
            };
            await EmitRunSnapshotAsync(snapshot);
        }
    }

    public async Task EmitRunFinishedAsync()
    {
        if (_finished) return;
        _finished = true;
        await EndReasoningAsync();

        // 终极正文防丢兜底：若整轮执行了工具或文件变更但模型未产生最终正文答复，自动补充结构化结果总结
        if (string.IsNullOrWhiteSpace(_fullAnswer.ToString()))
        {
            var summary = BuildFallbackSummary();
            if (!string.IsNullOrEmpty(summary))
            {
                await StartTextAsync();
                await AppendTextContentAsync(summary);
            }
        }

        await EndTextAsync();

        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // 将还在运行中的活动标记完成
        foreach (var act in _activities.Values)
        {
            if (act.Status == "running" || act.Status == "waiting_approval")
            {
                act.Status = "completed";
                act.Subtitle = "完成";
                if (act.EndedAt == 0)
                {
                    act.EndedAt = now;
                    act.DurationMs = Math.Max(0, now - act.StartedAt);
                }
                await EmitActivityAsync(act);
            }
        }

        var snapshot = new RunSnapshot
        {
            Status = "completed",
            RunId = _runId,
            ThreadId = _threadId,
            StartedAt = _startedAt,
            EndedAt = now,
            DurationMs = now - _startedAt,
            ProgressNote = "任务已圆满完成"
        };
        await EmitRunSnapshotAsync(snapshot);

        await EmitJsonAsync(new Dictionary<string, object?>
        {
            ["type"] = AguiEventType.RUN_FINISHED,
            ["runId"] = _runId,
            ["threadId"] = _threadId,
            ["outcome"] = new Dictionary<string, object?> { ["type"] = "success" }
        });
    }

    public async Task EmitRunErrorAsync(string error)
    {
        if (_finished) return;
        _finished = true;
        await EndReasoningAsync();
        await EndTextAsync();

        await EmitJsonAsync(new Dictionary<string, object?>
        {
            ["type"] = AguiEventType.RUN_ERROR,
            ["runId"] = _runId,
            ["threadId"] = _threadId,
            ["message"] = error ?? "未知运行错误"
        });
    }

    private string BuildFallbackSummary()
    {
        var fileActs = _activities.Values.Where(a => a.Kind == "file").ToList();
        var toolActs = _activities.Values.Where(a => a.Kind == "tool" && !a.Id.StartsWith("reflection:")).ToList();

        if (fileActs.Count == 0 && toolActs.Count == 0 && _todoItems.IsEmpty)
        {
            return "已圆满完成本次任务分析与执行。";
        }

        var sb = new StringBuilder();
        if (fileActs.Count > 0)
        {
            sb.AppendLine("已成功完成工作区文件读写与行级修改操作，并生成了对应的行级 Diff 差异对比（可点击上方文件变更卡片展开查看红绿细节对比）。");
            foreach (var fa in fileActs)
            {
                if (fa.Detail is FileDetail fd && fd.Diff is { } diff)
                {
                    sb.AppendLine($"- **{Path.GetFileName(fd.Path ?? fa.Subtitle)}**：变更统计 `+{diff.Additions} / -{diff.Deletions}` 行，操作类型：`{fd.Operation}`。");
                }
            }
        }
        else if (toolActs.Count > 0)
        {
            sb.AppendLine("已成功调用相关工具完成处理，系统操作已按预期生效。");
        }
        else if (!_todoItems.IsEmpty)
        {
            var completed = _todoItems.Values.Count(v => v.Done);
            sb.AppendLine($"已规划并推进待办任务清单，当前进度：`{completed}/{_todoItems.Count}` 项已完成。");
        }

        return sb.ToString().TrimEnd();
    }

    private void ApplyTodoCall(string toolName, IDictionary<string, object?>? arguments)
    {
        if (arguments is null) return;
        if (toolName == "todos_complete" && arguments.TryGetValue("items", out var itemsObj))
        {
            var el = ToJsonElement(itemsObj);
            if (el is { ValueKind: JsonValueKind.Array })
            {
                foreach (var item in el.Value.EnumerateArray())
                {
                    if (item.TryGetProperty("id", out var idProp) && _todoItems.TryGetValue(idProp.GetInt32(), out var val))
                    {
                        _todoItems[idProp.GetInt32()] = (val.Title, true);
                    }
                }
            }
        }
        else if (toolName == "todos_remove" && arguments.TryGetValue("ids", out var idsObj))
        {
            var el = ToJsonElement(idsObj);
            if (el is { ValueKind: JsonValueKind.Array })
            {
                foreach (var idEl in el.Value.EnumerateArray())
                {
                    _todoItems.TryRemove(idEl.GetInt32(), out _);
                }
            }
        }
    }

    private void ApplyTodoResult(object? result)
    {
        var element = ToJsonElement(result);
        if (element is null) return;

        if (element.Value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.Value.EnumerateArray())
            {
                if (!item.TryGetProperty("id", out var idProp)) continue;
                var id = idProp.GetInt32();
                var title = item.TryGetProperty("title", out var t) ? t.GetString() ?? "(无标题)" : "(无标题)";
                var done = item.TryGetProperty("isComplete", out var d) && d.GetBoolean();
                _todoItems[id] = (title, done);
            }
        }
    }

    private async Task EmitTodoActivityAsync()
    {
        if (_todoItems.IsEmpty) return;
        var list = _todoItems.OrderBy(kv => kv.Key).Select(kv => new TodoItem(kv.Value.Title, kv.Value.Done ? "completed" : "pending")).ToList();
        var completed = list.Count(i => i.Status == "completed");
        var todoId = "todo:" + _runId;

        var todoActivity = new Activity(
            todoId,
            "todo",
            "running",
            "待办任务清单",
            _startedAt)
        {
            RunId = _runId,
            Subtitle = $"进行中 ({completed}/{list.Count})",
            Detail = new TodoDetail(list, completed, list.Count)
        };
        _activities[todoId] = todoActivity;
        await EmitActivityAsync(todoActivity);
    }

    private static FileDiff CalculateDiff(string path, string? before, string after)
    {
        var isCreated = string.IsNullOrEmpty(before);
        var bLines = string.IsNullOrEmpty(before) ? [] : before.Split(["\r\n", "\r", "\n"], StringSplitOptions.None);
        var aLines = string.IsNullOrEmpty(after) ? [] : after.Split(["\r\n", "\r", "\n"], StringSplitOptions.None);

        var lines = new List<FileDiff.DiffLine>();
        var additions = 0;
        var deletions = 0;

        if (isCreated)
        {
            for (var i = 0; i < aLines.Length; i++)
            {
                lines.Add(new FileDiff.DiffLine("add", aLines[i], null, i + 1));
                additions++;
            }
        }
        else if (string.IsNullOrEmpty(after))
        {
            for (var i = 0; i < bLines.Length; i++)
            {
                lines.Add(new FileDiff.DiffLine("delete", bLines[i], i + 1, null));
                deletions++;
            }
        }
        else
        {
            // 找出公共前缀
            var prefixLen = 0;
            while (prefixLen < bLines.Length && prefixLen < aLines.Length && bLines[prefixLen] == aLines[prefixLen])
            {
                lines.Add(new FileDiff.DiffLine("normal", bLines[prefixLen], prefixLen + 1, prefixLen + 1));
                prefixLen++;
            }

            // 找出公共后缀
            var suffixLen = 0;
            while (suffixLen < (bLines.Length - prefixLen) &&
                   suffixLen < (aLines.Length - prefixLen) &&
                   bLines[bLines.Length - 1 - suffixLen] == aLines[aLines.Length - 1 - suffixLen])
            {
                suffixLen++;
            }

            var bMidLen = bLines.Length - prefixLen - suffixLen;
            var aMidLen = aLines.Length - prefixLen - suffixLen;

            if (bMidLen > 0 || aMidLen > 0)
            {
                // LCS 计算中间差异
                var dp = new int[bMidLen + 1, aMidLen + 1];
                for (var i = 0; i < bMidLen; i++)
                {
                    for (var j = 0; j < aMidLen; j++)
                    {
                        if (bLines[prefixLen + i] == aLines[prefixLen + j])
                            dp[i + 1, j + 1] = dp[i, j] + 1;
                        else
                            dp[i + 1, j + 1] = Math.Max(dp[i + 1, j], dp[i, j + 1]);
                    }
                }

                // 回溯重构 diff 操作
                var midLines = new List<FileDiff.DiffLine>();
                var bi = bMidLen;
                var aj = aMidLen;

                while (bi > 0 || aj > 0)
                {
                    if (bi > 0 && aj > 0 && bLines[prefixLen + bi - 1] == aLines[prefixLen + aj - 1])
                    {
                        midLines.Add(new FileDiff.DiffLine("normal", bLines[prefixLen + bi - 1], prefixLen + bi, prefixLen + aj));
                        bi--;
                        aj--;
                    }
                    else if (aj > 0 && (bi == 0 || dp[bi, aj - 1] >= dp[bi - 1, aj]))
                    {
                        midLines.Add(new FileDiff.DiffLine("add", aLines[prefixLen + aj - 1], null, prefixLen + aj));
                        additions++;
                        aj--;
                    }
                    else if (bi > 0 && (aj == 0 || dp[bi, aj - 1] < dp[bi - 1, aj]))
                    {
                        midLines.Add(new FileDiff.DiffLine("delete", bLines[prefixLen + bi - 1], prefixLen + bi, null));
                        deletions++;
                        bi--;
                    }
                }

                midLines.Reverse();
                lines.AddRange(midLines);
            }

            // 追加公共后缀
            for (var i = 0; i < suffixLen; i++)
            {
                var bIdx = bLines.Length - suffixLen + i;
                var aIdx = aLines.Length - suffixLen + i;
                lines.Add(new FileDiff.DiffLine("normal", bLines[bIdx], bIdx + 1, aIdx + 1));
            }
        }

        var header = $"@@ -{(bLines.Length == 0 ? "0,0" : $"1,{bLines.Length}")} +{(aLines.Length == 0 ? "0,0" : $"1,{aLines.Length}")} @@";
        var diff = new FileDiff(path, isCreated ? "created" : "modified", additions, deletions)
        {
            BeforeContent = before,
            AfterContent = after,
            Hunks = [new FileDiff.DiffHunk(header, lines)]
        };

        var sb = new StringBuilder();
        sb.AppendLine(header);
        var count = 0;
        foreach (var l in lines)
        {
            if (count++ >= 400)
            {
                diff.Truncated = true;
                break;
            }
            switch (l.Type)
            {
                case "add": sb.AppendLine("+" + l.Text); break;
                case "delete": sb.AppendLine("-" + l.Text); break;
                default: sb.AppendLine(" " + l.Text); break;
            }
        }
        diff.Patch = sb.ToString().TrimEnd();
        return diff;
    }

    private static bool IsFileTool(string name) =>
        name.Contains("file", StringComparison.OrdinalIgnoreCase)
        || name.Contains("read", StringComparison.OrdinalIgnoreCase)
        || name.Contains("write", StringComparison.OrdinalIgnoreCase)
        || name.Contains("replace", StringComparison.OrdinalIgnoreCase)
        || name.Contains("delete", StringComparison.OrdinalIgnoreCase)
        || name.Contains("ls", StringComparison.OrdinalIgnoreCase)
        || name.Contains("grep", StringComparison.OrdinalIgnoreCase);

    private static string MapFileOp(string toolName)
    {
        if (toolName.Contains("read", StringComparison.OrdinalIgnoreCase)) return "read";
        if (toolName.Contains("write", StringComparison.OrdinalIgnoreCase)) return "write";
        if (toolName.Contains("replace", StringComparison.OrdinalIgnoreCase)) return "edit";
        if (toolName.Contains("delete", StringComparison.OrdinalIgnoreCase)) return "delete";
        if (toolName.Contains("ls", StringComparison.OrdinalIgnoreCase)) return "list";
        if (toolName.Contains("grep", StringComparison.OrdinalIgnoreCase)) return "grep";
        return "file";
    }

    private static string ExtractPath(IDictionary<string, object?>? arguments)
    {
        if (arguments is null) return string.Empty;
        foreach (var key in new[] { "path", "filePath", "file_path", "directory", "dir_path" })
        {
            if (arguments.TryGetValue(key, out var val) && val is not null)
                return val.ToString() ?? string.Empty;
        }
        return string.Empty;
    }

    private static JsonElement? ToJsonElement(object? value)
    {
        switch (value)
        {
            case null: return null;
            case JsonElement e: return e;
            case string s:
                try { return JsonSerializer.Deserialize<JsonElement>(s); } catch { return null; }
            default:
                try { return JsonSerializer.SerializeToElement(value); } catch { return null; }
        }
    }

    private async Task EmitSnapshotProgressAsync(string note)
    {
        var snapshot = new RunSnapshot
        {
            Status = "running",
            RunId = _runId,
            ThreadId = _threadId,
            ProgressNote = note
        };
        await EmitRunSnapshotAsync(snapshot);
    }

    private Task EmitActivityAsync(Activity activity) =>
        EmitJsonAsync(new Dictionary<string, object?>
        {
            ["type"] = AguiEventType.CUSTOM,
            ["name"] = AguiEventType.CUSTOM_ACTIVITY,
            ["value"] = activity
        });

    private Task EmitRunSnapshotAsync(RunSnapshot snapshot) =>
        EmitJsonAsync(new Dictionary<string, object?>
        {
            ["type"] = AguiEventType.CUSTOM,
            ["name"] = AguiEventType.CUSTOM_RUN_SNAPSHOT,
            ["value"] = snapshot
        });

    private async Task EmitJsonAsync(object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
            });
            await _sseWriter($"data: {json}\n\n");
        }
        catch
        {
            // 客户端断开连接时忽略
        }
    }
}
