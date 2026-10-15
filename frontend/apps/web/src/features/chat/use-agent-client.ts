/**
 * AG-UI 客户端的 React Hook（多会话并发运行时）。
 *
 * 设计要点：
 * - 每个 threadId 拥有**独立的** ClientState 与独立的 HttpAgent 实例，
 *   因此「新建对话」或「切换到别的对话」不会打断、也不会污染正在执行的会话。
 * - 运行状态（running）同样按线程记录，后台会话在切走后继续执行，
 *   其事件仍然写入自己的状态；切回来即可看到最新进度。
 * - 纯状态归约逻辑在 client-reducer.ts（可单测），这里只负责：
 *   构造 HttpAgent、发起/取消运行、审批续跑与线程生命周期管理。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventType, HttpAgent, type RunAgentParameters } from "@ag-ui/client";
import type { ContentPart } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import type { FileUIPart } from "ai";
import {
  buildRunParameters,
  createInitialState,
  eventToActions,
  reduceClientEvent,
  type ClientAction,
  type ClientState,
} from "./client-reducer.js";
import {
  collectProcessMessageIds,
  hasLookaheadSignalForMessage,
  isSettledRunStatus,
  queuedContentLength,
  REVEAL_CHARS,
  takeRevealStep,
} from "./stream-playback.js";
import type { PermissionMode } from "@deepagent/shared";

/** 发起一轮运行时需要透传给服务端适配层的配置。 */
export interface AgentRunOptions {
  providerId?: string;
  modelId?: string;
  effort: "low" | "medium" | "high";
  workspaceRoot?: string;
  permissionMode?: PermissionMode;
}

/** 单个中断的决策类型。 */
export interface DecisionInput {
  type: "approve" | "edit" | "reject";
  message?: string;
}

/** 对外暴露的 Agent 客户端接口。 */
export interface AgentClient {
  /** 当前激活会话的状态。 */
  state: ClientState;
  /** 当前激活会话的 threadId（等价于 state.threadId）。 */
  threadId: string;
  /** 当前激活会话是否正在运行。 */
  isRunning: boolean;
  /** 所有正在后台执行的会话 threadId。 */
  runningThreadIds: string[];
  /** 所有已创建的会话状态（含后台会话）。 */
  allStates: Record<string, ClientState>;
  send: (content: string, options: AgentRunOptions, attachments?: Array<FileUIPart & { id: string }>) => Promise<void>;
  stop: () => Promise<void>;
  stopThread: (threadId: string) => Promise<void>;
  submitDecisions: (options: AgentRunOptions) => Promise<void>;
  newThread: (customId?: string) => string;
  setActiveThread: (threadId: string) => void;
  hasThread: (threadId: string) => boolean;
  disposeThread: (threadId: string) => void;
  loadState: (state: ClientState) => void;
  setDecision: (interruptId: string, decision: DecisionInput) => void;
  restoreCheckpoint: (messageId: string) => void;
  rollbackBeforeMessage: (messageId: string) => void;
  /** 清空指定（或当前）会话的全部消息与活动，保留会话本身与工作区绑定。 */
  clearThread: (threadId?: string) => void;
}

function toAguiContent(
  content: string,
  attachments: Array<FileUIPart & { id: string }> = [],
): string | ContentPart[] {
  if (attachments.length === 0) return content;
  const parts: ContentPart[] = [];
  if (content.trim()) parts.push({ type: "text", text: content });
  for (const attachment of attachments) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(attachment.url);
    if (!match?.[1] || !match[2]) continue;
    const mimeType = attachment.mediaType || match[1];
    const source = { type: "data" as const, value: match[2], mimeType };
    if (mimeType.startsWith("image/")) {
      parts.push({ type: "image", source, metadata: { filename: attachment.filename } });
    } else {
      parts.push({ type: "document", source, metadata: { filename: attachment.filename } });
    }
  }
  return parts.length > 0 ? parts : content;
}

/** AG-UI 客户端 Hook。 */
export function useAgentClient(serverUrl: string): AgentClient {
  // 初始会话：threadId 只生成一次，threads 与 activeThreadId 由同一次初始化
  // 推导得出，保证二者一致（刻意不使用 ref，避免在渲染期读取 ref）。
  const [activeThreadId, setActiveThreadId] = useState<string>(() => cryptoRandomId());
  const [threads, setThreads] = useState<Record<string, ClientState>>(() => ({
    [activeThreadId]: createInitialState(activeThreadId),
  }));
  const [runningMap, setRunningMap] = useState<Record<string, boolean>>({});

  /**
   * threadsRef / runningRef / activeThreadIdRef 是「权威副本」：
   * 事件回调是异步触发的，不能依赖 React state 的闭包快照，
   * 否则并发会话之间会互相读到过期的状态。
   */
  const threadsRef = useRef(threads);
  const runningRef = useRef(runningMap);
  const activeThreadIdRef = useRef(activeThreadId);
  /** threadId → HttpAgent：每个会话独立的消息历史与运行句柄。 */
  const agentsRef = useRef(new Map<string, HttpAgent>());
  /** 被用户主动取消的线程，用于区分「取消」与「真实错误」。 */
  const cancelledRef = useRef(new Set<string>());
  /** 每个会话尚未揭示的事件。思考和正文按拍切开，工具事件排在已到达文本之后。 */
  const playbackQueuesRef = useRef(new Map<string, BaseEvent[]>());
  const playbackActiveRef = useRef(new Set<string>());
  /** 唤醒正在等待下一拍定时器的回放循环（收到前瞻信号或取消时立即唤醒）。 */
  const playbackWakeRef = useRef(new Map<string, () => void>());
  /** 当前正在做过程消息前瞻等待的 messageId（threadId -> messageId）。 */
  const lookaheadWaitingRef = useRef(new Map<string, string>());
  /** 已经完成过前瞻判定的文本消息 ID 集合。 */
  const lookaheadDoneRef = useRef(new Set<string>());

  const wakePlayback = useCallback((threadId: string): void => {
    const wake = playbackWakeRef.current.get(threadId);
    if (wake) {
      playbackWakeRef.current.delete(threadId);
      wake();
    }
  }, []);

  /** 取得（或惰性创建）指定线程的 HttpAgent。 */
  const getAgent = useCallback(
    (threadId: string): HttpAgent => {
      let agent = agentsRef.current.get(threadId);
      if (!agent) {
        agent = new HttpAgent({ url: serverUrl, headers: {}, threadId });
        agentsRef.current.set(threadId, agent);
      }
      return agent;
    },
    [serverUrl],
  );

  /** 把一批动作归约进指定线程的状态。 */
  const applyActions = useCallback((threadId: string, actions: ClientAction[]): void => {
    if (actions.length === 0) return;
    const current = threadsRef.current[threadId] ?? createInitialState(threadId);
    let next = current;
    for (const action of actions) next = reduceClientEvent(next, action);
    if (next === current) return;
    // 同步更新权威副本，保证同一 tick 内连续到达的事件读到最新状态。
    threadsRef.current = { ...threadsRef.current, [threadId]: next };
    setThreads(threadsRef.current);
  }, []);

  const clearPlayback = useCallback((threadId: string): void => {
    playbackQueuesRef.current.set(threadId, []);
    lookaheadWaitingRef.current.delete(threadId);
    wakePlayback(threadId);
  }, [wakePlayback]);

  /** 更新某个线程的运行中标记。 */
  const setRunningFor = useCallback((threadId: string, running: boolean): void => {
    if (runningRef.current[threadId] === running) return;
    runningRef.current = { ...runningRef.current, [threadId]: running };
    setRunningMap(runningRef.current);
  }, []);

  const releaseRunningIfSettled = useCallback((threadId: string): void => {
    const status = threadsRef.current[threadId]?.run.status;
    if (isSettledRunStatus(status)) setRunningFor(threadId, false);
  }, [setRunningFor]);

  /** 同步按顺序冲刷指定线程队列中剩余的全部事件（用于报错或强制兜底）。 */
  const flushPlayback = useCallback((threadId: string): void => {
    lookaheadWaitingRef.current.delete(threadId);
    wakePlayback(threadId);
    const queue = playbackQueuesRef.current.get(threadId);
    if (!queue || queue.length === 0) return;
    const processIds = collectProcessMessageIds(queue);
    while (queue.length > 0) {
      if (cancelledRef.current.has(threadId)) {
        queue.length = 0;
        break;
      }
      let next = queue.shift();
      if (!next) break;
      if (next.type === EventType.TEXT_MESSAGE_START) {
        const msgId = (next as { messageId?: string }).messageId ?? "";
        if (msgId && processIds.has(msgId)) {
          next = { ...next, isProcess: true } as BaseEvent;
        }
      }
      const current = threadsRef.current[threadId] ?? createInitialState(threadId);
      applyActions(threadId, eventToActions(next, current));
    }
    releaseRunningIfSettled(threadId);
  }, [applyActions, releaseRunningIfSettled, wakePlayback]);

  const pumpPlaybackRef = useRef<(threadId: string) => void>(() => {});

  /** 等待指定线程的回放队列自然按拍播放完毕。 */
  const waitForPlayback = useCallback(async (threadId: string): Promise<void> => {
    for (;;) {
      const pending = playbackQueuesRef.current.get(threadId);
      const active = playbackActiveRef.current.has(threadId);
      if (!active && (!pending || pending.length === 0)) return;
      if (!active && pending && pending.length > 0) pumpPlaybackRef.current(threadId);
      if (cancelledRef.current.has(threadId)) return;
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
  }, []);

  const pumpPlayback = useCallback((threadId: string): void => {
    if (playbackActiveRef.current.has(threadId)) return;
    playbackActiveRef.current.add(threadId);
    const queue = playbackQueuesRef.current.get(threadId) ?? [];
    playbackQueuesRef.current.set(threadId, queue);
    const step = async (): Promise<void> => {
      try {
        while (queue.length > 0) {
          if (cancelledRef.current.has(threadId)) {
            queue.length = 0;
            break;
          }
          let next = queue[0];
          if (!next) break;

          // 对即将开始揭示的文本消息做短暂前瞻：若它是伴随工具调用的简短过程说明，
          // 等 PROCESS_MESSAGE / ACTIVITY_DELTA 进队后再揭示第 1 个字，使其直接从时间线内部流式长出。
          if (next.type === EventType.TEXT_MESSAGE_START) {
            const msgId = (next as { messageId?: string }).messageId ?? "";
            if (
              msgId &&
              !hasLookaheadSignalForMessage(queue, msgId) &&
              !lookaheadDoneRef.current.has(msgId)
            ) {
              lookaheadDoneRef.current.add(msgId);
              lookaheadWaitingRef.current.set(threadId, msgId);
              await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                  lookaheadWaitingRef.current.delete(threadId);
                  playbackWakeRef.current.delete(threadId);
                  resolve();
                }, 1200);
                playbackWakeRef.current.set(threadId, () => {
                  clearTimeout(timer);
                  lookaheadWaitingRef.current.delete(threadId);
                  playbackWakeRef.current.delete(threadId);
                  resolve();
                });
              });
              if (cancelledRef.current.has(threadId)) {
                queue.length = 0;
                break;
              }
              next = queue[0];
              if (!next) break;
            }
          }

          const processIds = collectProcessMessageIds(queue);
          if (next.type === EventType.TEXT_MESSAGE_START) {
            const msgId = (next as { messageId?: string }).messageId ?? "";
            if (msgId && processIds.has(msgId)) {
              next = { ...next, isProcess: true } as BaseEvent;
              queue[0] = next;
            }
          } else if (next.type === EventType.TEXT_MESSAGE_CONTENT) {
            const msgId = (next as { messageId?: string }).messageId ?? "";
            if (msgId && processIds.has(msgId)) {
              applyActions(threadId, [{ type: "markProcessMessage", messageId: msgId }]);
            }
          }

          const backlog = queuedContentLength(queue);
          const dynamicStep = backlog > 32 ? Math.max(REVEAL_CHARS, Math.ceil(backlog / 5)) : REVEAL_CHARS;
          const reveal = takeRevealStep(next, dynamicStep);
          queue.shift();
          if (reveal.rest) queue.unshift(reveal.rest);
          const current = threadsRef.current[threadId] ?? createInitialState(threadId);
          applyActions(threadId, eventToActions(reveal.emit, current));
          releaseRunningIfSettled(threadId);
          if (reveal.waitMs > 0 && queue.length > 0) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                playbackWakeRef.current.delete(threadId);
                resolve();
              }, reveal.waitMs);
              playbackWakeRef.current.set(threadId, () => {
                clearTimeout(timer);
                playbackWakeRef.current.delete(threadId);
                resolve();
              });
            });
          }
        }
      } finally {
        playbackActiveRef.current.delete(threadId);
        if (queue.length > 0 && !cancelledRef.current.has(threadId)) pumpPlayback(threadId);
      }
    };
    void step();
  }, [applyActions, releaseRunningIfSettled]);

  pumpPlaybackRef.current = pumpPlayback;

  const enqueueEvent = useCallback((threadId: string, event: BaseEvent): void => {
    if (event.type === EventType.RUN_STARTED) {
      const current = threadsRef.current[threadId] ?? createInitialState(threadId);
      applyActions(threadId, eventToActions(event, current));
      return;
    }
    const queue = playbackQueuesRef.current.get(threadId) ?? [];
    queue.push(event);
    playbackQueuesRef.current.set(threadId, queue);
    // 若当前队首正在做短文本前瞻等待，且本事件的到来已满足前瞻判定条件，0ms 立即唤醒开始流式揭示。
    const waitingMsgId = lookaheadWaitingRef.current.get(threadId);
    if (waitingMsgId && hasLookaheadSignalForMessage(queue, waitingMsgId)) {
      wakePlayback(threadId);
    }
    pumpPlayback(threadId);
  }, [applyActions, pumpPlayback, wakePlayback]);

  /** 切换激活会话（不中断任何后台运行）。 */
  const switchActiveThread = useCallback((threadId: string): void => {
    activeThreadIdRef.current = threadId;
    setActiveThreadId(threadId);
  }, []);

  /** 确保线程存在（不存在则创建空状态与 HttpAgent）。 */
  const ensureThread = useCallback(
    (threadId: string): void => {
      if (!threadsRef.current[threadId]) {
        threadsRef.current = { ...threadsRef.current, [threadId]: createInitialState(threadId) };
        setThreads(threadsRef.current);
      }
      getAgent(threadId);
    },
    [getAgent],
  );

  /** 发起一轮运行（新消息或审批续跑共用）。 */
  const runOnce = useCallback(
    async (threadId: string, parameters: RunAgentParameters): Promise<void> => {
      const agent = getAgent(threadId);
      // 新运行启动即清掉上一轮遗留的审批中断与进度摘要：
      // 否则批准后恢复运行时，底部「继续执行」栏仍挂着旧中断，
      // 按钮又因运行中被禁用，看起来就是「点了不会继续」。
      applyActions(threadId, [
        {
          type: "patchRun",
          patch: {
            status: "running",
            runId: parameters.runId,
            error: null,
            interrupts: [],
            progressNote: null,
          },
        },
      ]);
      setRunningFor(threadId, true);

      // HttpAgent 的 defaultApplyEvents 会把 REASONING_* 事件也物化成消息，
      // 于是 agent.messages 里出现 role="reasoning" 的条目。服务端的
      // RunAgentInput schema 只认 user/assistant/system/tool/developer，
      // 第二轮运行就会 400。发送前过滤掉。
      const allowedRoles = new Set(["user", "assistant", "system", "tool", "developer"]);
      const sanitized = agent.messages.filter((message) =>
        allowedRoles.has(String(message.role)),
      );
      if (sanitized.length !== agent.messages.length) {
        agent.setMessages(sanitized);
      }

      try {
        await agent.runAgent(parameters, {
          onEvent: ({ event }) => {
            enqueueEvent(threadId, event);
          },
          onRunFailed: ({ error }) => {
            flushPlayback(threadId);
            applyActions(threadId, [
              { type: "patchRun", patch: { status: "error", error: String(error) } },
            ]);
            setRunningFor(threadId, false);
          },
        });
      } catch (error) {
        flushPlayback(threadId);
        if (cancelledRef.current.has(threadId)) {
          applyActions(threadId, [
            { type: "patchRun", patch: { status: "cancelled", progressNote: "已取消" } },
          ]);
        } else {
          applyActions(threadId, [
            {
              type: "patchRun",
              patch: {
                status: "error",
                error: error instanceof Error ? error.message : String(error),
              },
            },
          ]);
        }
      } finally {
        await waitForPlayback(threadId);
        if (!cancelledRef.current.has(threadId)) {
          const current = threadsRef.current[threadId];
          const status = current?.run.status;
          if (status === "running" || status === "connecting") {
            const hasAnswer = current?.messages.some(
              (message) =>
                message.role === "assistant" &&
                (message.content.trim().length > 0 || Boolean(message.reasoning && message.reasoning.trim().length > 0)),
            ) ?? false;
            applyActions(threadId, [
              {
                type: "patchRun",
                patch: hasAnswer
                  ? { status: "completed" }
                  : { status: "error", error: "Agent 流意外结束，请检查连接后继续任务" },
              },
            ]);
          }
        }
        cancelledRef.current.delete(threadId);
        // 这一轮的流与按序回放均已结束，按钮和侧栏立即退出执行中。
        setRunningFor(threadId, false);
      }
    },
    [applyActions, enqueueEvent, flushPlayback, getAgent, setRunningFor, waitForPlayback],
  );

  /** 发送一条新消息到指定会话。 */
  const sendToThread = useCallback(
    async (
      threadId: string,
      content: string,
      options: AgentRunOptions,
      attachments: Array<FileUIPart & { id: string }> = [],
    ): Promise<void> => {
      const trimmed = content.trim();
      if (trimmed.length === 0 && attachments.length === 0) return;
      // 只有「同一个会话」不允许重复触发；其它会话的运行不受影响。
      if (runningRef.current[threadId]) return;

      ensureThread(threadId);
      const agent = getAgent(threadId);
      const messageId = cryptoRandomId();
      const assistantMessageId = cryptoRandomId();
      const runId = cryptoRandomId();
      const now = Date.now();
      applyActions(threadId, [
        {
          type: "addUserMessage",
          id: messageId,
          content: trimmed,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        { type: "startPendingAssistant", messageId: assistantMessageId, startedAt: now },
        {
          type: "patchRun",
          patch: { status: "running", runId, error: null, interrupts: [], progressNote: null },
        },
      ]);

      // 把用户消息同步给该线程的 HttpAgent，它会在运行请求里带上完整历史。
      agent.addMessage({
        id: messageId,
        role: "user",
        content: toAguiContent(trimmed, attachments),
      });
      await runOnce(threadId, buildRunParameters(runId, options));
    },
    [applyActions, ensureThread, getAgent, runOnce],
  );

  /** 取消指定会话的运行。 */
  const stopThread = useCallback(
    async (threadId: string): Promise<void> => {
      const agent = agentsRef.current.get(threadId);
      cancelledRef.current.add(threadId);
      clearPlayback(threadId);
      agent?.abortRun();
      try {
        await fetch(`${serverUrl}/agent/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId }),
        });
      } catch {
        // 取消通知失败不阻塞 UI 状态更新。
      }
      applyActions(threadId, [
        { type: "patchRun", patch: { status: "cancelled", progressNote: "已取消" } },
      ]);
      // 把仍在流式的消息收尾，避免一直显示「生成中」。
      const current = threadsRef.current[threadId];
      if (current) {
        for (const message of current.messages) {
          if (message.streaming) applyActions(threadId, [{ type: "endAssistant", messageId: message.id }]);
        }
      }
      setRunningFor(threadId, false);
    },
    [applyActions, clearPlayback, serverUrl, setRunningFor],
  );

  /** 新建会话：只创建新线程并切过去，绝不触碰其它正在运行的会话。 */
  const newThread = useCallback(
    (customId?: string): string => {
      const threadId = customId || cryptoRandomId();
      ensureThread(threadId);
      switchActiveThread(threadId);
      return threadId;
    },
    [ensureThread, switchActiveThread],
  );

  /** 切换激活会话（若线程不存在则创建一个空的）。 */
  const setActiveThread = useCallback(
    (threadId: string): void => {
      ensureThread(threadId);
      switchActiveThread(threadId);
    },
    [ensureThread, switchActiveThread],
  );

  /** 该线程是否已在内存中（含正在后台运行的会话）。 */
  const hasThread = useCallback((threadId: string): boolean => {
    return Object.prototype.hasOwnProperty.call(threadsRef.current, threadId);
  }, []);

  /** 彻底释放某个会话的运行时（删除会话时调用）。 */
  const disposeThread = useCallback(
    (threadId: string): void => {
      const agent = agentsRef.current.get(threadId);
      if (agent) {
        cancelledRef.current.add(threadId);
        clearPlayback(threadId);
        try {
          agent.abortRun();
        } catch {
          // 忽略中止异常
        }
        agentsRef.current.delete(threadId);
      }
      void fetch(`${serverUrl}/agent/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId }),
      }).catch(() => {
        // 服务端可能已无该运行，忽略。
      });

      const next = { ...threadsRef.current };
      delete next[threadId];
      let nextActive = activeThreadIdRef.current;
      if (nextActive === threadId) {
        const remaining = Object.keys(next);
        if (remaining.length > 0) {
          nextActive = remaining[0]!;
        } else {
          nextActive = cryptoRandomId();
          next[nextActive] = createInitialState(nextActive);
        }
      }
      threadsRef.current = next;
      setThreads(next);
      switchActiveThread(nextActive);
      setRunningFor(threadId, false);
    },
    [clearPlayback, serverUrl, setRunningFor, switchActiveThread],
  );

  /** 载入已有会话状态（从本地存储恢复）。 */
  const loadState = useCallback(
    (incoming: ClientState): void => {
      const threadId = incoming.threadId || cryptoRandomId();
      // 正在后台运行的会话不允许被磁盘快照覆盖，否则会丢掉实时进度。
      if (runningRef.current[threadId]) {
        switchActiveThread(threadId);
        return;
      }
      const normalized = reduceClientEvent(createInitialState(threadId), {
        type: "loadState",
        state: { ...incoming, threadId },
      });
      threadsRef.current = { ...threadsRef.current, [threadId]: normalized };
      setThreads(threadsRef.current);

      const agent = getAgent(threadId);
      agent.setMessages(
        normalized.messages.map((message) => message.role === "user"
          ? { id: message.id, role: "user" as const, content: toAguiContent(message.content, message.attachments) }
          : { id: message.id, role: "assistant" as const, content: message.content }),
      );
      switchActiveThread(threadId);
    },
    [getAgent, switchActiveThread],
  );

  /** 提交审批决策，恢复被中断的运行。 */
  const submitDecisions = useCallback(
    async (options: AgentRunOptions): Promise<void> => {
      const threadId = activeThreadIdRef.current;
      if (runningRef.current[threadId]) return;
      const current = threadsRef.current[threadId];
      const interrupts = current?.run.interrupts ?? [];
      if (
        interrupts.length === 0 ||
        interrupts.some((interrupt) => !current?.pendingDecisions[interrupt.id])
      ) return;

      const resume = interrupts.flatMap((interrupt) => {
        const decision = current?.pendingDecisions[interrupt.id];
        const payload =
          decision?.type === "reject"
            ? { type: "reject", message: decision.message ?? "用户拒绝了该操作。" }
            : decision?.type === "edit"
              ? { type: "edit" }
              : { type: "approve" };
        // 一个 LangGraph interrupt 可以同时包含多个需要审批的 action；
        // resume 的 decisions 必须与挂起的工具调用逐项对应。
        const decisionCount = Array.isArray(interrupt.args) ? interrupt.args.length : 1;
        return Array.from({ length: decisionCount }, () => ({
          interruptId: interrupt.id,
          status: "resolved" as const,
          payload,
        }));
      });

      await runOnce(threadId, buildRunParameters(cryptoRandomId(), options, resume));
    },
    [runOnce],
  );

  /** 设置当前激活会话中某个中断的决策。 */
  const setDecision = useCallback(
    (interruptId: string, decision: DecisionInput): void => {
      applyActions(activeThreadIdRef.current, [
        { type: "setDecision", interruptId, decision },
      ]);
    },
    [applyActions],
  );

  /**
   * 回退到指定检查点：丢弃该点之后的全部消息与活动，
   * 并同步该线程 HttpAgent 的历史，后续发送不会带上被回退的内容。
   */
  const restoreCheckpoint = useCallback(
    (messageId: string): void => {
      const threadId = activeThreadIdRef.current;
      clearPlayback(threadId);
      applyActions(threadId, [{ type: "restoreCheckpoint", messageId }]);
      const agent = getAgent(threadId);
      const kept = threadsRef.current[threadId]?.messages ?? [];
      agent.setMessages(
        kept.map((message) =>
          message.role === "user"
            ? { id: message.id, role: "user" as const, content: toAguiContent(message.content, message.attachments) }
            : { id: message.id, role: "assistant" as const, content: message.content },
        ),
      );
    },
    [applyActions, clearPlayback, getAgent],
  );

  /** 重新编辑前回退：彻底丢弃被编辑消息及后续所有内容，避免产生重复消息。 */
  const rollbackBeforeMessage = useCallback(
    (messageId: string): void => {
      const threadId = activeThreadIdRef.current;
      clearPlayback(threadId);
      applyActions(threadId, [{ type: "rollbackBeforeMessage", messageId }]);
      const agent = getAgent(threadId);
      const kept = threadsRef.current[threadId]?.messages ?? [];
      agent.setMessages(
        kept.map((message) =>
          message.role === "user"
            ? { id: message.id, role: "user" as const, content: toAguiContent(message.content, message.attachments) }
            : { id: message.id, role: "assistant" as const, content: message.content },
        ),
      );
    },
    [applyActions, clearPlayback, getAgent],
  );

  /**
   * 清空指定（或当前）会话的全部消息与活动：保留 threadId 与会话条目，
   * 同步重置该线程 HttpAgent 的历史，避免下一轮运行带上已清空的内容。
   */
  const clearThread = useCallback(
    (threadId?: string): void => {
      const id = threadId ?? activeThreadIdRef.current;
      const agent = agentsRef.current.get(id);
      if (agent) agent.setMessages([]);
      applyActions(id, [{ type: "reset" }]);
    },
    [applyActions],
  );

  // 激活线程变化时同步权威副本。
  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  const state = useMemo(
    () => threads[activeThreadId] ?? createInitialState(activeThreadId),
    [threads, activeThreadId],
  );

  const runningThreadIds = useMemo(
    () =>
      Object.keys(runningMap).filter(
        (id) => runningMap[id] === true && !isSettledRunStatus(threads[id]?.run.status),
      ),
    [runningMap, threads],
  );

  const send = useCallback(
    (content: string, options: AgentRunOptions, attachments?: Array<FileUIPart & { id: string }>) =>
      sendToThread(activeThreadIdRef.current, content, options, attachments),
    [sendToThread],
  );

  const stop = useCallback(
    () => stopThread(activeThreadIdRef.current),
    [stopThread],
  );

  /**
   * 测试钩子：让浏览器端到端脚本能直接往状态机派发事件序列，
   * 从而在不调用真实模型的情况下验证 reasoning / 正文的渲染时序。
   * 只在开发模式挂载，生产构建不包含。
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hooks = {
      dispatch: (events: unknown[]) => {
        const threadId = activeThreadIdRef.current;
        const actions: ClientAction[] = [];
        for (const event of events) {
          const current = threadsRef.current[threadId] ?? createInitialState(threadId);
          actions.push(...eventToActions(event as never, current));
        }
        applyActions(threadId, actions);
      },
      /** 供测试读取当前状态（直接读权威副本，避免等待 React 重渲染）。 */
      getState: () => threadsRef.current[activeThreadIdRef.current],
    };
    (globalThis as unknown as { __deepagentTestHooks?: typeof hooks }).__deepagentTestHooks = hooks;
    return () => {
      delete (globalThis as unknown as { __deepagentTestHooks?: typeof hooks }).__deepagentTestHooks;
    };
  }, [applyActions]);

  return {
    state,
    threadId: state.threadId,
    isRunning: runningMap[activeThreadId] === true && !isSettledRunStatus(state.run.status),
    runningThreadIds,
    allStates: threads,
    send,
    stop,
    stopThread,
    submitDecisions,
    newThread,
    setActiveThread,
    hasThread,
    disposeThread,
    loadState,
    setDecision,
    restoreCheckpoint,
    rollbackBeforeMessage,
    clearThread,
  };
}

/** 生成随机 ID。 */
function cryptoRandomId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
