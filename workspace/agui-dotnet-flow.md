# AGUI 协议 .NET Core 对接流程图

> AGUI（Agent-UI）协议是 CopilotKit 主导的开源协作协议：基于 **HTTP + Server-Sent Events (SSE)**，让 Agent 把流式消息、工具调用、UI 状态实时推送给前端。
> 以下流程图描述 .NET Core 后端作为 **AGUI Server** 的完整对接链路。

---

## 一、整体架构图（flowchart）

```mermaid
flowchart TB
    subgraph Frontend["前端（React / CopilotKit Runtime）"]
        UI[聊天界面 UI]
        RT[CopilotKit Runtime<br/>AGUI Client]
        UI <--> RT
    end

    subgraph DotNet[".NET Core 后端（AGUI Server）"]
        EP[/Endpoint: POST /api/agent<br/>IAsyncEnumerable&lt;AgentEvent&gt;/]
        INPUT[解析 RunAgentInput<br/>messages / tools / state / context]
        SSE[SSE 封装<br/>Content-Type: text/event-stream]
        AGENT[Agent 编排层<br/>LLM + 工具循环]
        LLM[LLM 服务<br/>OpenAI / Anthropic SDK]
        TOOLS[工具执行器<br/>按 AGUI Tool Schema 调用]
        STATE[State 管理器<br/>快照 + JSON Patch]
    end

    subgraph External["外部服务"]
        OPENAI[OpenAI / Azure OpenAI]
        API[业务 API / 数据库]
    end

    RT -- "RunAgentInput (JSON)" --> EP
    EP --> INPUT
    INPUT --> AGENT
    AGENT --> LLM
    LLM -- "流式 token / tool_call" --> AGENT
    AGENT --> TOOLS
    TOOLS --> API
    AGENT --> STATE
    AGENT -- "yield AgentEvent" --> SSE
    SSE -- "SSE 事件流（逐条）" --> RT
    LLM <--> OPENAI
```

---

## 二、核心交互时序图（sequence diagram）

```mermaid
sequenceDiagram
    participant FE as 前端 AGUI Client
    participant API as .NET Core Endpoint
    participant Agent as Agent 编排层
    participant LLM as LLM 服务

    FE->>API: POST /api/agent {messages, tools, state, context}
    API->>API: 解析 RunAgentInput，校验 ThreadId/RunId
    API-->>FE: 响应头 200 + text/event-stream（流保持打开）

    Note over API,LLM: 以下事件按 AGUI 规范以 "event: <类型>\ndata: {json}\n\n" 格式逐条推送

    API-->>FE: RUN_STARTED {threadId, runId}
    Agent->>LLM: 流式补全请求 (stream: true)
    loop 流式返回
        LLM-->>Agent: token 增量
        API-->>FE: TEXT_MESSAGE_CHUNK {messageId, delta}
    end
    API-->>FE: TEXT_MESSAGE_END {messageId}

    Note over Agent,LLM: 模型请求工具调用时
    API-->>FE: TOOL_CALL_START {toolCallId, toolCallName}
    API-->>FE: TOOL_CALL_ARGS {toolCallId, argsText}
    API-->>FE: TOOL_CALL_END {toolCallId}
    Agent->>Agent: 按 AGUI Tool Schema 执行本地/远程工具
    Agent-->>Agent: 产出结果
    API-->>FE: TOOL_RESULT {toolCallId, content}
    opt 前端需要回传
        FE->>API: TOOL_CALL_RESULT / 前端工具执行结果（下一轮 RunAgentInput）
    end

    opt UI 状态同步
        API-->>FE: STATE_SNAPSHOT {snapshot}(全量) / STATE_DELTA {delta}(JSON Patch)
    end

    opt 自定义业务事件
        API-->>FE: CUSTOM {name, data}
    end

    Agent->>Agent: 判定完成（无更多 tool_call）
    API-->>FE: RUN_COMPLETED {threadId, runId}
    API->>FE: 关闭 SSE 流
```

---

## 三、事件流转状态机（state diagram）

```mermaid
stateDiagram-v2
    [*] --> RunStarted: 收到 RunAgentInput
    RunStarted --> StreamingText: LLM 开始输出文本
    StreamingText --> StreamingText: TEXT_MESSAGE_CHUNK
    StreamingText --> TextDone: TEXT_MESSAGE_END

    TextDone --> ToolCalling: LLM 请求 tool_call
    ToolCalling --> ToolCalling: TOOL_CALL_START→ARGS→END
    ToolCalling --> ToolResult: 执行完毕 TOOL_RESULT
    ToolResult --> RunStarted: 结果回灌 LLM 继续对话

    TextDone --> StateSync: 需要同步 UI 状态
    StateSync --> StateSync: STATE_SNAPSHOT / STATE_DELTA
    StateSync --> TextDone

    TextDone --> Completed: LLM 输出 finish
    RunStarted --> CustomEvent: 业务自定义事件
    CustomEvent --> RunStarted
    Completed --> [*]: RUN_COMPLETED
    RunStarted --> [*]: RUN_ERROR / RUN_CANCELLED
```

---

## 四、.NET Core 实现要点速查

| 环节 | 实现方式 |
|---|---|
| 协议入口 | Minimal API `app.MapPost("/api/agent", async (RunAgentInput input, CancellationToken ct) => ...)` |
| 返回流 | 返回 `IAsyncEnumerable<AgentEvent>`，配合 `Results.Stream(...)` 自动输出 SSE |
| 事件模型 | 强类型 record `AgentEvent`，序列化为 `event: <type>\ndata: {json}\n\n`（遵 AGUI 规范，CopilotKit 提供 `CopilotKitProtocol` NuGet 包可直接引用） |
| 输入契约 | `RunAgentInput { Messages, Tools, State, ThreadId, RunId, Context }` |
| 工具契约 | `Tool { Id?, Name, Description, Parameters(JsonSchema) }`，工具调用回 `ToolCall` / `ToolResult` |
| 状态同步 | 维护可序列化 State 对象：初次/大变更发 `STATE_SNAPSHOT`，增量发 `STATE_DELTA`（RFC6902 JSON Patch，可用 `Microsoft.AspNetCore.JsonPatch`） |
| 取消 | 监听 `CancellationToken`（客户端断开 SSE 自动触发），发 `RUN_CANCELLED` 后终止 |
| 校验 | 每条事件保证 `type` 字段存在；`messageId` / `toolCallId` 全程唯一 |

---

## 五、对接步骤清单（Checklist）

1. 引入 `CopilotKit.Protocol`（AGUI 协议包）或自行按规范定义事件模型
2. 新建 Minimal API 端点，返回 `IAsyncEnumerable<AgentEvent>` + `Results.Stream`
3. 注入 LLM 客户端（`OpenAI` / `Azure.AI.OpenAI` SDK），开启 `stream: true`
4. 把 LLM 流 token 映射为 `TEXT_MESSAGE_*` 事件流
5. 按协议声明 Tools（JSON Schema 参数），处理 `TOOL_CALL_*` 与 `TOOL_RESULT`
6. 实现 State 快照/增量推送（`STATE_SNAPSHOT` / `STATE_DELTA`）
7. 处理取消令牌与错误事件（`RUN_CANCELLED` / `RUN_ERROR`）
8. 前端用 CopilotKit Runtime 或自研 SSE 客户端联调，确认 events 逐行解析
