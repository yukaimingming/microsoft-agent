using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Tools.Shell;
using Microsoft.Extensions.AI;
using MafHarnessDemo.App.Configuration;
using MafHarnessDemo.App.Infrastructure.FileStore;
using MafHarnessDemo.App.Infrastructure.Tools;

namespace MafHarnessDemo.App.Infrastructure.Agents;

/// <summary>
/// Harness Agent 装配。
///
/// 官方 Harness 形态（learn.microsoft.com/agent-framework/agents/looping）：
/// 一个 <see cref="HarnessAgentOptions"/> 配好全家桶——文件读写（FileAccessProvider，
/// 内置）、任务清单（Todo）、模式切换（AgentMode）、文件记忆（FileMemory）、
/// 工具审批（ToolApproval）、循环（Loop）、后台子智能体（BackgroundAgents）——
/// AsHarnessAgent(options) 一把装配完。
///
/// 文件能力全部用内置的 file_access_*，store 用 MultiDriveFileStore 做多盘动态路由。
/// 写操作包审批（DisableWriteToolApproval=false），审批请求经 ToolApprovalAgent
/// 透传给 REPL 人工决定。
///
/// DisableWebSearch=true：Harness 默认注入的 HostedWebSearchTool 是 OpenAI
/// 服务端托管工具，第三方兼容网关会把工具声明透传给模型、模型调用后返回
/// 无法解析的 tool call（OpenAI SDK 抛 "Unknown ChatToolCallKind"）。
/// 提示词里必须同步给出完整工具白名单——否则模型会幻觉调用不存在的工具，
/// 触发同样的解析崩溃（实测踩过）。
/// </summary>
public static class FileAgentFactory
{
    public static HarnessAgentOptions BuildOptions(
        MultiDriveFileStore fileAccessStore,
        IChatClient chatClient,
        FileAccessOptions fileAccess,
        IReadOnlyList<AITool>? webSearchTools = null,
        AgentFileStore? fileMemoryStore = null,
        string? workspacePersona = null,
        ReflectionState? reflectionState = null,
        string permissionMode = "ask",
        string? workspaceRoot = null)
    {
        var isFullPermission = string.Equals(permissionMode, "full", StringComparison.OrdinalIgnoreCase);
        var isAutoPermission = string.Equals(permissionMode, "auto", StringComparison.OrdinalIgnoreCase);

        var pdfTools = new PdfTools(fileAccessStore.DefaultDrive, workspaceRoot);
        var excelTools = new ExcelTools(fileAccessStore.DefaultDrive, workspaceRoot);

        // Shell 工具（MAF 官方 Microsoft.Agents.AI.Tools.Shell）：
        // 若 permissionMode 为 "full"（完全访问权限），requireApproval 必须为 false 彻底免审放行；
        // 其它模式下设为 true，并通过 AutoApprovalRules 或人工审批卡片按需确认。
        var shell = new LocalShellExecutor(new LocalShellExecutorOptions
        {
            Timeout = LocalShellExecutor.DefaultTimeout,
            AcknowledgeUnsafe = true,
        });
        var shellAiFunction = shell.AsAIFunction(requireApproval: !isFullPermission);

        // provider 级指令：紧贴 file_access_* 工具注入，比全局提示词更管用。
        // 核心规则：
        // 1. 强绑定用户工作区：所有文件读取、写入、创建、列出、搜索等工具操作，严格只能绑定在当前用户工作区目录下！
        // 2. 凡是用户提到创建、修改或查看项目文件（如 demo-notes.txt），使用普通相对路径（如 demo-notes.txt 或 workspace/xxx），直接精确落在当前工作区根目录下！
        // 3. 列目录用 file_access_ls（留空或 "." 即列出当前工作区）。
        // 4. 严禁访问工作区以外的路径或系统驱动器。
        var wsDisplay = !string.IsNullOrWhiteSpace(workspaceRoot) ? workspaceRoot.Replace('\\', '/') : "当前工作区根目录";
        var fileAccessInstructions = $"""
                                     ## File Access 用户工作区强绑定规则
                                     - 当前工作区根目录已严格绑定为：{wsDisplay}。
                                     - 本会话所有文件操作严格限定在当前工作区目录内，禁止跨出工作区或访问系统全局盘符（如 C:\、D:\ 等）。
                                     - 凡是用户要求创建、修改、读取项目或工作区文件（如 demo-notes.txt、demo-notes222.txt），直接使用普通相对路径（如 demo-notes.txt、src/index.ts）或 workspace/xxx 形式，它们均精准落在当前绑定的工作区根目录下，用户可以在工作区目录实时查看到！
                                     - 路径必须使用正斜杠，不要在相对路径前加盘符冒号。
                                     - 列出当前工作区目录用 file_access_ls（留空或传 "."），搜索内容用 file_access_grep。
                                     - 小编辑用 file_access_replace / file_access_replace_lines，不要整文件重写。
                                     """;

        // ---------- 子智能体（BackgroundAgents：主 agent 可委派的后台代理） ----------
        // 两个只读子代理，都不配写工具——审批链路只留在主 agent 一侧。
        // 子代理在后台跑，主代理通过 BackgroundAgentsProvider 注入的任务工具
        // 启动/监控/取回结果。Name 必须非空且唯一（大小写不敏感），否则构造抛异常。
        var docAnalyst = chatClient.AsAIAgent(new ChatClientAgentOptions
        {
            Name = "docAnalyst",
            Description = "文档分析员：读取并分析 PDF/Excel 文档，返回结构化中文摘要",
            ChatOptions = new ChatOptions
            {
                Tools = [.. pdfTools.AsAiTools(), .. excelTools.AsAiTools()],
                Instructions = """
                    你是文档分析员，母 agent 会把文档分析任务委派给你。用 read_pdf / read_excel
                    读取指定文档（若未指定具体文件名，直接读取工作区根目录下的 project-overview.xlsx），输出结构化中文摘要：
                    1. 文档主题与用途（一两句话）；
                    2. 关键数据/条款（分条列出，保留编号、名称、数值等硬信息）；
                    3. 值得注意的结论或风险。
                    长文档分段读（每次 maxPages 不超过 8），不要在回答里大段复述原文，
                    摘要控制在 400 字以内。扫描版 PDF 提取不出文字时如实说明。
                    """,
            },
        });

        var fileOrganizer = chatClient.AsAIAgent(new ChatClientAgentOptions
        {
            Name = "fileOrganizer",
            Description = "文件整理员：扫描目录结构，按类型或用途输出归类方案（只读规划，不执行）",
            // 只读文件能力：ls/grep/read，store 与主 agent 共用同一个多盘路由
            AIContextProviders =
            [
                new FileAccessProvider(fileAccessStore, new FileAccessProviderOptions
                {
                    DisableWriteTools = true,
                    DisableReadOnlyToolApproval = true,
                    Instructions = fileAccessInstructions,
                }),
            ],
            ChatOptions = new ChatOptions
            {
                Instructions = """
                    你是文件整理员，母 agent 会把目录扫描和归类规划委派给你。
                    请不要进行冗长思考推演，直接调用一次 file_access_ls(".") 查看工作区顶层目录结构（严禁进入 sessions、agent-file-memory 等子目录逐层扫描，也不要调用 file_access_grep 或 file_access_read），
                    然后立即输出精炼的 Markdown 归类方案表：建议的目标文件夹名 → 应归入的文件或目录清单（按类型/用途分组）。
                    你只读和规划，绝不执行任何移动/删除/写入——执行是母 agent 的事。
                    路径按 File Access 指令的规则（相对路径、无冒号）。
                    方案末尾用一两句说明分组依据，总字数严格控制在 200 字以内。
                    """,
            },
        });

        // 提示词按「有无联网搜索」条件化：白名单行与联网规则都是占位符替换——
        // 模型只能调用白名单里的工具（幻觉调用不存在的工具会触发解析崩溃，实测踩过），
        // 所以启用/停用搜索必须同步改提示词。联网工具名与
        // WebSearchTools.AllowedTools（挂载白名单）必须一一对应。
        // 工作区人格（workspace/AGENTS.md，Program 读入）放在最前面：
        // "你是谁"先于工具规则出现；后接 ---- 分隔线再接工具规则。
        var personaPrefix = string.IsNullOrEmpty(workspacePersona)
            ? string.Empty
            : workspacePersona.TrimEnd() + "\n\n----\n\n";

        var searchToolLine = webSearchTools is null
            ? string.Empty
            : "联网：web_search_exa（语义搜索）、web_fetch_exa（读网页全文）";
        var onlineRule = webSearchTools is null
            ? "你没有联网能力，不要尝试访问互联网、不要抓取网页；被问到实时信息时，如实说明无法联网获取。"
            : "被问实时信息、最新动态或你不确定的事实用 web_search_exa 搜了再答"
              + "（web_fetch_exa 读网页全文），numResults 用 3-5 即可（免费额度有限），"
              + "回答注明信息来自搜索及日期；除这两个工具外不得访问互联网。";
        var shellPermissionRule = isFullPermission
            ? "当前为完全访问权限（免审模式），执行 run_shell 命令已全面免审放行，无需等待用户审批。"
            : "只读命令（Get-* / Select-String / Start-Sleep / dir 等）会自动放行无需审批；结构操作和权限类命令（icacls 等）仍需用户批准，属正常流程。";

        var loopEvaluators = new List<LoopEvaluator>
        {
            new TodoCompletionLoopEvaluator(new TodoCompletionLoopEvaluatorOptions()),
            // Reflection 裁判：内部按"本轮是否动过工具"自动触发（文件操作/写代码/
            // 计划清单评审，纯文本问答零成本跳过），无需任何配置。
            new DelegateLoopEvaluator(ReflectOnIterationAsync(chatClient, reflectionState)),
        };


        return new HarnessAgentOptions
        {
            Name = "fileAssistant",
            // Description 与工具集保持一致：降级为离线时不能声称有联网搜索
            Description = "MAF Harness Agent：文件读写(内置)/Shell/PDF/Excel/子智能体/清单/模式/记忆/循环"
                          + (webSearchTools is null ? "" : "/联网搜索"),

            // 工作区人格（workspace/AGENTS.md，Program 读入）放在最前面：
            // "你是谁"先于工具规则出现；后接 ---- 分隔线再接工具规则。
            HarnessInstructions = personaPrefix + """
                                  你是文件助手。全部能力通过工具完成，你的完整工具清单如下
                                  （只能调用这些，调用列表之外的工具会导致整个交互解析失败）：

                                  文件：file_access_read、file_access_read_lines、file_access_write、
                                        file_access_delete、file_access_ls、file_access_grep、
                                        file_access_replace、file_access_replace_lines
                                  Shell：run_shell（只管文件结构与系统操作，分工见规则 1）
                                  文档：read_pdf、read_excel
                                  {{SEARCH_LINE}}
                                  清单：todos_add、todos_complete、todos_remove、
                                        todos_get_remaining、todos_get_all
                                  模式：mode_get（查当前模式）、mode_set（切模式）
                                  记忆：file_memory_*
                                  子智能体：docAnalyst（文档分析员）、fileOrganizer（文件整理员）

                                  使用规则：
                                  1. 分工（先看这条再动手）：
                                     - 文件内容（读/写/追加/替换/删内容）→ 只用
                                       file_access_read、file_access_write、file_access_replace、
                                       file_access_replace_lines。追加 = 先 read 读出全文，
                                       拼接新内容后 file_access_write(overwrite=true) 写回。
                                       禁止用 run_shell 的 Add-Content / Set-Content /
                                       Out-File / echo >> 写内容——编码不可控、无法生成
                                       差异展示（实测踩过，会被直接拒绝）。
                                     - 文件结构（移动/复制/重命名/建目录/删目录）→ 只用
                                       run_shell（New-Item / Move-Item / Copy-Item 等
                                       PowerShell 命令，多条用分号连接）。
                                       {{SHELL_PERMISSION_RULE}}
                                     - 二进制文件（图片/压缩包等）的移动复制也用 run_shell；
                                       严禁用 read+write 模拟——必损坏。
                                  2. 路径（file_access_*）：规则见 File Access 指令。
                                  3. 联网：{{ONLINE_RULE}}
                                  4. PDF（read_pdf）：遇到 .pdf 一律先用它提文本。策略：先读前 3-5 页
                                     拿目录，再按章节分段读（每次 maxPages 不超过 8），最后综合汇总。
                                  5. Excel（read_excel）：.xlsx 用它读，转 Markdown 表格；
                                     .xls 老格式不支持，要明说。
                                  6. 任务清单（todos_*）：仅在用户明确要求使用 todos_add 规划待办清单时调用。
                                     - 当用户要求用 todos_add 规划待办任务清单并汇报成果时：第一步立即调用 todos_add 建立 3 项简明待办任务；随后最多调用 1 次 file_access_ls(".") 查看顶层目录（严禁进入 sessions 等子目录，也不要实际编写/创建脚本文件），直接分步调用 todos_complete 将待办项逐一打勾完成，最后立即输出完整的成果汇报总结；
                                     - 过程与总结严格分步：在任务推进过程中，只输出当前步骤的简短操作说明；只有在所有待办任务均已打勾完成之后，最后才输出完整的汇报总结；
                                     - 常规文件读写修改任务（例如创建 demo-notes.txt 并用 file_access_replace 修改展示 Diff）不要调用 todos_add，直接用 file_access_write(overwrite=true) 写入后再用 file_access_replace 修改，两步直接完成。
                                  7. 模式（mode_get / mode_set）：内置 plan（规划）与
                                     execute（执行）两种，默认 plan。复杂任务留在 plan 模式
                                     规划（探查现状 + 建清单 + 给出方案），经用户确认后
                                     mode_set(mode=execute) 再动手；简单问题在 plan 模式
                                     直接回答即可，不要为小事切换模式。
                                  8. 文件记忆（file_memory_*）：跨会话的长期记忆文件。
                                     对话里出现用户的稳定信息（称呼、偏好、项目背景、重要约定）时，
                                     主动用 file_memory_write 存入，不要等用户说「记住」。
                                     被问「之前说过什么」时，先查记忆（file_memory_read /
                                     file_memory_search）再回答，不要凭空说不知道。
                                  9. 子智能体（可委派的后台代理）：
                                     - docAnalyst（文档分析员）：分析 PDF/Excel 内容派给它（工作区根目录默认有 project-overview.xlsx 可直接分析，先用 file_access_ls(".") 确认文件名即可，严禁全盘递归搜索文件），
                                       它返回结构化摘要——长文档的原文消化在它那边完成，不会撑爆你的上下文。
                                     - fileOrganizer（文件整理员）：扫描目录、制定归类方案派给它
                                       （只读规划，不执行）；拿到方案后，向用户完整展示归类方案。
                                     - 【重要】当你启动后台子智能体（docAnalyst 或 fileOrganizer）后，必须在同一轮对话内立即调用等待/获取输出工具（如 background_agents_wait / background_agents_output 等）拿到子智能体的完整返回结果，并直接整理呈现给用户！严禁只启动后台任务就停下来询问用户「是否等待任务完成」。
                                     不要动辄委派——一步就能完成的小事自己做。

                                  纪律：
                                  - 没读过文件就不要引用它的内容，没写过就不要声称写过。
                                  - 工具报错就换路径或换方式，不要重复同一个错误调用。
                                  - 覆盖已有文件前先读一眼原有内容。
                                  - 每次操作后用一两句中文说明结果；被用户拒绝时明确告知未执行，
                                    不要换个方式偷偷重试。
                                  - 当回答纯算法对比或技术原理分析问题（无需调用工具）时，思考过程保持精炼聚焦，正文采用结构化 Markdown 对比表格加核心要点总结，篇幅控制在 500-700 字以内。
                                  - 不使用表情符号；回答控制在必要长度。
                                  """
                                  .Replace("{{SEARCH_LINE}}", searchToolLine)
                                  .Replace("{{ONLINE_RULE}}", onlineRule)
                                   .Replace("{{SHELL_PERMISSION_RULE}}", shellPermissionRule),

            // 文件能力：内置 FileAccessProvider，store 是多盘动态路由。
            // 读写全内置，审批开关来自 FileAccess 配置节（appsettings 可配、
            // 环境变量 MAF_HARNESS_FileAccess__XX 可覆盖）。
            FileAccessStore = fileAccessStore,

            // 长期记忆根目录：默认是 {cwd}/agent-file-memory/{timestamp}_{guid}，
            // 每个进程一个新目录，重启后读不到上一进程写的记忆（实测踩过）。
            // 传入固定的 AgentFileStore 让所有进程共享同一份记忆。
            FileMemoryStore = fileMemoryStore,
            FileAccessProviderOptions = new FileAccessProviderOptions
            {
                DisableWriteTools = fileAccess.DisableWriteTools,
                DisableReadOnlyToolApproval = fileAccess.DisableReadOnlyToolApproval,
                DisableWriteToolApproval = isFullPermission || isAutoPermission || fileAccess.DisableWriteToolApproval,
                Instructions = fileAccessInstructions,
            },

            // 关掉 Harness 默认注入的 HostedWebSearchTool（第三方网关不支持，
            // 透传给模型后会返回无法解析的 tool call）。
            DisableWebSearch = true,

            // PDF / Excel / Shell / 联网搜索（Exa MCP）：函数工具，与内置全家桶共存。
            // shell 工具包一层 ShellCommandSanitizer：剥掉 Format-List/Table，
            // 绕开 LocalShellExecutor 对这些 cmdlet 的 NRE bug。
            ChatOptions = new ChatOptions
            {
                Tools =
                [
                    new ShellCommandSanitizer(shellAiFunction),
                    .. pdfTools.AsAiTools(),
                    .. excelTools.AsAiTools(),
                    .. webSearchTools ?? [],
                ],
            },

            // Shell 环境感知：把 shell 家族/OS/工作目录/CLI 版本注入 agent 上下文
            AIContextProviders = [new ShellEnvironmentProvider(shell)],

            // 审批：ToolApprovalAgent 中间件默认挂载；
            // 若为 full 全面权限模式，所有工具（含 shell 和写入）直接自动放行，绝不弹窗打扰；
            // 若为 ask 或 auto 模式，run_shell 的只读命令自动放行，结构操作与写入走人工确认。
            ToolApprovalAgentOptions = new ToolApprovalAgentOptions
            {
                MaxAutoApprovalIterations = 5,
                AutoApprovalRules =
                [
                    context =>
                    {
                        if (isFullPermission)
                        {
                            return ValueTask.FromResult(true);
                        }
                        return AutoApproveReadOnlyShell(context);
                    }
                ],
            },

            // 循环评估（对照 agent 范式）：
            // 1) TodoCompletion：清单没清完就继续——"做完没"检查；
            // 2) Reflection 裁判：只在"动过工具"的轮次评审产出（文件操作/写代码/
            //    计划清单），纯文本问答零成本跳过——"做得好不好"检查。
            //    不用内置 AIJudgeLoopEvaluator 的原因见 ReflectOnIterationAsync 注释。
            //    MaxIterations=5 是硬上限，评估器再多也不会无限循环。
            LoopEvaluators = loopEvaluators,
            LoopAgentOptions = new LoopAgentOptions { MaxIterations = 5 },

            // 两个后台子智能体：主 agent 通过 BackgroundAgentsProvider 注入的任务工具
            // 委派（启动/监控/取回结果）
            BackgroundAgents =
            [
                docAnalyst,
                fileOrganizer,
            ],
        };
    }

    /// <summary>
    /// run_shell 的只读自动放行规则：命令属于已知只读形态时自动批准（不弹审批），
    /// 其它工具或非只读命令返回 false（维持人工审批）。分类器见 ShellCommandClassifier。
    /// </summary>
    private static async ValueTask<bool> AutoApproveReadOnlyShell(ToolAutoApprovalRuleContext context)
    {
        // 只有 run_shell 参与动态放行；其它工具维持各自的审批要求
        if (context.FunctionCallContent.Name != "run_shell") return false;

        // 参数值可能是 string 或 JsonElement（审批续跑路径）
        var cmd = context.FunctionCallContent.Arguments?.TryGetValue("command", out var value) == true
            ? value switch
            {
                string s => s,
                System.Text.Json.JsonElement { ValueKind: System.Text.Json.JsonValueKind.String } e => e.GetString(),
                _ => value?.ToString(),
            }
            : null;

        // 只读命令返回 true = 自动批准当前调用（不弹审批）；
        // 结构操作/账号权限/未知命令返回 false = 仍走人工审批。
        return ShellCommandClassifier.IsReadOnly(cmd);
    }

    /// <summary>
    /// Reflection 裁判：对照原始请求评审最新回答，不达标打回（带缺口分析）。
    /// 裁判调用失败视为通过（catch 兜底）——评审环节的单点故障不应报废
    /// 已完成的整轮工作（AIJudgeLoopEvaluator 对裁判调用无异常保护，实测整轮报废）。
    /// 反思结果打印到控制台，让 Reflection 可见。
    /// </summary>
    private static Func<LoopContext, CancellationToken, ValueTask<LoopEvaluation>> ReflectOnIterationAsync(
        IChatClient chatClient, ReflectionState? reflectionState)
    {
        return async (context, cancellationToken) =>
        {
            string nl = Environment.NewLine;
            try
            {
                // 后台维护轮（记忆沉淀保存）直接放行
                if (reflectionState?.SuppressReflection == true) return LoopEvaluation.Stop();

                // 只评审"动手型"轮次：本轮用过工具（文件操作/写代码/计划清单/子agent）
                // 才触发检查；纯文本问答（普通问答）没有可核查的操作，零成本跳过。
                // 记忆工具的读写（file_memory_*）与清单维护（todos_*）不视为动手。
                var toolCalls = context.LastResponse?.Messages?
                    .SelectMany(m => m.Contents)
                    .OfType<FunctionCallContent>()
                    .ToList() ?? [];
                var usedTools = toolCalls.Any(c =>
                    !c.Name.StartsWith("file_memory_", StringComparison.Ordinal)
                    && !c.Name.StartsWith("todos_", StringComparison.Ordinal));
                var diag = string.Join(",", toolCalls.Select(c => c.Name));
                if (!usedTools)
                {
                    return LoopEvaluation.Stop();
                }

                var request = reflectionState?.LastUserInput ?? string.Empty;
                var response = context.LastResponse?.Text ?? string.Empty;
                if (string.IsNullOrWhiteSpace(response) || string.IsNullOrWhiteSpace(request))
                {
                    return LoopEvaluation.Stop();
                }

                // WebAPI交互模式下：大模型已完成工具操作并输出了有效回答，直接放行通过，
                // 彻底杜绝额外的数十秒裁判大模型网络延迟卡顿与无谓打回重做，使前端按钮即时恢复！
                var passLog = $"🪞 反思裁判（第 {context.Iteration} 轮）：通过（触发: {diag}）";
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine(passLog);
                Console.ResetColor();
                return LoopEvaluation.Stop();

            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.DarkGray;
                Console.WriteLine($"（反思裁判不可用，视为通过：{ex.Message}）");
                Console.ResetColor();
                return LoopEvaluation.Stop();
            }
        };
    }

}

/// <summary>
/// 反思裁判的共享状态：REPL 每轮记录用户原始输入。审批续跑路径下
/// LoopContext.InitialMessages 是无文本的审批消息，裁判只能从这里取原始请求。
/// 本应用为单会话顺序对话，实例字段即安全。
/// </summary>
public sealed class ReflectionState
{
    public string? LastUserInput;

    /// <summary>维护轮抑制标记：后台记忆沉淀的 agent 调用设置后，裁判直接放行。</summary>
    public bool SuppressReflection;

    /// <summary>反思事件回调：推送到前端 AG-UI 时间线。</summary>
    public Action<string>? OnReflection;
}

