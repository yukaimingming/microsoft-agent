# MAF Harness 智能体全功能工作台

基于 **[Microsoft Agent Framework (MAF)](https://learn.microsoft.com/agent-framework/)** 1.22 核心框架与 **.NET 10 WebAPI** 封装，通过 **AG-UI 协议** 全栈对接现代 React 19 + AI SDK Elements 前端 UI 的智能体工作台应用。

后端框架内置的全部功能（多盘文件读写、任务清单分解、规划/执行模式切换、跨会话文件记忆与自动沉淀、反思裁判自检、文档分析子智能体、目录整理子智能体、智能终端 Shell、人工安全审批 HITL、行级 Diff 对比、思考流折叠展开）已全功能对接到 Web 前端，并在主面板中以建议提示词（Prompt Starters）卡片形式直观呈现。

---

## 1. 架构总览

```mermaid
flowchart TD
    subgraph 前端 ["现代 Web UI (React 19 + AI Elements)"]
        UI["聊天与活动时间线界面"]
        ViteProxy["Vite 本地代理 (:5175)"]
        AguiClient["@ag-ui/client 运行时"]
        UI --> AguiClient
        AguiClient --> ViteProxy
    end

    subgraph 后端 [".NET 10 WebAPI + MAF Harness (:8788)"]
        AgentController["AgentController (POST /agent SSE)"]
        RestControllers["REST API (工作区 / 模型管理 / 会话索引 / Git审查)"]
        AguiAdapter["AguiStreamAdapter (事件流适配与Diff计算)"]
        MafMgr["MafAgentManager (多会话隔离与审批中断治理)"]
        
        ViteProxy -->|/agent| AgentController
        ViteProxy -->|/api/*| RestControllers
        AgentController --> AguiAdapter
        AguiAdapter --> MafMgr
    end

    subgraph 引擎 ["Microsoft Agent Framework (MAF) 1.22 核心引擎"]
        HarnessAgent["HarnessAgent 全家桶运行时"]
        FileAccessStore["MultiDriveFileStore (多盘动态路由)"]
        MemoryStore["FileSystemAgentFileStore (跨会话稳定记忆)"]
        Subagents["后台子智能体 (docAnalyst, fileOrganizer)"]
        ShellTools["run_shell (含ShellCommandSanitizer与只读放行)"]
        DocTools["PDF/Excel (read_pdf, read_excel)"]
        WebSearch["Exa MCP (web_search_exa, web_fetch_exa)"]
        Reflection["Reflection 裁判 (AI Judge 输出评审)"]
        
        MafMgr --> HarnessAgent
        HarnessAgent --> FileAccessStore
        HarnessAgent --> MemoryStore
        HarnessAgent --> Subagents
        HarnessAgent --> ShellTools
        HarnessAgent --> DocTools
        HarnessAgent --> WebSearch
        HarnessAgent --> Reflection
    end
```

---

## 2. ✨ 核心功能与界面改动预览 (Visual Highlights)

工作台支持现代化 AI 智能体交互设计，并深度适配 **浅色（Light）** 与 **深色（Dark）** 双色主题：

### 2.1 输入框背面折叠排队卡片与流式引导（Queue & Steer）
- **流式回复拦截操作**：当模型正在流式输出时，输入框内键入内容自动提供 **【排队】**（Enter）与 **【立即引导】**（Ctrl+Enter，打断并发送）双重决策。
- **层叠折叠卡片**：排队任务呈现在输入框背面上方，杜绝角落灰色尖角与遮挡，支持**展开/折叠、撤回编辑、立即插队发送与删除**。

| 深色模式（展开态） | 浅色模式（展开态） |
| :---: | :---: |
| ![排队卡片-深色模式](screenshots/stacked_queue_dark_expanded.png) | ![排队卡片-浅色模式](screenshots/stacked_queue_light_expanded.png) |

> 流式生成过程中的【排队】与【立即引导】操作按钮：
> 
> ![流式回复操作按钮](screenshots/03-replying-with-queue-buttons.png)

---

### 2.2 Shimmer 柔和文字流动微光特效 (Shadcn Shimmer Color 规范)
- 遵循 Shadcn 官方规范，采用柔和通透的 `shimmer-color-blue-500/60` 电光蓝微光特效。
- 覆盖时间线总标题、深度推演思考区（`Thinking...`）、工具调用状态与子任务流式输出。
- 深度适配黑白双色主题，有效解决 `-webkit-text-fill-color` 导致的文字变暗或隐形缺陷。

| 深色模式（柔和电光蓝） | 浅色模式（宝石科技蓝） |
| :---: | :---: |
| ![微光特效-深色模式](screenshots/shimmer_color_dark_timeline.png) | ![微光特效-浅色模式](screenshots/shimmer_color_light_timeline.png) |

---

### 2.3 输入框工具栏与模型选择器（黑白双主题与防裁切修复）
- 彻底解除容器对向上弹出菜单的 `overflow` 裁切限制，支持 13+ 预置模型自由切换。
- 输入框四周统一直径优美圆角，模型选择器、思考等级、权限审批模式全状态适配深浅色背景。

| 深色模式（模型下拉列表） | 浅色模式（模型下拉列表） |
| :---: | :---: |
| ![模型选择-深色模式](screenshots/model_selector_dark_fixed.png) | ![模型选择-浅色模式](screenshots/model_selector_light_fixed.png) |

---

### 2.4 原生 ContextMeter 环形占用率仪表与用量弹窗
- 对齐官方紧凑环形仪表设计，默认显示占用率与当前状态，**点击后弹窗展示详细用量**。
- 支持实时直观查看上下文占用占比、输入/输出 Token、缓存命中与总消耗明细。

| 默认紧凑环形仪表圈 | 点击弹窗查看 Token 构成与占用进度条 |
| :---: | :---: |
| ![仪表圈默认态](screenshots/01-context-meter-restored.png) | ![用量详情弹窗](screenshots/02-context-meter-dialog-fixed.png) |

---

### 2.5 待办任务清单卡片 (TodoCard) 与双色主题
- 支持自动将复杂长程目标分解为结构化任务清单，随模型自治循环实时打钩推进。
- 平行于工作区选择器独立展开，支持一键折叠收缩。

| 深色模式（任务清单展开） | 浅色模式（任务清单展开） |
| :---: | :---: |
| ![任务清单-深色模式](screenshots/theme_dark_todo_and_input.png) | ![任务清单-浅色模式](screenshots/theme_light_todo_expanded.png) |

---

### 2.6 代码审查 (Review) 边栏与 PowerShell 交互终端
- 右侧可收缩边栏支持 Git 变更状态逐文件查看、行级红绿差异（Diff）高亮展示与交互式终端命令执行。

![代码审查与终端](screenshots/08-review-git-diff-terminal.png)

---

## 3. 后端全部内置能力与前端对接清单

| 功能模块 | MAF Harness 内置机制 | 前端 AG-UI 对接方式 | 实测状态 |
| :--- | :--- | :--- | :---: |
| **工作区人格** | `workspace/AGENTS.md` + 注入前缀 | 遵循预设行为规范，用中文友好回答 | ✅ 已对接 |
| **流式正文输出** | `TextContent` 流式增量 | `TEXT_MESSAGE_START` / `CONTENT` / `END` 打字机渲染 | ✅ 已对接 |
| **思考流折叠/展开** | `TextReasoningContent` | `REASONING_MESSAGE_START` / `CONTENT` / `END`，折叠气泡展示思维链 | ✅ 已对接 |
| **任务清单 Todo** | `TodoCompletionLoopEvaluator` + `todos_*` | `CUSTOM` (`deepagent:activity` kind=todo)，实时待办清单卡片与进度 | ✅ 已对接 |
| **文件变更 Diff** | `MultiDriveFileStore.FileChanged` + LCS 计算 | 自动计算行级增删差异，高亮渲染 `Δ +N -N` 差异预览卡片 | ✅ 已对接 |
| **工具调用卡片** | `FunctionCallContent` / `FunctionResultContent` | `CUSTOM` (`deepagent:activity` kind=tool/file)，实时渲染参数与结果截断 | ✅ 已对接 |
| **文档分析子智能体** | `docAnalyst` (PDF/Excel 分析只读代理) | `CUSTOM` (`deepagent:activity` kind=subagent)，独立卡片展示任务与结构化中文摘要 | ✅ 已对接 |
| **文件整理子智能体** | `fileOrganizer` (目录扫描与规划只读代理) | `CUSTOM` (`deepagent:activity` kind=subagent)，独立卡片展示扫描与规划方案 | ✅ 已对接 |
| **智能终端 Shell** | `LocalShellExecutor` + `ShellCommandClassifier` | 自动识别只读命令免审放行，结构/权限修改触发审批，终端面板交互 | ✅ 已对接 |
| **模式切换** | `mode_get` / `mode_set` (plan / execute) | 复杂任务先进入 plan 模式规划，经确认切入 execute 模式动手 | ✅ 已对接 |
| **反思裁判自检** | `ReflectOnIterationAsync` (AI Judge 评审) | `CUSTOM` (`deepagent:process-message`)，时间线中实时展示反思结果 | ✅ 已对接 |
| **跨会话文件记忆** | `file_memory_*` + 后台异步事实抽取沉淀 | 回合结束后后台模型抽取事实存入 `agent-file-memory/current` 稳定目录 | ✅ 已对接 |
| **人工安全审批 (HITL)** | `ToolApprovalAgent` + 审批拦截 | AG-UI `interrupt` 机制，前端弹出审批确认卡片，提交后 `resume` 唤醒后续执行 | ✅ 已对接 |
| **多会话持久化** | `AgentSession` 序列化与恢复 | 各会话按 `threadId` 隔离记忆与活动日志，切换对话互不打扰 | ✅ 已对接 |
| **工作区文件树** | 文件系统 API | 实时获取工作区目录树、新建文件夹、切换根目录 | ✅ 已对接 |
| **多模型提供商** | `ProviderService` | 预置主流 OpenAI 兼容聚合端点，支持前端动态添加、测速与模型探测 | ✅ 已对接 |
| **代码审查 Review** | `GitService` + 终端执行 | 右侧侧边栏展示 Git 状态、逐文件 Diff、提交与 PowerShell 交互式终端 | ✅ 已对接 |

---

## 4. 主面板建议提示词 (Prompt Starters)

在主面板中，预置了覆盖 MAF 全部内置能力的建议提示词卡片，一键点击即可体验：

1. **待办清单**（`todos_*`）：任务清单与自治循环 —— 任务分解、待办清单跟踪与自动流转
2. **文件变更**（`file_access_*`）：多盘读写与行级 Diff —— 多盘文件读写/替换与行级差异对比
3. **深度思考**（`TextReasoningContent`）：深度推演与思维链 —— 流式输出思考过程并支持实时折叠展开
4. **文档子Agent**（`docAnalyst`）：委派 docAnalyst 分析文档 —— 委派只读子智能体解析 PDF / Excel 并提取结构化中文摘要
5. **整理子Agent**（`fileOrganizer`）：委派 fileOrganizer 归类 —— 委派子智能体扫描目录并规划归类方案
6. **智能终端**（`run_shell`）：Shell 命令与安全放行 —— PowerShell 命令执行，只读自动免审与结构审批
7. **模式切换**（`mode_set / mode_get`）：规划与执行模式切换 —— 从 plan 规划模式到 execute 执行模式严谨推进
8. **长期记忆**（`file_memory_*`）：跨会话记忆检索与沉淀 —— 事实抽取落盘与跨会话记忆检索

---

## 5. 环境要求

- **.NET SDK 10.0+**（.NET 10.0.400+）
- **Node.js 20+ / 24+**
- **pnpm 9+ / 10+**
- **PowerShell 7+ / Windows PowerShell**

---

## 6. 快速开始

### 6.1 一键启动（Windows）

双击根目录下的 `run.cmd` 或运行 `run.ps1`：
- 自动检测环境并启动 .NET 10 WebAPI 后端服务（`http://127.0.0.1:8788`）；
- 启动前端 Vite 开发服务器（`http://127.0.0.1:5175`）；
- 浏览器访问 `http://127.0.0.1:5175` 即可使用。

```cmd
run.cmd
```

### 6.2 手动分步启动

#### 终端 1：启动 .NET 10 WebAPI 后端

```bash
cd backend
dotnet run
```
后端服务端口为 `8788`，健康检查地址为 `http://127.0.0.1:8788/api/health`。

#### 终端 2：启动 Web 前端

```bash
cd frontend
pnpm install
pnpm --filter @deepagent/web dev --host 127.0.0.1 --port 5175
```
浏览器访问：`http://127.0.0.1:5175`。

---

## 7. 服务端 API 接口清单

| 请求方式 | 路径 | 功能说明 |
| :--- | :--- | :--- |
| `GET` | `/api/health` | 健康检查与 MAF 运行状态 |
| `POST` | `/agent` | AG-UI 协议 SSE 流式执行端点 |
| `POST` | `/agent/cancel` | 中断取消指定会话的任务 |
| `GET` | `/api/workspace/tree` | 获取当前工作区文件目录树 |
| `POST` | `/api/workspace/select` | 切换当前工作区根目录 |
| `POST` | `/api/workspace/mkdir` | 在工作区内创建新目录 |
| `GET` | `/api/workspace/browse` | 浏览指定目录文件 |
| `GET` | `/api/providers` | 获取所有已配置大模型提供商（API Key 自动掩码） |
| `POST` | `/api/providers` | 添加新的大模型提供商 |
| `PUT` | `/api/providers/{id}` | 更新提供商配置 |
| `DELETE` | `/api/providers/{id}` | 删除提供商配置 |
| `POST` | `/api/providers/{id}/models` | 远程探测提供商模型列表 |
| `POST` | `/api/providers/{id}/test` | 连通性与延迟测试 |
| `GET` | `/api/workbench` | 获取工作台索引与会话列表 |
| `PUT` | `/api/workbench` | 更新工作台索引 |
| `GET/PUT/DELETE` | `/api/workbench/sessions/{threadId}` | 会话状态持久化与清理 |
| `GET` | `/api/git/status` | 获取 Git 状态与变更文件列表 |
| `GET` | `/api/git/diff` | 获取指定文件的统一 Diff 对比 |
| `POST` | `/api/git/commit` | 提交代码变更 |
| `GET` | `/api/git/file-content` | 读取文件文本内容 |
| `POST` | `/api/git/terminal` | 执行交互式终端 PowerShell 命令 |

---

## 8. 全功能测试与验证截图清单

项目配备完整的端到端自动化测试脚本，全面覆盖主面板建议提示词、权限选择、人工审批（HITL）以及整个 Agent 内所有功能：

| 截图编号与文件名 | 测试场景与验证能力 | 核心功能说明 |
| :--- | :--- | :--- |
| **01-home-8-capabilities.png** | **主面板 8 大内置能力** | 纯净状态居中呈现 8 大核心建议卡片，模型状态显示 `Atria-Dawn-Preview` |
| **02-permission-mode-selector.png** | **权限模式选择器** | 验证三种审核策略（`请求批准` / `帮我批准` / `完全访问权限`）切换正常 |
| **03-approval-hitl-intercept.png** | **敏感操作人工审批拦截** | 执行命令或修改时触发 `ToolApprovalRequestContent`，弹起批准/拒绝拦截卡片 |
| **04-approval-resumed-success.png** | **人工审批恢复与执行完成** | 点击批准后调用 `resume` 恢复执行，任务顺利完成并生成输出 |
| **05-todos-loop-execution.png** | **待办清单与自治循环** | `todos_*` 拆解任务清单，自动循环评估与推进标记 |
| **06-multidrive-diff-viewer.png** | **多盘读写与行级 Diff** | `file_access_*` 读写替换并生成红绿相间的行级差异卡片 |
| **07-subagents-and-memory.png** | **子智能体与长期记忆** | `file_memory_*` 事实抽取，检索跨会话记忆与子智能体委派 |
| **08-review-git-diff-terminal.png** | **代码审查与 PowerShell 终端** | 右侧 Review 模块、文件代码查看器与 Windows PowerShell 交互控制台 |

自动化测试执行方式：
```bash
node scripts/comprehensive-test-and-capture.cjs
```
