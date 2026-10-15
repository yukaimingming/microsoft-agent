import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";
import { AGUI_CUSTOM_EVENT } from "@deepagent/shared";
import {
  hasTerminalEvent,
  isSettledRunStatus,
  pullFastEvents,
  queuedContentLength,
  takeRevealStep,
} from "../src/features/chat/stream-playback.js";
import {
  createInitialState,
  eventToActions,
  reduceClientEvent,
} from "../src/features/chat/client-reducer.js";

describe("过程与正文按拍揭示", () => {
  it("长正文拆成连续的小段，剩余部分保持原事件顺序", () => {
    const event = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "一二三四五六七八" } as BaseEvent;
    const first = takeRevealStep(event);
    const second = takeRevealStep(first.rest!);
    expect((first.emit as unknown as { delta: string }).delta).toBe("一二三四");
    expect((second.emit as unknown as { delta: string }).delta).toBe("五六七八");
    expect(second.rest).toBeNull();
  });

  it("思考增量同样逐拍揭示", () => {
    const event = { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "先看目录再读文件" } as BaseEvent;
    const step = takeRevealStep(event);
    expect((step.emit as unknown as { delta: string }).delta).toBe("先看目录");
    expect((step.rest as unknown as { delta: string }).delta).toBe("再读文件");
  });

  it("工具事件整条保留，并且排在已经拆开的正文后面", () => {
    const text = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "一二三四五" } as BaseEvent;
    const tool = { type: EventType.CUSTOM, name: "activity", value: { id: "tool-1" } } as BaseEvent;
    const queue = [text, tool];
    const revealed: string[] = [];
    while (queue.length > 0) {
      const step = takeRevealStep(queue[0]!);
      queue.shift();
      if (step.rest) queue.unshift(step.rest);
      revealed.push(step.emit.type === EventType.TEXT_MESSAGE_CONTENT
        ? (step.emit as unknown as { delta: string }).delta
        : "tool");
    }
    expect(revealed).toEqual(["一二三四", "五", "tool"]);
  });

  it("排在正文后面的工具事件会立刻抽出，不必等逐字揭示", () => {
    const text = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "一二三四五六七八九十一二三四五" } as BaseEvent;
    const tool = {
      type: EventType.CUSTOM,
      name: AGUI_CUSTOM_EVENT.ACTIVITY_DELTA,
      value: { id: "tool-1" },
    } as BaseEvent;
    const queue = [text, tool];
    const fast = pullFastEvents(queue);
    expect(fast).toEqual([tool]);
    expect(queue).toEqual([text]);
  });

  it("运行结束事件排在正文后面时也会立刻抽出", () => {
    const text = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "一二三四五六七八" } as BaseEvent;
    const finished = { type: EventType.RUN_FINISHED } as BaseEvent;
    const queue = [text, finished];
    expect(pullFastEvents(queue)).toEqual([finished]);
    expect(queue).toEqual([text]);
  });

  it("检测到队列存在 RUN_FINISHED 时按严格顺序一次性冲刷思考与正文并立即完成运行状态", () => {
    const queue: BaseEvent[] = [
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1", role: "reasoning" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "先分析问题再给出完整答案" } as BaseEvent,
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "这是模型的最终回答内容。" } as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
      {
        type: EventType.CUSTOM,
        name: AGUI_CUSTOM_EVENT.RUN_SNAPSHOT,
        value: { status: "completed" },
      } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, outcome: { type: "success" } } as unknown as BaseEvent,
    ];

    expect(queuedContentLength(queue)).toBe(24);
    expect(hasTerminalEvent(queue)).toBe(true);

    let state = createInitialState("thread-flush");
    state = reduceClientEvent(state, {
      type: "addUserMessage",
      id: "u1",
      content: "你好",
    });
    state = reduceClientEvent(state, {
      type: "startPendingAssistant",
      messageId: "pending-a1",
      startedAt: 1000,
    });
    state = reduceClientEvent(state, {
      type: "patchRun",
      patch: { status: "running", runId: "run-1" },
    });

    while (queue.length > 0) {
      const next = queue.shift()!;
      for (const action of eventToActions(next, state)) {
        state = reduceClientEvent(state, action);
      }
    }

    expect(isSettledRunStatus(state.run.status)).toBe(true);
    expect(state.run.status).toBe("completed");
    const assistant = state.messages.find((m) => m.role === "assistant");
    expect(assistant?.reasoning).toBe("先分析问题再给出完整答案");
    expect(assistant?.content).toBe("这是模型的最终回答内容。");
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.reasoningStreaming).toBe(false);
  });
});
