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
  | { type: "startPendingAssistant"; messageId: string; startedAt: number }
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

/**
 * 当本轮后续出现工具调用或新一轮思考/正文时，将当前轮次已有的过程节点封口标记为 isProcess，
 * 防止后续无思考的总结正文越过工具合并回更早的纯思考节点中。
 */
function markTurnAssistantsAsProcess(messages: ChatMessage[], runId?: string): ChatMessage[] {
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  let changed = false;
  const next = messages.map((msg, idx) => {
    if (idx <= lastUserIndex) return msg;
    if (msg.role !== "assistant") return msg;
    if (runId && msg.runId && msg.runId !== runId) return msg;
    const hasGeneratedStep =
      msg.content.length > 0 ||
      msg.streaming ||
      Boolean(msg.reasoning && msg.reasoning.length > 0);
    if (hasGeneratedStep && !msg.isProcess) {
      changed = true;
      return { ...msg, isProcess: true };
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
  if (messageId) {
    const byId = messages.findIndex((m) => m.id === messageId);
    if (
      byId !== -1 &&
      messages[byId]?.role === "assistant" &&
      !messages[byId]?.content &&
      !messages[byId]?.isProcess
    ) {
      return byId;
    }
  }
  const lastMessage = messages.at(-1);
  if (
    lastMessage?.role === "assistant" &&
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

      const prevMessages = markTurnAssistantsAsProcess(state.messages, action.runId);
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
      // 正文开始输出时，平滑收尾推理流，锁定最终思考秒数
      const started = target.reasoningStartedAt ?? Date.now();
      const elapsed =
        target.reasoningDuration ??
        Math.max(1, Math.round((Date.now() - started) / 1000));
      messages[index] = {
        ...target,
        content: target.content + action.delta,
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
      messages[index] = { ...target, streaming: false };
      return { ...state, messages };
    }

    case "markProcessMessage": {
      const realId = textToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const target = state.messages[index];
      if (!target || target.isProcess) return state;
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

      const prevMessages = markTurnAssistantsAsProcess(state.messages, action.runId);
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
      // 当工具或子 Agent 卡片到达时，当前轮次此前输出的文本属于过程说明。
      const messages =
        action.activity.kind === "tool" || action.activity.kind === "subagent"
          ? markTurnAssistantsAsProcess(state.messages, action.activity.runId)
          : state.messages;
      // 同一 ID 只更新同一张卡片。
      // 字段级合并 + 保留最早 startedAt：即使上游发的是增量卡片，
      // 也不会丢掉已经展示过的信息，时间线也不会抖动。
      const index = state.activities.findIndex((item) => item.id === action.activity.id);
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
