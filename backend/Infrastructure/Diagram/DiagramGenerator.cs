using System.Text.RegularExpressions;
using Microsoft.Extensions.AI;

namespace MafHarnessDemo.App.Infrastructure.Diagram;

/// <summary>
/// 图表生成与校验核心服务
/// 具备：LLM 自然语言解析生成、语法校验拦截、自修复机制、上下文增量修改、以及稳健的确定性模版兜底。
/// </summary>
public sealed class DiagramGenerator : IDiagramGenerator
{
    private readonly IChatClient? _chatClient;

    public DiagramGenerator(IChatClient? chatClient = null)
    {
        _chatClient = chatClient;
    }

    /// <summary>
    /// 校验给定的 Mermaid 代码语法与安全性
    /// </summary>
    public DiagramValidationResult Validate(string mermaidCode)
    {
        return DiagramValidator.Validate(mermaidCode);
    }

    /// <summary>
    /// 根据自然语言需求与可选的已有源码，生成或修改 Mermaid 图表
    /// </summary>
    public async Task<DiagramResult> GenerateAsync(
        string type,
        string description,
        string? sourceCode = null,
        CancellationToken cancellationToken = default)
    {
        var diagramType = DiagramTypeExtensions.Parse(type);
        var typeIdentifier = diagramType.ToTypeIdentifier();
        var displayName = diagramType.ToDisplayName();
        var title = ExtractTitle(description, diagramType);

        string? generatedCode = null;

        // 1. 如果配置了 IChatClient，优先调用模型进行针对性生成
        if (_chatClient != null && !string.IsNullOrWhiteSpace(description))
        {
            try
            {
                var prompt = BuildPrompt(diagramType, description, sourceCode);
                var response = await _chatClient.GetResponseAsync(prompt, cancellationToken: cancellationToken);
                var rawCode = response.Text ?? string.Empty;
                var cleanedCode = DiagramValidator.SanitizeAndClean(rawCode);

                var valResult = DiagramValidator.Validate(cleanedCode);

                // 2. 如果初步校验未通过，先自动用修复逻辑修一次；若仍未通过再进行 LLM 重试
                if (!valResult.IsValid)
                {
                    var autoRepaired = DiagramValidator.Repair(cleanedCode);
                    var autoRepairedVal = DiagramValidator.Validate(autoRepaired);

                    if (autoRepairedVal.IsValid)
                    {
                        generatedCode = autoRepaired;
                    }
                    else
                    {
                        var repairPrompt = $"""
                            以下 Mermaid 图表代码校验失败：
                            {valResult.ErrorMessage}

                            问题代码：
                            {cleanedCode}

                            请修复上述语法或结构错误，直接返回完全合规的 Mermaid DSL 源码。
                            首行必须包含合法的图表类型声明（如 {diagramType.ToMermaidKeyword()}）。
                            节点 ID 只允许英文字母、数字、下划线，禁止出现空格和中文；所有标签文本必须用双引号包裹。
                            严禁输出除代码外的任何说明文字。
                            """;

                        var repairResponse = await _chatClient.GetResponseAsync(repairPrompt, cancellationToken: cancellationToken);
                        var repairedCode = DiagramValidator.SanitizeAndClean(repairResponse.Text ?? string.Empty);
                        var repairedValResult = DiagramValidator.Validate(repairedCode);

                        if (repairedValResult.IsValid)
                        {
                            generatedCode = repairedCode;
                        }
                        else
                        {
                            var finalRepair = DiagramValidator.Repair(repairedCode);
                            if (DiagramValidator.Validate(finalRepair).IsValid)
                            {
                                generatedCode = finalRepair;
                            }
                        }
                    }
                }
                else
                {
                    generatedCode = cleanedCode;
                }
            }
            catch
            {
                // 模型调用异常时降级至确定性模版生成
                generatedCode = null;
            }
        }

        // 3. 如果模型生成失败或未配置模型，执行高质量领域模版生成
        if (string.IsNullOrWhiteSpace(generatedCode) || !DiagramValidator.Validate(generatedCode).IsValid)
        {
            generatedCode = GenerateFallbackTemplate(diagramType, description, sourceCode);
        }

        // 4. 最终校验
        var finalValidation = DiagramValidator.Validate(generatedCode);

        return new DiagramResult
        {
            Title = title,
            Type = typeIdentifier,
            Description = description,
            MermaidCode = generatedCode,
            ValidationResult = finalValidation
        };
    }

    private static string ExtractTitle(string description, DiagramType type)
    {
        if (string.IsNullOrWhiteSpace(description))
        {
            return type.ToDisplayName();
        }

        var trimmed = description.Trim();
        // 尝试匹配“画一个/绘制/生成/关于”后面的核心主题
        var match = Regex.Match(trimmed, @"(?:帮我画一个|绘制一个|生成一个|画出|绘制|生成|关于)?([^\n，。？！]{2,30})", RegexOptions.IgnoreCase);
        if (match.Success && !string.IsNullOrWhiteSpace(match.Groups[1].Value))
        {
            var matched = match.Groups[1].Value.Trim();
            if (matched.Length > 2)
            {
                return matched;
            }
        }

        return trimmed.Length > 30 ? trimmed[..30] + "..." : trimmed;
    }

    private static string BuildPrompt(DiagramType type, string description, string? sourceCode)
    {
        var hasSource = !string.IsNullOrWhiteSpace(sourceCode);
        var sourceBlock = hasSource
            ? $"""
               已有 Mermaid 源码如下：
               ```mermaid
               {sourceCode!.Trim()}
               ```
               用户要求在原图基础上进行增量修改或扩展：
               "{description}"
               请在保留已有核心节点和流向的基础上，完成精准修改、追加节点或调整分支。
               """
            : $"""
               用户需求描述：
               "{description}"
               """;

        return $"""
            你是一名专业的 Mermaid 架构与流程建模专家。
            请根据以下需求输出完全符合 Mermaid 语法的图表源码。

            目标图表类型：{type.ToDisplayName()}
            首行声明语法参考：{type.ToMermaidKeyword()}

            {sourceBlock}

            严格遵循以下约束：
            1. 严禁生成图片或伪代码，只能输出纯 Mermaid DSL 源码。
            2. 首行必须是合法的图表类型声明（如 flowchart TD, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram 等）。
            3. 节点 ID 只允许英文字母、数字、下划线，禁止出现空格和中文（如 Node1, LIS, MT8000）。
            4. 所有标签文本必须用双引号包裹（如 A["开始采集"] --> B["样本化验"]）。
            5. 方括号、圆括号、花括号必须成对闭合，严禁嵌套未转义的特殊字符。
            6. 不要输出 Markdown 围栏外的任何解释、问候或说明文字，只输出纯代码。
            """;
    }

    /// <summary>
    /// 当未配置模型或模型不可用时，基于关键词与图表类型生成确定性、高质量的 Mermaid 图表
    /// </summary>
    public static string GenerateFallbackTemplate(DiagramType type, string description, string? sourceCode)
    {
        var d = description?.ToLowerInvariant() ?? string.Empty;

        // 如果存在已有源码且用户要求增量修改
        if (!string.IsNullOrWhiteSpace(sourceCode))
        {
            return ModifyExistingSource(sourceCode, d, type);
        }

        return type switch
        {
            DiagramType.Flowchart => GenerateFlowchart(d),
            DiagramType.Sequence => GenerateSequence(d),
            DiagramType.State => GenerateState(d),
            DiagramType.ClassDiagram => GenerateClassDiagram(d),
            DiagramType.ErDiagram => GenerateErDiagram(d),
            DiagramType.Architecture => GenerateArchitecture(d),
            DiagramType.Gantt => GenerateGantt(d),
            DiagramType.Mindmap => GenerateMindmap(d),
            DiagramType.GitGraph => GenerateGitGraph(d),
            _ => GenerateFlowchart(d)
        };
    }

    private static string ModifyExistingSource(string source, string modificationReq, DiagramType type)
    {
        var clean = DiagramValidator.SanitizeAndClean(source);

        // 如果原图是时序图且要求“增加数据库节点”
        if (clean.Contains("sequenceDiagram") && (modificationReq.Contains("数据库") || modificationReq.Contains("db") || modificationReq.Contains("database")))
        {
            if (!clean.Contains("participant DB") && !clean.Contains("Database"))
            {
                var lines = clean.Split('\n').ToList();
                var insertIndex = lines.FindIndex(l => l.Trim().StartsWith("participant") || l.Trim().StartsWith("actor"));
                if (insertIndex >= 0)
                {
                    lines.Insert(insertIndex + 1, "    participant DB as 检验数据库 (Database)");
                }
                else
                {
                    lines.Insert(1, "    participant DB as 检验数据库 (Database)");
                }

                // 在末尾或者交互间增加数据库记录
                lines.Add("    LIS->>DB: 记录通信日志与样本状态");
                lines.Add("    DB-->>LIS: 确认写入成功");
                return string.Join("\n", lines);
            }
        }

        // 如果要求“增加异常处理分支”
        if (modificationReq.Contains("异常") || modificationReq.Contains("错误") || modificationReq.Contains("分支"))
        {
            if (clean.StartsWith("flowchart") || clean.StartsWith("graph"))
            {
                return clean + "\n    E -->|异常或校验失败| Err[\"异常处理 & 告警上报\"]\n    Err --> Notify[\"通知运维与责任人\"]";
            }
            if (clean.StartsWith("stateDiagram"))
            {
                return clean + "\n    [*] --> 异常状态: 触发故障告警\n    异常状态 --> [*]: 故障排除与复位";
            }
        }

        return clean;
    }

    private static string GenerateFlowchart(string d)
    {
        if (d.Contains("样本") || d.Contains("检验") || d.Contains("采集") || d.Contains("审核"))
        {
            return """
                flowchart TD
                    A["样本采集 (Collection)"] --> B["样本前处理 & 贴码条"]
                    B --> C["物流运输至实验室"]
                    C --> D["LIS 样本扫码签收"]
                    D --> E{"样本状态初验"}
                    E -- 合格 --> F["分析仪上机检测"]
                    E -- 不合格/溶血 --> G["标记异常并通知重采"]
                    F --> H["质控质检比对"]
                    H --> I["LIS 自动初审"]
                    I --> J["检验主管终审签字"]
                    J --> K["发布检验报告 & 推送通知"]
                """;
        }

        if (d.Contains("agent") || d.Contains("接收") || d.Contains("工具") || d.Contains("执行"))
        {
            return """
                flowchart TD
                    A["用户发送请求 Prompt"] --> B["Agent 接收并解析上下文"]
                    B --> C["规划模式评估 (Plan Mode)"]
                    C --> D{"是否需要调用工具?"}
                    D -- 是 --> E["选择并调用 AITool (如 generate_diagram)"]
                    E --> F["执行工具逻辑并获取结果"]
                    F --> G["结果回填 Agent 上下文"]
                    G --> H["LoopEvaluator 循环评估"]
                    H --> I{"任务是否完成?"}
                    I -- 否 --> C
                    I -- 是 --> J["生成最终 Markdown 回复"]
                    D -- 否 --> J
                    J --> K["前端渲染与展示"]
                """;
        }

        return """
            flowchart TD
                Start["开始"] --> Step1["接收输入与需求解析"]
                Step1 --> Check{"逻辑条件判断"}
                Check -- 是 --> ActionA["主流程处理执行"]
                Check -- 否 --> ActionB["备用流程/分支处理"]
                ActionA --> Merge["汇聚与数据整合"]
                ActionB --> Merge
                Merge --> Finish["完成并输出结果"]
            """;
    }

    private static string GenerateSequence(string d)
    {
        if (d.Contains("lis") || d.Contains("mt8000") || d.Contains("通信") || d.Contains("医院"))
        {
            return """
                sequenceDiagram
                    autonumber
                    participant MT as MT8000 流水线分析仪
                    participant LIS as 医院 LIS 系统
                    participant DB as 检验数据库

                    MT->>LIS: 1. 建立 TCP/HL7 通信握手
                    LIS-->>MT: 2. 握手确认 (ACK)
                    MT->>LIS: 3. 扫描试管条码查询测试项目 (QRY^Q02)
                    LIS->>DB: 4. 检索样本检验申请单
                    DB-->>LIS: 5. 返回项目明细 (血常规/生化)
                    LIS-->>MT: 6. 下发检测医嘱与通道参数 (DSR^Q03)
                    MT->>MT: 7. 执行样本吸样、孵育与比色测定
                    MT->>LIS: 8. 上传检验结果数据 (ORU^R01)
                    LIS->>DB: 9. 写入检测结果并标记待审
                    LIS-->>MT: 10. 确认接收数据完成 (ACK^R01)
                """;
        }

        return """
            sequenceDiagram
                autonumber
                actor User as 用户
                participant Client as 前端界面
                participant Agent as Agent 核心服务
                participant Tools as 工具执行引擎

                User->>Client: 发起业务请求
                Client->>Agent: 提交自然语言指令
                Agent->>Agent: 解析意图与规划任务
                Agent->>Tools: 调用指定工具执行
                Tools-->>Agent: 返回工具执行结果
                Agent->>Client: 流式输出响应数据与图表
                Client-->>User: 渲染展示可视化图表
            """;
    }

    private static string GenerateState(string d)
    {
        if (d.Contains("订单") || d.Contains("支付") || d.Contains("待支付"))
        {
            return """
                stateDiagram-v2
                    [*] --> 待支付: 创建订单
                    待支付 --> 已支付: 支付成功
                    待支付 --> 已取消: 超时未付/用户取消
                    已支付 --> 处理中: 仓储配货/开始执行
                    已支付 --> 已退款: 发起全额退款
                    处理中 --> 已完成: 发货并确认收货
                    处理中 --> 已取消: 异常阻断中断
                    已完成 --> [*]
                    已取消 --> [*]
                    已退款 --> [*]
                """;
        }

        return """
            stateDiagram-v2
                [*] --> 初始化: 实例创建
                初始化 --> 就绪: 资源加载完毕
                就绪 --> 运行中: 触发执行事件
                运行中 --> 暂停: 收到挂起信号
                暂停 --> 运行中: 恢复执行
                运行中 --> 完成: 任务处理结束
                运行中 --> 错误: 发生异常
                错误 --> 就绪: 重试恢复
                完成 --> [*]
            """;
    }

    private static string GenerateClassDiagram(string d)
    {
        return """
            classDiagram
                class IDiagramGenerator {
                    <<interface>>
                    +GenerateAsync(type, desc, sourceCode) Task~DiagramResult~
                    +Validate(mermaidCode) DiagramValidationResult
                }
                class DiagramGenerator {
                    -IChatClient _chatClient
                    +GenerateAsync() Task~DiagramResult~
                    +Validate() DiagramValidationResult
                }
                class DiagramResult {
                    +string Title
                    +string Type
                    +string Description
                    +string MermaidCode
                    +DiagramValidationResult ValidationResult
                }
                class DiagramTools {
                    -IDiagramGenerator _generator
                    +generate_diagram() Task~DiagramResult~
                    +validate_diagram() DiagramValidationResult
                }
                IDiagramGenerator <|.. DiagramGenerator : implements
                DiagramTools --> IDiagramGenerator : invokes
                DiagramGenerator ..> DiagramResult : returns
            """;
    }

    private static string GenerateErDiagram(string d)
    {
        return """
            erDiagram
                USER ||--o{ ORDER : places
                ORDER ||--|{ ORDER_ITEM : contains
                PRODUCT ||--o{ ORDER_ITEM : includes
                ORDER ||--|| PAYMENT : generates

                USER {
                    string id PK
                    string username
                    string email
                    datetime createdAt
                }
                ORDER {
                    string id PK
                    string userId FK
                    decimal totalAmount
                    string status
                    datetime createdAt
                }
                ORDER_ITEM {
                    string id PK
                    string orderId FK
                    string productId FK
                    int quantity
                    decimal unitPrice
                }
                PRODUCT {
                    string id PK
                    string name
                    decimal price
                    int stock
                }
            """;
    }

    private static string GenerateArchitecture(string d)
    {
        return """
            flowchart LR
                subgraph ClientTier["客户端展现层"]
                    Web["Web 前端 (React / Vite)"]
                    Viewer["DiagramViewer (Mermaid.js)"]
                end

                subgraph GatewayTier["接入网关层"]
                    API["ASP.NET Core REST API"]
                    SSE["SSE 流式适配 (AguiStreamAdapter)"]
                end

                subgraph CoreTier["Agent 核心引擎"]
                    AgentMgr["MAF Agent 运行时"]
                    Factory["FileAgentFactory"]
                    Loop["LoopEvaluator 决策循环"]
                end

                subgraph ToolTier["工具与服务集成"]
                    DiagramTool["DiagramTools"]
                    ShellTool["Shell / LocalShellExecutor"]
                    FileTool["FileAccessProvider"]
                end

                Web --> API
                Web --> SSE
                API --> AgentMgr
                SSE --> AgentMgr
                AgentMgr --> Factory
                Factory --> Loop
                AgentMgr --> DiagramTool
                AgentMgr --> ShellTool
                AgentMgr --> FileTool
            """;
    }

    private static string GenerateGantt(string d)
    {
        return """
            gantt
                title 项目实施甘特图
                dateFormat  YYYY-MM-DD
                section 需求与规划
                需求分析           :done,    des1, 2026-11-01,2026-11-03
                架构设计           :active,  des2, 2026-11-03, 3d
                section 后端开发
                图表模块实现       :         des3, after des2, 4d
                工具集成与测试     :         des4, after des3, 2d
                section 前端开发
                Mermaid 渲染组件   :         des5, after des2, 3d
                卡片交互与导出     :         des6, after des5, 3d
            """;
    }

    private static string GenerateMindmap(string d)
    {
        return """
            mindmap
                root((Diagram Generator))
                    后端架构
                        IDiagramGenerator
                        DiagramValidator
                        DiagramTools
                    前端渲染
                        Mermaid.js
                        缩放与平移
                        SVG/PNG 导出
                        源码实时编辑
                    支持图表
                        Flowchart
                        Sequence
                        State
                        Class
                        ER
            """;
    }

    private static string GenerateGitGraph(string d)
    {
        return """
            gitGraph
                commit id: "Initial Commit"
                branch feature/diagram
                checkout feature/diagram
                commit id: "Add Diagram Generator"
                commit id: "Add Diagram Viewer"
                checkout main
                merge feature/diagram id: "Merge PR #1"
                commit id: "Release v1.2"
            """;
    }
}
