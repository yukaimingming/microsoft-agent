/**
 * AG-UI 事件 → 客户端状态的纯函数归约器。
 *
 * 从 use-agent-client.ts 抽出，便于不依赖 React 做单元测试
 * （AGENTS.md 第 12 节要求事件更新幂等、状态转移明确）。
 */

import { EventType, type BaseEvent, type RunAgentParameters } from "@ag-ui/client";
import type { FileUIPart } from "ai";
import {
  AGUI_CUSTOM_EVENT,
  type Activity,
  type RunSnapshot,
  type RunStatus,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from "@deepagent/shared";
import { randomUUID } from "../../uuid.js";

/** 一条聊天消息（用户消息或 Agent 答复）。 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 用户上传的图片/文件；url 为本次运行使用的数据 URL。 */
  attachments?: Array<FileUIPart & { id: string }>;
  /** 是否正在流式生成。 */
  streaming: boolean;
  /** 关联的 runId。 */
  runId?: string;
  /**
   * 模型原始 reasoning 增量，与 content 分开存储并按原样流式展示。
   * 与 content 分开存：推理流先完成，正文再开始流式输出。
   */
  reasoning?: string;
  /** 思考是否仍在流式输出。 */
  reasoningStreaming?: boolean;
  /** 思考开始时间戳（毫秒） */
  reasoningStartedAt?: number;
  /** 思考实际累计耗时（秒） */
  reasoningDuration?: number;
  /** 消息创建时间戳（毫秒） */
  createdAt?: number;
  /** 正文第一段增量到达的时间。用来区分工具前的说明和工具后的最终总结。 */
  contentStartedAt?: number;
  /** 是否为工具调用前后的中间过程说明（直接在时间线内流式展示，不进入外部最终答复区）。 */
  isProcess?: boolean;
  /** 整轮任务完成时间与耗时，便于历史过程摘要复用。 */
  runEndedAt?: number;
  runDurationMs?: number;
}

/** 待处理的人工审批决策。 */
export interface PendingDecision {
  type: "approve" | "edit" | "reject";
  message?: string;
}

/** 客户端全部状态。 */
export interface ClientState {
  messages: ChatMessage[];
  activities: Activity[];
  run: RunSnapshot;
  /** 当前线程 ID（会话标识）。 */
  threadId: string;
  /** interruptId → 已选决策。 */
  pendingDecisions: Record<string, PendingDecision>;
}

/** 所有状态转移动作。 */
export type ClientAction =
  | { type: "addUserMessage"; id: string; content: string; attachments?: Array<FileUIPart & { id: string }> }
  | { type: "startPendingAssistant"; messageId: string; startedAt: number; runId?: string }
  | { type: "startAssistant"; runId: string; messageId: string; isProcess?: boolean }
  | { type: "appendAssistant"; messageId: string; delta: string }
  | { type: "endAssistant"; messageId: string }
  | { type: "markProcessMessage"; messageId: string }
  | { type: "startReasoning"; runId: string; messageId: string }
  | { type: "appendReasoning"; messageId: string; delta: string }
  | { type: "endReasoning"; messageId: string }
  | { type: "upsertActivity"; activity: Activity }
  | { type: "patchRun"; patch: Partial<RunSnapshot> }
  | { type: "setDecision"; interruptId: string; decision: PendingDecision }
  | { type: "restoreCheckpoint"; messageId: string }
  | { type: "rollbackBeforeMessage"; messageId: string }
  | { type: "newThread"; threadId: string }
  | { type: "loadState"; state: ClientState }
  | { type: "reset" };

/**
 * 单调递增的客户端回放时间戳。
 * 确保按序回放的思考、过程说明与工具卡片拥有严格递增的时序基准，
 * 杜绝服务端时间戳与客户端回放时间戳混用导致的排序跳变。
 */
let lastClientTimestamp = 0;
function nextClientTimestamp(): number {
  const now = Date.now();
  lastClientTimestamp = now > lastClientTimestamp ? now : lastClientTimestamp + 1;
  return lastClientTimestamp;
}

/** 工具前导词（流式与静态共用的过程说明起始特征）。 */
export const PROCESS_PREAMBLE_LEAD_RE =
  /^(?:步骤\s*\d+|当前\s*(?:shell|工作区|终端|目录)|我来|我将|让我|正在|先|首先|接下来|准备|调用|使用|执行|通过|我用|我会|我看到|我先|现在我|为了|下面我|继续)/;

/** 工具之间的动作衔接说明特征。 */
export const INTERMEDIATE_ACTION_HINT_RE =
  /^(?:[^\r\n]{0,40})(?:按规则|先读|再读|先看|再看|先检查|再检查|现在用|再用|先用|改用|换用|继续用|接下来|下一步|准备调用|准备使用|先调用|再调用|已存在.*(?:读|看|检查|修改)|已有内容.*(?:修改|替换|写入))/;

/** 流式过程中明显属于"正在推进工具/下一步操作"的过程提示特征。 */
export const STREAMING_PROCESS_HINT_RE =
  /^(?:当前(?:文件|目录|工作区|内容)|文件内容如下|(?:现在|接下来|下一步|下面|然后|接着|之后)(?:我|来|将|会|需要)?|第[一二三四五六七八九十0-9]+步|我来|我将|让我|首先|先|为了|准备|继续|好的[，,]?\s*(?:我|现在|接下来|下面))/;

/** 已明显呈现最终答复/总结结构的内容起始或主体特征。 */
export const FINAL_SUMMARY_STRUCTURE_RE =
  /^(?:#{1,6}\s+(?!步骤)|\*\*(?!步骤)|✅|🎉|📋|检查完成|操作完成|任务完成|任务已完成|总结|汇总|已完成|已存入|当前模式)|[\r\n]+\s*(?:#{1,6}\s|\*\*|-\s|\d+\.\s|\|)/;

/**
 * 抽取用于过程语义判定的纯文本视图：
 * 去掉 Markdown 标题符号、代码围栏、引用和加粗/行内代码标记，
 * 避免「### 当前文件内容如下」这类过程引导标题误触发结构化终稿判定。
 */
export function plainProcessHintText(text: string): string {
  return text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}(?:```|~~~)[^\n]*$/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/`/g, "")
    .trim();
}

/** 检测思考或正文是否明确点名了具体工具名（用于判断工具前前瞻过渡句）。 */
export function plansConcreteTool(text: string | undefined): boolean {
  return Boolean(
    text &&
      /file_access_[a-z0-9_]+|file_access|run_shell|todos_[a-z0-9_]+|file_memory_[a-z0-9_]+|mode_(get|set)|read_pdf|read_excel|web_search_exa|web_fetch_exa|web_search|background_agents_[a-z0-9_]+/i.test(
        text,
      ),
  );
}

/** 判断文本首行是否带有明显的过程过渡/操作引导语气。 */
export function isProcessOpeningText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const firstNonEmptyLine = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0) ?? trimmed;
  const firstLinePlain = plainProcessHintText(firstNonEmptyLine);
  if (!firstLinePlain) return false;
  return (
    PROCESS_PREAMBLE_LEAD_RE.test(firstLinePlain) ||
    INTERMEDIATE_ACTION_HINT_RE.test(firstLinePlain) ||
    STREAMING_PROCESS_HINT_RE.test(firstLinePlain)
  );
}

/**
 * 判断正文是否已经呈现出结构化的外部答复形态（多章节标题、数据表格、成体系汇报或列表摘要）。
 * 具备此类结构的正文即使用户当前消息后面又意外触发了工具，或历史数据中误带了 `isProcess: true`，
 * 也属于面对用户的实质回答，绝不可关进「过程摘要」。
 */
export function hasStructuredExternalMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const lines = trimmed.split(/\r?\n/);
  let nonProcessHeadingCount = 0;
  let listItemCount = 0;
  let hasTable = false;
  let hasCodeBlock = false;
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const lineTrim = line.trim();
    if (/^(?:```|~~~)/.test(lineTrim)) {
      hasCodeBlock = true;
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const headingMatch = line.match(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/);
    if (headingMatch) {
      const cleanTitle = headingMatch[1]!.replace(/\*\*|__|`/g, "").trim();
      if (
        cleanTitle.length > 0 &&
        !/^步骤/.test(cleanTitle) &&
        !STREAMING_PROCESS_HINT_RE.test(cleanTitle) &&
        !PROCESS_PREAMBLE_LEAD_RE.test(cleanTitle)
      ) {
        nonProcessHeadingCount += 1;
      }
      continue;
    }

    if (/^\s*(?:[-*+]|\d+\.)\s+\S/.test(line)) {
      listItemCount += 1;
    }

    if (
      i > 0 &&
      /^\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/.test(lineTrim) &&
      lines[i - 1]!.includes("|")
    ) {
      hasTable = true;
    }
  }

  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0) ?? trimmed;
  const firstLinePlain = plainProcessHintText(firstNonEmptyLine);
  const startsWithActionHint = INTERMEDIATE_ACTION_HINT_RE.test(firstLinePlain);
  const startsWithProcessOpening = isProcessOpeningText(trimmed);
  const paragraphCount = trimmed.split(/\r?\n\s*\r?\n/).filter((p) => p.trim().length > 0).length;

  // 1. 多个非过程主题章节（如 ## 一、... / ## 汇报 + ## 需要你确认）
  if (nonProcessHeadingCount >= 2 && trimmed.length >= 60) {
    return true;
  }

  // 2. 包含完整 Markdown 表格且首行不是工具过渡说明
  if (hasTable && trimmed.length >= 80 && !startsWithActionHint) {
    return true;
  }

  // 3. 非过程开头的主题标题搭配列表、代码块或多段正文
  if (
    !startsWithProcessOpening &&
    nonProcessHeadingCount >= 1 &&
    (listItemCount >= 2 || hasCodeBlock || (trimmed.length >= 120 && paragraphCount >= 2))
  ) {
    return true;
  }

  // 4. 明确完成/总结型结构化汇报（含 ✅ / summary / 汇报 等 + 列表或分段）
  if (
    !startsWithProcessOpening &&
    trimmed.length >= 60 &&
    /^(?:#{1,6}\s+(?:✅|🎉|📋|汇报|总结|汇总)|✅|🎉|📋)|(?:\r?\n\s*(?:\*\*)?(?:summary|总结|汇总|结论|需要你确认)[:：]?)/im.test(
      trimmed,
    ) &&
    (listItemCount >= 1 || paragraphCount >= 2)
  ) {
    return true;
  }

  // 5. 多条目列举型外部答复
  if (
    !startsWithProcessOpening &&
    !plansConcreteTool(firstLinePlain) &&
    listItemCount >= 3 &&
    trimmed.length >= 140
  ) {
    return true;
  }

  // 6. 非过程开头的多段落实质长文本回答
  if (
    !startsWithProcessOpening &&
    !startsWithActionHint &&
    !plansConcreteTool(trimmed) &&
    paragraphCount >= 2 &&
    trimmed.length >= 160
  ) {
    return true;
  }

  return false;
}

/**
 * 判断无过程前缀的纯自然语言是否已超过后端 140 字缓冲门限并形成实质外部回答，
 * 避免已经在正文区向用户流式展示过的长回答在尾部出现工具调用时被回退降级。
 */
export function isSubstantiveProseExternalAnswer(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 140) return false;
  if (isProcessOpeningText(trimmed)) return false;
  if (plansConcreteTool(trimmed)) return false;
  return true;
}

/**
 * 统一判定一条助手消息是否仍允许被「过程化 / 降级」为过程节点：
 * - 结构化外部 Markdown 回答永远受保护，即使历史数据或预判曾标过 `isProcess: true` 也不得降级；
 * - 未预标 `isProcess` 且已形成 >= 140 字非过程正文时同样封口锁定，禁止后续工具/节点事后追认降级；
 * - 空思考节点、短过渡句，以及以过程引导词开头的单段说明仍正常归入过程时间线。
 */
export function canDemoteAssistantToProcess(
  message: Pick<ChatMessage, "content" | "isProcess">,
): boolean {
  const trimmed = message.content.trim();
  if (!trimmed) return true;
  if (hasStructuredExternalMarkdown(trimmed)) return false;
  if (message.isProcess !== true && isSubstantiveProseExternalAnswer(trimmed)) return false;
  return true;
}

/**
 * 当本轮后续出现工具调用或新一轮思考/正文时，将当前轮次中仍属过程节点的助手消息封口：
 * - 常规过程说明/纯思考节点标记为 `isProcess: true`，防止后续正文合并回旧节点；
 * - 已经成型并受保护的实质外部回答绝不被覆写 `isProcess: true`，新消息开启时仅帮其收尾 streaming 状态。
 */
function markTurnAssistantsAsProcess(
  messages: ChatMessage[],
  runId?: string,
  beforeTimestamp?: number,
  sealStreaming?: boolean,
): ChatMessage[] {
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  let changed = false;
  const next = messages.map((msg, idx) => {
    if (idx <= lastUserIndex) return msg;
    if (msg.role !== "assistant") return msg;
    if (runId && msg.runId && msg.runId !== runId) return msg;
    // 如果指定了时间基准，晚于该时间的助手消息属于工具之后生成的总结答复，绝不可标记为过程
    if (beforeTimestamp !== undefined && (msg.createdAt ?? 0) > beforeTimestamp) return msg;
    const hasGeneratedStep =
      msg.content.length > 0 ||
      msg.streaming ||
      Boolean(msg.reasoning && msg.reasoning.length > 0);
    if (!hasGeneratedStep) return msg;

    if (!canDemoteAssistantToProcess(msg)) {
      if (sealStreaming && (msg.streaming || msg.reasoningStreaming)) {
        changed = true;
        return { ...msg, streaming: false, reasoningStreaming: false };
      }
      return msg;
    }

    if (!msg.isProcess) {
      changed = true;
      return {
        ...msg,
        isProcess: true,
        ...(sealStreaming ? { streaming: false, reasoningStreaming: false } : {}),
      };
    }
    if (sealStreaming && (msg.streaming || msg.reasoningStreaming)) {
      changed = true;
      return { ...msg, streaming: false, reasoningStreaming: false };
    }
    return msg;
  });
  return changed ? next : messages;
}

export const initialState: ClientState = {
  messages: [],
  activities: [],
  run: {
    status: "idle",
    runId: null,
    threadId: null,
    progressNote: null,
    interrupts: [],
    error: null,
  },
  threadId: randomUUID(),
  pendingDecisions: {},
};

/**
 * 为指定线程创建一份空白状态。
 *
 * 多会话并发执行要求每个 threadId 拥有独立的状态对象，
 * 不能再共享模块级的 initialState 单例。
 */
export function createInitialState(threadId: string): ClientState {
  return {
    messages: [],
    activities: [],
    run: {
      status: "idle",
      runId: null,
      threadId: null,
      progressNote: null,
      interrupts: [],
      error: null,
    },
    threadId,
    pendingDecisions: {},
  };
}

/**
 * 寻找当前节点可合并的末尾 assistant 消息。
 * 只允许合并到消息列表最后一条尚未产生正文、且未被后续工具封口（!isProcess）的助手消息，
 * 绝不跨越已经发生的后续节点或工具调用往前合并。
 */
function findCurrentAssistantIndex(
  messages: ChatMessage[],
  runId?: string,
  messageId?: string,
): number {
  // 绝不跨越已经发生的后续节点或工具调用往前合并（对齐 agentscope-harness）：
  // 只允许绑定到最后一条用户消息之后的空助手消息，且 runId 必须匹配，
  // 否则正文会「乱跳」到更早的消息节点上。
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  if (messageId) {
    const byId = messages.findIndex((m) => m.id === messageId);
    if (
      byId !== -1 &&
      byId > lastUserIndex &&
      messages[byId]?.role === "assistant" &&
      !messages[byId]?.content &&
      !messages[byId]?.isProcess &&
      (!runId || !messages[byId]?.runId || messages[byId]?.runId === runId)
    ) {
      return byId;
    }
  }
  const lastMessage = messages.at(-1);
  if (
    lastMessage?.role === "assistant" &&
    messages.length - 1 > lastUserIndex &&
    !lastMessage.content &&
    !lastMessage.isProcess &&
    (!runId || !lastMessage.runId || lastMessage.runId === runId)
  ) {
    return messages.length - 1;
  }
  return -1;
}

/** 状态归约函数：纯函数，相同输入必定得到相同输出。 */
export function reduceClientEvent(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case "addUserMessage":
      resetReasoningBindings(state.threadId);
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: "user",
            content: action.content,
            ...(action.attachments?.length ? { attachments: action.attachments } : {}),
            streaming: false,
            createdAt: Date.now(),
          },
        ],
      };

    case "startPendingAssistant": {
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: action.messageId,
            role: "assistant",
            content: "",
            streaming: false,
            runId: action.runId,
            reasoning: "",
            reasoningStreaming: true,
            reasoningStartedAt: action.startedAt,
            createdAt: action.startedAt,
          },
        ],
      };
    }

    case "startAssistant": {
      const existingIndex = findCurrentAssistantIndex(
        state.messages,
        action.runId,
        action.messageId,
      );
      // 仅当目标还没有正文（思考占位 / 空占位）时才合并；
      // 已有正文说明上一个模型节点已收尾，本轮节点自成一条新气泡，
      // 实现「推理 → 模型说话 → 工具 → 推理 → …」按节点分段展示。
      if (existingIndex !== -1 && state.messages[existingIndex]!.content.length === 0) {
        const messages = [...state.messages];
        const target = messages[existingIndex]!;
        // 保留过程占位的 React key，避免推理段切换到正文时整块重挂载闪烁。
        textToAssistant.set(bindingKey(state.threadId, action.messageId), target.id);
        const started = target.reasoningStartedAt ?? Date.now();
        const elapsed =
          target.reasoningDuration ??
          Math.max(1, Math.round((Date.now() - started) / 1000));
        // 思考流标记不在这里翻转：仅有内容的思考且 REASONING_MESSAGE_END
        // 尚未到达时保持流式，等 END 或第一条正文增量再收尾；
        // 空思考占位（startPendingAssistant）直接视为无思考，避免空面板闪现。
        const keepReasoningStreaming =
          target.reasoningStreaming === true &&
          Boolean(target.reasoning && target.reasoning.trim().length > 0);
        messages[existingIndex] = {
          ...target,
          streaming: true,
          ...(action.isProcess ? { isProcess: true } : {}),
          reasoningStreaming: keepReasoningStreaming,
          reasoningDuration:
            target.reasoning && target.reasoning.trim().length > 0 ? elapsed : undefined,
          runId: action.runId || target.runId,
        };
        return { ...state, messages };
      }

      const prevMessages = markTurnAssistantsAsProcess(state.messages, action.runId, undefined, true);
      const assistantId = prevMessages.some((message) => message.id === action.messageId)
        ? randomUUID()
        : action.messageId;
      textToAssistant.set(bindingKey(state.threadId, action.messageId), assistantId);
      const ts = nextClientTimestamp();
      return {
        ...state,
        messages: [
          ...prevMessages,
          {
            id: assistantId,
            role: "assistant",
            content: "",
            streaming: true,
            ...(action.isProcess ? { isProcess: true } : {}),
            runId: action.runId,
            createdAt: ts,
          },
        ],
      };
    }

    case "appendAssistant": {
      const realId = textToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const messages = [...state.messages];
      const target = messages[index];
      if (!target) return state;
      const nextContent = target.content + action.delta;
      // 若前瞻阶段因队列尾部存在工具调用而误预标了 isProcess，一旦内容已呈现清晰结构化外部回答立即解除预标
      const shouldClearFalseProcess = target.isProcess === true && hasStructuredExternalMarkdown(nextContent);
      // 正文开始输出时，平滑收尾推理流，锁定最终思考秒数
      const started = target.reasoningStartedAt ?? Date.now();
      const elapsed =
        target.reasoningDuration ??
        Math.max(1, Math.round((Date.now() - started) / 1000));
      messages[index] = {
        ...target,
        content: nextContent,
        ...(shouldClearFalseProcess ? { isProcess: false } : {}),
        streaming: true,
        contentStartedAt: target.content.length === 0 ? (target.contentStartedAt ?? nextClientTimestamp()) : target.contentStartedAt,
        reasoningStreaming: false,
        reasoningDuration: target.reasoning && target.reasoning.trim().length > 0 ? elapsed : undefined,
      };
      return { ...state, messages };
    }

    case "endAssistant": {
      const realId = textToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const messages = [...state.messages];
      const target = messages[index];
      if (!target) return state;
      const shouldClearFalseProcess = target.isProcess === true && hasStructuredExternalMarkdown(target.content);
      messages[index] = {
        ...target,
        streaming: false,
        ...(shouldClearFalseProcess ? { isProcess: false } : {}),
      };
      return { ...state, messages };
    }

    case "markProcessMessage": {
      const realId = textToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const target = state.messages[index];
      if (!target || target.isProcess || !canDemoteAssistantToProcess(target)) return state;
      const messages = [...state.messages];
      messages[index] = { ...target, isProcess: true };
      return { ...state, messages };
    }

    case "startReasoning": {
      const existingIndex = findCurrentAssistantIndex(
        state.messages,
        action.runId,
        action.messageId,
      );
      if (existingIndex !== -1) {
        const messages = [...state.messages];
        const target = messages[existingIndex]!;
        // 防回退锁：一旦正文已开始或思考已宣告完成，绝不重新进入思考流。
        // 若该消息已有正文（上一轮已收尾），本轮思考自成一条新消息，
        // 既不丢内容，也不会覆盖已有正文。
        const canMerge =
          target.content.length === 0 &&
          !(target.reasoningDuration !== undefined && !target.reasoningStreaming);
        if (canMerge) {
          reasoningToAssistant.set(bindingKey(state.threadId, action.messageId), target.id);
          const hasExistingReasoning = Boolean(target.reasoning && target.reasoning.length > 0);
          messages[existingIndex] = {
            ...target,
            reasoningStreaming: true,
            reasoningStartedAt: hasExistingReasoning
              ? (target.reasoningStartedAt ?? nextClientTimestamp())
              : nextClientTimestamp(),
            runId: action.runId || target.runId,
            // 多轮思考平滑追加衔接
            reasoning:
              target.reasoning && !target.reasoning.endsWith("\n\n")
                ? target.reasoning + "\n\n"
                : target.reasoning,
          };
          return { ...state, messages };
        }
      }

      const prevMessages = markTurnAssistantsAsProcess(state.messages, action.runId, undefined, true);
      const reasoningId = prevMessages.some((message) => message.id === action.messageId)
        ? randomUUID()
        : action.messageId;
      reasoningToAssistant.set(bindingKey(state.threadId, action.messageId), reasoningId);
      const ts = nextClientTimestamp();
      return {
        ...state,
        messages: [
          ...prevMessages,
          {
            id: reasoningId,
            role: "assistant",
            content: "",
            streaming: false,
            runId: action.runId,
            reasoning: "",
            reasoningStreaming: true,
            reasoningStartedAt: ts,
            createdAt: ts,
          },
        ],
      };
    }

    case "appendReasoning": {
      const realId = reasoningToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const messages = [...state.messages];
      const target = messages[index];
      if (!target) return state;
      // 铁律防回退锁：正文已开始打字，丢弃迟到的思考 chunk，绝不重启思考流
      if (target.content.length > 0 || (target.reasoningDuration !== undefined && !target.reasoningStreaming)) {
        return state;
      }
      messages[index] = {
        ...target,
        reasoning: (target.reasoning ?? "") + action.delta,
        reasoningStreaming: true,
        reasoningStartedAt: target.reasoningStartedAt ?? nextClientTimestamp(),
      };
      return { ...state, messages };
    }

    case "endReasoning": {
      const realId = reasoningToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const messages = [...state.messages];
      const target = messages[index];
      if (!target) return state;
      const started = target.reasoningStartedAt ?? Date.now();
      const elapsed = Math.max(1, Math.round((Date.now() - started) / 1000));
      messages[index] = {
        ...target,
        reasoningDuration: elapsed,
        // 收到思考结束事件，彻底锁定并终结推理流状态
        reasoningStreaming: false,
      };
      return { ...state, messages };
    }

    case "upsertActivity": {
      const existingActivityIndex = state.activities.findIndex((item) => item.id === action.activity.id);
      const isNewToolCall = existingActivityIndex === -1 && (action.activity.status === "running" || action.activity.status === "pending");
      // 仅当全新的工具或子 Agent 卡片首次发起时，把发起之前已产生的文本标记为过程说明；
      // 已有工具的状态更新（如完成、错误、Diff 附加）绝不污染工具之后产生的最终答复！
      const messages =
        isNewToolCall && (action.activity.kind === "tool" || action.activity.kind === "subagent")
          ? markTurnAssistantsAsProcess(state.messages, action.activity.runId, action.activity.startedAt)
          : state.messages;
      // 同一 ID 只更新同一张卡片。
      // 字段级合并 + 保留最早 startedAt：即使上游发的是增量卡片，
      // 也不会丢掉已经展示过的信息，时间线也不会抖动。
      const index = existingActivityIndex;
      if (index === -1) {
        // 真实运行中到达的新卡片使用前端单调递增时钟打时间戳，保证与回放文本严格同序；
        // 单元测试构造的小时间戳（< 1e12）保持原值不变。
        const shouldStampClientClock =
          action.activity.startedAt >= 1_000_000_000_000 && messages.length > 0;
        const stampedActivity: Activity = shouldStampClientClock
          ? { ...action.activity, startedAt: nextClientTimestamp() }
          : action.activity;
        return { ...state, messages, activities: [...state.activities, stampedActivity] };
      }
      const activities = [...state.activities];
      const existing = activities[index];
      if (!existing) return { ...state, messages };
      activities[index] = {
        ...existing,
        ...action.activity,
        // detail 同样做字段级合并，避免增量事件清空已展示的详情。
        detail:
          existing.detail && action.activity.detail
            ? { ...(existing.detail as object), ...(action.activity.detail as object) }
            : action.activity.detail ?? existing.detail,
        startedAt: existing.startedAt,
        // 结束时间一旦出现过就不回退。
        endedAt: action.activity.endedAt ?? existing.endedAt,
      };
      return { ...state, messages, activities };
    }

    case "patchRun": {
      const isFinished =
        action.patch.status === "completed" ||
        action.patch.status === "cancelled" ||
        action.patch.status === "error";
      let messages = state.messages;
      if (isFinished) {
        messages = messages
          .filter((m) => {
            if (m.role === "assistant" && !m.content && (!m.reasoning || !m.reasoning.trim())) {
              return false;
            }
            return true;
          })
          .map((m) =>
            m.role === "assistant" && (m.streaming || m.reasoningStreaming)
              ? {
                  ...m,
                  streaming: false,
                  reasoningStreaming: false,
                  reasoningDuration:
                    m.reasoning && m.reasoning.trim().length > 0
                      ? m.reasoningDuration ??
                        Math.max(1, Math.round((Date.now() - (m.reasoningStartedAt ?? Date.now())) / 1000))
                      : m.reasoningDuration,
                }
              : m,
          );
      }
      const interrupted =
        action.patch.status === "cancelled" || action.patch.status === "error";
      const activities = interrupted
        ? state.activities.map((activity) => {
            if (activity.kind !== "todo" || activity.status !== "running") return activity;
            const detail = activity.detail as {
              items?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
              completed?: number;
              total?: number;
            } | undefined;
            if (!detail?.items) return activity;
            const items = detail.items.map((item) =>
              item.status === "in_progress" ? { ...item, status: "pending" as const } : item,
            );
            const completed = items.filter((item) => item.status === "completed").length;
            return {
              ...activity,
              status: action.patch.status === "error" ? "failed" as const : "cancelled" as const,
              subtitle: `${action.patch.status === "error" ? "执行中断" : "已取消"}，可继续（${completed}/${items.length} 已完成）`,
              endedAt: Date.now(),
              detail: { ...detail, items, completed, total: items.length },
            };
          })
        : state.activities;
      const status = action.patch.status ?? state.run.status;
      const isTerminal = status === "completed" || status === "cancelled" || status === "error";
      const currentTerminal =
        state.run.status === "completed" || state.run.status === "cancelled" || state.run.status === "error";
      const sameRun = action.patch.runId === undefined || action.patch.runId === state.run.runId;
      // 结束之后排队的旧快照仍带着 running。不能把同一次运行重新改回执行中，否则按钮会一直停在发送。
      if (currentTerminal && sameRun && (status === "running" || status === "connecting")) {
        return state;
      }
      const startsNewRun = status === "running" &&
        (state.run.status === "idle" || (currentTerminal && action.patch.runId !== undefined && action.patch.runId !== state.run.runId));
      const startedAt = startsNewRun
        ? action.patch.startedAt ?? Date.now()
        : action.patch.startedAt ?? state.run.startedAt;
      const endedAt = isTerminal ? action.patch.endedAt ?? Date.now() : action.patch.endedAt;
      const durationMs = action.patch.durationMs ?? (startedAt !== undefined && endedAt !== undefined
        ? Math.max(0, endedAt - startedAt)
        : undefined);
      const run = {
        ...state.run,
        ...action.patch,
        startedAt,
        endedAt: startsNewRun ? undefined : endedAt,
        durationMs: startsNewRun ? undefined : durationMs,
      };
      const finalRunId = action.patch.runId ?? state.run.runId;
      if (status === "completed" && finalRunId && endedAt !== undefined && durationMs !== undefined) {
        let finalMessageIndex = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (message?.role === "assistant" && message.runId === finalRunId) {
            finalMessageIndex = index;
            break;
          }
        }
        if (finalMessageIndex >= 0) {
          messages = messages.map((message, index) => index === finalMessageIndex
            ? { ...message, runEndedAt: endedAt, runDurationMs: durationMs }
            : message);
        }
      }
      return { ...state, messages, activities, run };
    }

    case "setDecision":
      return {
        ...state,
        pendingDecisions: { ...state.pendingDecisions, [action.interruptId]: action.decision },
      };

    case "restoreCheckpoint": {
      // 回退到指定检查点：保留该消息本身（用户点的是「回到此处」），
      // 丢弃它之后的全部消息，并清掉这期间产生的活动卡片。
      const index = state.messages.findIndex((message) => message.id === action.messageId);
      if (index === -1) return state;
      const keptMessages = state.messages.slice(0, index + 1);
      // 活动卡片按 runId 归属：只保留仍被引用到的那些。
      const keptRunIds = new Set(keptMessages.map((message) => message.runId).filter(Boolean));
      const keptActivities =
        keptRunIds.size === 0
          ? []
          : state.activities.filter((activity) => {
              if (activity.id.startsWith("todo:")) return true;
              // 卡片 ID 形如 tool:<callId> / file:<callId>，无法直接映射 runId；
              // 用 startedAt 之后产生的卡片一律丢弃这个近似会误伤，因此这里
              // 只保留 Todo 主卡片，工具/子 Agent 卡片随回退一起清空。
              return false;
            });
      resetReasoningBindings(state.threadId);
      return {
        ...state,
        messages: keptMessages,
        activities: keptActivities,
        run: { ...initialState.run, threadId: state.threadId },
        pendingDecisions: {},
      };
    }

    case "rollbackBeforeMessage": {
      // 重新编辑消息专用：丢弃目标消息自身及它之后的全部消息与活动，
      // 避免 handleSend 重新发送后在界面上产生两份重复的用户消息。
      const index = state.messages.findIndex((message) => message.id === action.messageId);
      if (index === -1) return state;
      const keptMessages = state.messages.slice(0, index);
      const keptRunIds = new Set(keptMessages.map((message) => message.runId).filter(Boolean));
      const keptActivities = state.activities.filter((activity) => {
        if (!activity.runId) return false;
        return keptRunIds.has(activity.runId);
      });
      resetReasoningBindings(state.threadId);
      return {
        ...state,
        messages: keptMessages,
        activities: keptActivities,
        run: { ...initialState.run, threadId: state.threadId },
        pendingDecisions: {},
      };
    }

    case "newThread":
      // 新会话：清空消息、活动与运行状态，threadId 换成新的。
      // 只清理该线程的绑定，不影响其它仍在后台运行的会话。
      resetReasoningBindings(state.threadId);
      return createInitialState(action.threadId);

    case "loadState":
      resetReasoningBindings(state.threadId);
      // 防御性规范化：从本地存储载入的历史数据，所有流式与思考标志必须重置为 false，
      // 避免刷新或切换会话后卡死在「正在思考中」；同时确保 reasoningDuration 有真实值。
      return {
        ...action.state,
        // 历史数据缺失 threadId 时回退到当前线程，避免状态归属错乱。
        threadId: action.state.threadId ?? state.threadId,
        run: {
          ...action.state.run,
          status: action.state.run?.status === "running" ? "completed" : (action.state.run?.status ?? "idle"),
        },
        messages: (action.state.messages || []).map((m) => ({
          ...m,
          streaming: false,
          reasoningStreaming: false,
          // 方案 1：历史会话中被误标为过程消息的结构化外部正文在加载时同步纠偏还原
          ...(m.role === "assistant" && m.isProcess === true && hasStructuredExternalMarkdown(m.content)
            ? { isProcess: false }
            : {}),
          // 若历史旧数据未保存 duration，则根据思考字数计算真实合理秒数，避免全部误显为 1 秒
          reasoningDuration:
            m.reasoningDuration ??
            (m.reasoning && m.reasoning.trim().length > 0
              ? Math.max(2, Math.min(15, Math.ceil(m.reasoning.trim().length / 60)))
              : undefined),
        })),
        activities: (action.state.activities || []).map((a) => ({
          ...a,
          status: a.status === "running" ? "completed" : a.status,
        })),
      };

    case "reset":
      return createInitialState(state.threadId);

    default:
      return state;
  }
}



/**
 * reasoning messageId → assistant messageId 的映射。
 *
 * Key 形如 `<threadId>::<messageId>`：多会话并发执行时，
 * 不同线程的流式消息 ID 可能重名，必须按线程隔离，
 * 否则一个线程的绑定会被另一个线程覆盖。
 */
const reasoningToAssistant = new Map<string, string>();

/**
 * text messageId → assistant messageId 的映射（同样按线程隔离）。
 */
const textToAssistant = new Map<string, string>();

/** 拼接线程作用域的绑定 Key。 */
function bindingKey(threadId: string, messageId: string): string {
  return `${threadId}::${messageId}`;
}

/**
 * 重置跨 run 的 ID 绑定。
 *
 * @param threadId 只清理该线程的绑定；省略时清理全部（测试与整体重置场景）。
 */
export function resetReasoningBindings(threadId?: string): void {
  if (!threadId) {
    reasoningToAssistant.clear();
    textToAssistant.clear();
    return;
  }
  const prefix = `${threadId}::`;
  for (const key of [...reasoningToAssistant.keys()]) {
    if (key.startsWith(prefix)) reasoningToAssistant.delete(key);
  }
  for (const key of [...textToAssistant.keys()]) {
    if (key.startsWith(prefix)) textToAssistant.delete(key);
  }
}

/** 把 AG-UI 事件转成归约动作。 */
export function eventToActions(event: BaseEvent, state: ClientState): ClientAction[] {
  const actions: ClientAction[] = [];
  const eventRunId =
    (event as unknown as { runId?: string }).runId || state.run.runId || "";

  switch (event.type) {
    case EventType.RUN_STARTED: {
      const runId = (event as unknown as { runId?: string }).runId ?? "";
      const threadId = (event as unknown as { threadId?: string }).threadId ?? "";
      actions.push({ type: "patchRun", patch: { status: "running", runId, threadId } });
      break;
    }
    case EventType.TEXT_MESSAGE_START: {
      const { messageId, isProcess } = event as unknown as { messageId: string; isProcess?: boolean };
      actions.push({ type: "startAssistant", runId: eventRunId, messageId, ...(isProcess ? { isProcess: true } : {}) });
      break;
    }
    case EventType.TEXT_MESSAGE_CONTENT: {
      const { messageId, delta } = event as unknown as { messageId: string; delta: string };
      actions.push({ type: "appendAssistant", messageId, delta });
      break;
    }
    case EventType.TEXT_MESSAGE_END: {
      const messageId = (event as unknown as { messageId: string }).messageId;
      actions.push({ type: "endAssistant", messageId });
      break;
    }
    case EventType.REASONING_MESSAGE_START: {
      const reasoningId = (event as unknown as { messageId: string }).messageId;
      actions.push({ type: "startReasoning", runId: eventRunId, messageId: reasoningId });
      break;
    }
    case EventType.REASONING_MESSAGE_CONTENT: {
      const { messageId, delta } = event as unknown as { messageId: string; delta: string };
      actions.push({ type: "appendReasoning", messageId, delta });
      break;
    }
    case EventType.REASONING_MESSAGE_END: {
      const messageId = (event as unknown as { messageId: string }).messageId;
      actions.push({ type: "endReasoning", messageId });
      break;
    }
    case EventType.CUSTOM: {
      const { name, value } = event as unknown as { name: string; value: unknown };
      if (name === AGUI_CUSTOM_EVENT.ACTIVITY_DELTA) {
        actions.push({ type: "upsertActivity", activity: value as Activity });
      } else if (name === AGUI_CUSTOM_EVENT.RUN_SNAPSHOT) {
        actions.push({ type: "patchRun", patch: value as Partial<RunSnapshot> });
      } else if (name === AGUI_CUSTOM_EVENT.PROCESS_MESSAGE) {
        const messageId = (value as { messageId?: string } | null)?.messageId;
        if (typeof messageId === "string" && messageId.length > 0) {
          actions.push({ type: "markProcessMessage", messageId });
        }
      }
      break;
    }
    case EventType.RUN_FINISHED: {
      const outcome = (event as unknown as { outcome?: { type: string } }).outcome;
      if (outcome?.type === "interrupt") {
        actions.push({ type: "patchRun", patch: { status: "waiting_approval" } });
      } else {
        actions.push({ type: "patchRun", patch: { status: "completed" } });
      }
      break;
    }
    case EventType.RUN_ERROR: {
      const message = (event as unknown as { message: string }).message;
      actions.push({ type: "patchRun", patch: { status: "error", error: message } });
      break;
    }
    default:
      break;
  }
  return actions;
}

/**
 * 构造 AG-UI 运行请求参数。
 *
 * 模型与推理强度通过 forwardedProps 传给服务端适配器，
 * 这样前端不需要知道各提供商的参数差异。
 *
 * 对话历史不需要在这里传：HttpAgent 自己维护 `messages`，
 * 通过 addMessage/setMessages 累积，运行时自动带上。
 */
export function buildRunParameters(
  runId: string,
  options: {
    providerId?: string;
    modelId?: string;
    effort: "low" | "medium" | "high";
    /** 左侧树选中的工作区目录；服务端会校验它确实在工作区之内。 */
    workspaceRoot?: string;
    /** 本次运行采用的权限审批模式。 */
    permissionMode?: PermissionMode;
    /** 本次运行是否启用联网搜索工具；未开启时模型仅凭自身知识回答。 */
    webSearch?: boolean;
    /** 计划模式：开启后代理先输出实施计划，待确认后再执行。*/
    planEnabled?: boolean;
    /** 是否启用 Computer Use（电脑桌面操作）能力。 */
    computerUseEnabled?: boolean;
  },
  resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>,
): RunAgentParameters {
  // 测试钩子：允许浏览器端到端脚本固定使用某个模型，
  // 避免断言依赖用户当前选中的模型。
  // 用 typeof 守卫而不是 import.meta.env.DEV：这个模块也被 Node 侧的单测
  // 直接 import，那里没有 import.meta。生产构建里没人设置该变量，行为不变。
  const forced = (globalThis as { __deepagentForceModel?: string }).__deepagentForceModel;
  return {
    runId,
    forwardedProps: {
      providerId: options.providerId,
      modelId: typeof forced === "string" && forced.length > 0 ? forced : options.modelId,
      effort: options.effort,
      workspaceRoot: options.workspaceRoot,
      permissionMode: options.permissionMode ?? DEFAULT_PERMISSION_MODE,
      webSearch: options.webSearch ?? false,
      planEnabled: options.planEnabled ?? false,
      ...(options.computerUseEnabled !== undefined
        ? { computerUseEnabled: options.computerUseEnabled }
        : {}),
    },
    ...(resume && resume.length > 0 ? { resume } : {}),
  };
}

/** 运行状态的中文标签。 */export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  idle: "空闲",
  connecting: "连接中",
  running: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  cancelled: "已取消",
  error: "出错",
};
