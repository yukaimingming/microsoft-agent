import { EventType, type BaseEvent } from "@ag-ui/client";
import { AGUI_CUSTOM_EVENT } from "@deepagent/shared";

/** 每次揭示的字符数。中文按 UTF-16 码元计，大约四个字一拍。 */
export const REVEAL_CHARS = 4;
/** 两拍之间的间隔，让浏览器有机会把这一拍画出来。 */
export const REVEAL_MS = 18;
/** 工具/子 Agent 活动事件之间的平滑间隔，保证多步工具按顺序逐项呈现。 */
export const TOOL_REVEAL_MS = 85;

export interface RevealStep {
  emit: BaseEvent;
  rest: BaseEvent | null;
  waitMs: number;
}

function contentDelta(event: BaseEvent): string | null {
  if (event.type !== EventType.TEXT_MESSAGE_CONTENT && event.type !== EventType.REASONING_MESSAGE_CONTENT) {
    return null;
  }
  const delta = (event as { delta?: unknown }).delta;
  return typeof delta === "string" ? delta : null;
}

function isToolOrSubagentActivityEvent(event: BaseEvent): boolean {
  if (event.type !== EventType.CUSTOM) return false;
  const custom = event as { name?: unknown; value?: { kind?: unknown } };
  if (custom.name !== AGUI_CUSTOM_EVENT.ACTIVITY_DELTA) return false;
  return custom.value?.kind === "tool" || custom.value?.kind === "subagent";
}

/**
 * 把一条事件拆成「现在画出来的一拍」和「还留在队列里的剩余部分」。
 * 思考和正文按到达顺序逐拍揭示；工具活动按平滑节拍逐条揭示，排在已经到达的文本后面。
 */
export function takeRevealStep(event: BaseEvent, stepChars: number = REVEAL_CHARS): RevealStep {
  const delta = contentDelta(event);
  if (delta === null) {
    return {
      emit: event,
      rest: null,
      waitMs: isToolOrSubagentActivityEvent(event) ? TOOL_REVEAL_MS : 0,
    };
  }
  const limit = Math.max(REVEAL_CHARS, stepChars);
  if (delta.length <= limit) return { emit: event, rest: null, waitMs: REVEAL_MS };
  return {
    emit: { ...event, delta: delta.slice(0, limit) } as BaseEvent,
    rest: { ...event, delta: delta.slice(limit) } as BaseEvent,
    waitMs: REVEAL_MS,
  };
}

/** 统计队列中尚未揭示的思考与正文总字符数，用于积压时自适应提速。 */
export function queuedContentLength(queue: readonly BaseEvent[]): number {
  let total = 0;
  for (const event of queue) {
    const delta = contentDelta(event);
    if (delta) total += delta.length;
  }
  return total;
}

/**
 * 扫描回放队列，识别所有「后续跟着工具调用、过程标记或新一轮思考/正文」的文本消息 ID。
 * 这些消息在揭示第一个字符时就应直接标记为 `isProcess: true`，直接在时间线内按序流式输出，
 * 避免先跑到外部 Markdown 回答区再跳回时间线内部。
 */
export function collectProcessMessageIds(queue: readonly BaseEvent[]): Set<string> {
  const processIds = new Set<string>();
  const seenTextMessageIds: string[] = [];

  for (const event of queue) {
    if (
      event.type === EventType.TEXT_MESSAGE_START ||
      event.type === EventType.TEXT_MESSAGE_CONTENT ||
      event.type === EventType.TEXT_MESSAGE_END
    ) {
      const msgId = (event as { messageId?: unknown }).messageId;
      if (typeof msgId === "string" && msgId.length > 0) {
        if (
          event.type === EventType.TEXT_MESSAGE_START &&
          seenTextMessageIds.length > 0 &&
          !seenTextMessageIds.includes(msgId)
        ) {
          for (const prevId of seenTextMessageIds) {
            processIds.add(prevId);
          }
        }
        if (!seenTextMessageIds.includes(msgId)) {
          seenTextMessageIds.push(msgId);
        }
      }
      continue;
    }

    if (event.type === EventType.REASONING_MESSAGE_START) {
      for (const prevId of seenTextMessageIds) {
        processIds.add(prevId);
      }
      continue;
    }

    if (event.type === EventType.CUSTOM) {
      const custom = event as {
        name?: unknown;
        value?: { kind?: unknown; messageId?: unknown };
      };
      if (custom.name === AGUI_CUSTOM_EVENT.PROCESS_MESSAGE) {
        const msgId = custom.value?.messageId;
        if (typeof msgId === "string" && msgId.length > 0) {
          processIds.add(msgId);
        }
      } else if (
        custom.name === AGUI_CUSTOM_EVENT.ACTIVITY_DELTA &&
        (custom.value?.kind === "tool" || custom.value?.kind === "subagent")
      ) {
        for (const prevId of seenTextMessageIds) {
          processIds.add(prevId);
        }
      }
    }
  }

  return processIds;
}

/** 统计队列中某条特定文本消息已累积的字符数。 */
export function queuedTextLengthForMessage(
  queue: readonly BaseEvent[],
  messageId: string,
): number {
  let total = 0;
  for (const event of queue) {
    if (event.type !== EventType.TEXT_MESSAGE_CONTENT) continue;
    const record = event as { messageId?: unknown; delta?: unknown };
    if (record.messageId === messageId && typeof record.delta === "string") {
      total += record.delta.length;
    }
  }
  return total;
}

/** 判断队列中的某条新文本消息是否已具备足够的前瞻判定依据（已确认是过程消息、已收到运行结束或文本已超过阈值）。 */
export function hasLookaheadSignalForMessage(
  queue: readonly BaseEvent[],
  messageId: string,
): boolean {
  if (collectProcessMessageIds(queue).has(messageId)) return true;
  if (hasTerminalEvent(queue)) return true;
  if (queuedTextLengthForMessage(queue, messageId) >= 45) return true;
  return false;
}

/** 队列中是否已经包含运行结束/错误事件。 */
export function hasTerminalEvent(queue: readonly BaseEvent[]): boolean {
  for (const event of queue) {
    if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
      return true;
    }
    if (event.type === EventType.CUSTOM) {
      const custom = event as { name?: unknown; value?: { status?: string } };
      if (custom.name === AGUI_CUSTOM_EVENT.RUN_SNAPSHOT && isSettledRunStatus(custom.value?.status)) {
        return true;
      }
    }
  }
  return false;
}

/** 工具卡片和运行快照事件判断。 */
export function isFastActivityEvent(event: BaseEvent): boolean {
  if (event.type !== EventType.CUSTOM) return false;
  const name = (event as { name?: unknown }).name;
  return name === AGUI_CUSTOM_EVENT.ACTIVITY_DELTA || name === AGUI_CUSTOM_EVENT.RUN_SNAPSHOT;
}

/** 运行开始、结束、失败事件判断。 */
export function isImmediateRunEvent(event: BaseEvent): boolean {
  return event.type === EventType.RUN_STARTED
    || event.type === EventType.RUN_FINISHED
    || event.type === EventType.RUN_ERROR;
}

export function isSettledRunStatus(status: string | undefined): boolean {
  return status === "completed" || status === "error" || status === "cancelled" || status === "waiting_approval";
}

/**
 * 抽出排在当前正文后面的工具/快照事件。
 * 队首保持不动，避免把还没开始揭示的正文顺序打乱。
 */
export function pullFastEvents(queue: BaseEvent[]): BaseEvent[] {
  const fast: BaseEvent[] = [];
  for (let index = 1; index < queue.length;) {
    const event = queue[index];
    if (event && (isFastActivityEvent(event) || isImmediateRunEvent(event))) {
      fast.push(event);
      queue.splice(index, 1);
    } else {
      index += 1;
    }
  }
  return fast;
}

