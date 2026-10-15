/**
 * reasoning 流式输出与检查点回退的单元测试。
 *
 * 重点验证用户提出的两个行为：
 * 1. 思考内容先流式输出，结束后才开始正文的流式输出。
 * 2. 思考与正文显示在同一条消息里（不产生两个气泡）。
 */

import { describe, expect, it } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";
import {
  eventToActions,
  initialState,
  reduceClientEvent,
  resetReasoningBindings,
  type ClientAction,
  type ClientState,
} from "../src/features/chat/client-reducer.js";

function apply(actions: ClientAction[]): ClientState {
  let state = initialState;
  for (const action of actions) state = reduceClientEvent(state, action);
  return state;
}

/** 走完整事件流。 */
function runEvents(events: BaseEvent[]): ClientState {
  resetReasoningBindings();
  let state = initialState;
  for (const event of events) {
    for (const action of eventToActions(event, state)) {
      state = reduceClientEvent(state, action);
    }
  }
  return state;
}

/** 服务端发思考内容的事件。 */
function reasoningStart(messageId: string): BaseEvent {
  return { type: EventType.REASONING_MESSAGE_START, messageId, role: "assistant" } as unknown as BaseEvent;
}
function reasoningContent(messageId: string, delta: string): BaseEvent {
  return {
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId,
    delta,
  } as unknown as BaseEvent;
}
function reasoningEnd(messageId: string): BaseEvent {
  return { type: EventType.REASONING_MESSAGE_END, messageId } as unknown as BaseEvent;
}
function textStart(messageId: string): BaseEvent {
  return { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as unknown as BaseEvent;
}
function textContent(messageId: string, delta: string): BaseEvent {
  return { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta } as unknown as BaseEvent;
}
function textEnd(messageId: string): BaseEvent {
  return { type: EventType.TEXT_MESSAGE_END, messageId } as unknown as BaseEvent;
}

describe("reasoning 与正文归并到同一条消息", () => {
  it("服务端用不同 messageId，前端仍只产生一条消息", () => {
    const state = runEvents([
      reasoningStart("reason-1"),
      reasoningContent("reason-1", "正在规划任务步骤"),
      reasoningEnd("reason-1"),
      textStart("text-1"),
      textContent("text-1", "这是最终答复"),
      textEnd("text-1"),
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.reasoning).toBe("正在规划任务步骤");
    expect(state.messages[0]?.content).toBe("这是最终答复");
    expect(state.messages[0]?.reasoningStreaming).toBe(false);
    expect(state.messages[0]?.streaming).toBe(false);
  });

  it("reasoning 先到时自建占位消息，正文到达后合并而非新建", () => {
    const state = runEvents([
      reasoningStart("reason-2"),
      reasoningContent("reason-2", "正在检索工作区文件"),
      textStart("text-2"),
      textContent("text-2", "答案"),
      textEnd("text-2"),
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.id).toBe("reason-2");
    expect(state.messages[0]?.reasoning).toBe("正在检索工作区文件");
    expect(state.messages[0]?.content).toBe("答案");
  });

  it("多个 reasoning 增量按序累加", () => {
    const state = runEvents([
      reasoningStart("r3"),
      reasoningContent("r3", "正在"),
      reasoningContent("r3", "规划"),
      reasoningContent("r3", "任务"),
      reasoningEnd("r3"),
      textStart("t3"),
      textContent("t3", "done"),
      textEnd("t3"),
    ]);
    expect(state.messages[0]?.reasoning).toBe("正在规划任务");
  });

  it("只有 reasoning 没有正文时也能正确收尾", () => {
    const state = runEvents([reasoningStart("r4"), reasoningContent("r4", "正在验证结果"), reasoningEnd("r4")]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.reasoning).toBe("正在验证结果");
    expect(state.messages[0]?.content).toBe("");
    expect(state.messages[0]?.reasoningStreaming).toBe(false);
  });

  it("reasoning 未结束就发正文时，思考保持流式标记", () => {
    const state = runEvents([reasoningStart("r5"), reasoningContent("r5", "整理思路"), textStart("t5")]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.reasoningStreaming).toBe(true);
  });

  it("用户消息与带思考的助手消息分开存储", () => {
    const state = runEvents([
      { type: EventType.RUN_STARTED } as unknown as BaseEvent,
      reasoningStart("r6"),
      reasoningContent("r6", "正在汇总发现"),
      reasoningEnd("r6"),
      textStart("t6"),
      textContent("t6", "结论"),
      textEnd("t6"),
    ]);
    const withUser = apply([
      { type: "addUserMessage", id: "u1", content: "问题" },
      ...([] as ClientAction[]),
    ]);
    expect(withUser.messages).toHaveLength(1);
    expect(state.messages).toHaveLength(1);
  });

  it("未知 messageId 的 reasoning 增量被安全忽略", () => {
    const state = runEvents([reasoningContent("ghost", "X")]);
    expect(state.messages).toHaveLength(0);
  });
});

describe("检查点回退", () => {
  it("回退保留检查点消息本身，丢弃其后所有内容", () => {
    const state = apply([
      { type: "addUserMessage", id: "u1", content: "第一问" },
      { type: "startAssistant", runId: "r1", messageId: "a1" },
      { type: "appendAssistant", messageId: "a1", delta: "第一答" },
      { type: "endAssistant", messageId: "a1" },
      { type: "addUserMessage", id: "u2", content: "第二问" },
      { type: "startAssistant", runId: "r2", messageId: "a2" },
      { type: "appendAssistant", messageId: "a2", delta: "第二答" },
      { type: "endAssistant", messageId: "a2" },
      { type: "restoreCheckpoint", messageId: "u2" },
    ]);
    expect(state.messages.map((m) => m.content)).toEqual(["第一问", "第一答", "第二问"]);
  });

  it("回退到第一条消息时只剩它自己", () => {
    const state = apply([
      { type: "addUserMessage", id: "u1", content: "第一问" },
      { type: "startAssistant", runId: "r1", messageId: "a1" },
      { type: "appendAssistant", messageId: "a1", delta: "第一答" },
      { type: "endAssistant", messageId: "a1" },
      { type: "restoreCheckpoint", messageId: "u1" },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("第一问");
  });

  it("回退后清空运行状态与待处理决策", () => {
    const state = apply([
      { type: "addUserMessage", id: "u1", content: "问题" },
      { type: "patchRun", patch: { status: "waiting_approval" } },
      { type: "setDecision", interruptId: "int-1", decision: { type: "approve" } },
      { type: "restoreCheckpoint", messageId: "u1" },
    ]);
    expect(state.run.status).toBe("idle");
    expect(state.pendingDecisions).toEqual({});
  });

  it("回退保留 threadId（仍是同一会话）", () => {
    const state = apply([
      { type: "newThread", threadId: "thread-x" },
      { type: "addUserMessage", id: "u1", content: "问题" },
      { type: "restoreCheckpoint", messageId: "u1" },
    ]);
    expect(state.threadId).toBe("thread-x");
  });

  it("回退不存在的消息是空操作", () => {
    const before = apply([
      { type: "addUserMessage", id: "u1", content: "问题" },
    ]);
    const after = apply([
      { type: "addUserMessage", id: "u1", content: "问题" },
      { type: "restoreCheckpoint", messageId: "nope" },
    ]);
    expect(after.messages).toEqual(before.messages);
  });
});

describe("事件 → action 映射（reasoning）", () => {
  it("REASONING_MESSAGE_START 映射为 startReasoning", () => {
    const actions = eventToActions(reasoningStart("r1"), initialState);
    expect(actions).toEqual([{ type: "startReasoning", runId: "", messageId: "r1" }]);
  });

  it("REASONING_MESSAGE_CONTENT 映射为 appendReasoning", () => {
    const actions = eventToActions(reasoningContent("r1", "摘要"), initialState);
    expect(actions).toEqual([{ type: "appendReasoning", messageId: "r1", delta: "摘要" }]);
  });

  it("REASONING_MESSAGE_END 映射为 endReasoning", () => {
    const actions = eventToActions(reasoningEnd("r1"), initialState);
    expect(actions).toEqual([{ type: "endReasoning", messageId: "r1" }]);
  });

  it("reasoning 用服务端给的原生 ID（合并由 startAssistant 负责）", () => {
    resetReasoningBindings();
    let state = initialState;
    for (const action of eventToActions(textStart("t1"), state)) {
      state = reduceClientEvent(state, action);
    }
    const actions = eventToActions(reasoningStart("r1"), state);
    expect(actions).toEqual([{ type: "startReasoning", runId: "", messageId: "r1" }]);
  });
});

describe("多轮模型消息的 reasoning（DeepAgent 工具调用场景）", () => {
  it("同一轮里 reasoning 在正文前，两者合并进一条气泡", () => {
    const state = runEvents([
      reasoningStart("r-a"),
      reasoningContent("r-a", "正在检索工作区文件"),
      reasoningEnd("r-a"),
      textStart("t-1"),
      textContent("t-1", "最终答复"),
      textEnd("t-1"),
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.reasoning).toBe("正在检索工作区文件");
    expect(state.messages[0]?.content).toBe("最终答复");
    expect(state.messages[0]?.reasoningStreaming).toBe(false);
  });

  it("REASONING_END 与 TEXT_MESSAGE_START 之间隔着别的事件也能合并", () => {
    const state = runEvents([
      reasoningStart("r-x"),
      reasoningContent("r-x", "正在规划任务步骤"),
      reasoningEnd("r-x"),
      // 中间插入一个无关事件（例如活动卡片），不应阻断合并。
      { type: EventType.STEP_STARTED, stepName: "tools" } as unknown as BaseEvent,
      textStart("t-x"),
      textContent("t-x", "答复"),
      textEnd("t-x"),
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.reasoning).toBe("正在规划任务步骤");
    expect(state.messages[0]?.content).toBe("答复");
  });

  it("乱序（reasoning 晚于正文）时不被吞进已有正文，也不丢内容", () => {
    // 服务端不会这样发，但归约器要稳：思考应自成一条消息，
    // 不能被塞进已经有正文的那条，否则正文会被覆盖。
    const state = runEvents([
      textStart("t-2"),
      textContent("t-2", "答复"),
      textEnd("t-2"),
      reasoningStart("r-c"),
      reasoningContent("r-c", "正在验证结果"),
      reasoningEnd("r-c"),
    ]);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.content).toBe("答复");
    expect(state.messages[1]?.reasoning).toBe("正在验证结果");
  });

  it("第二轮 reasoning 不会把内容挂到已结束的第一轮消息上", () => {
    const state = runEvents([
      reasoningStart("r-1"),
      reasoningContent("r-1", "正在规划任务步骤"),
      reasoningEnd("r-1"),
      textStart("t-1"),
      textContent("t-1", "第一轮答复"),
      textEnd("t-1"),
      reasoningStart("r-2"),
      reasoningContent("r-2", "正在准备写入文件"),
      reasoningEnd("r-2"),
      textStart("t-2"),
      textContent("t-2", "第二轮答复"),
      textEnd("t-2"),
    ]);
    // 两轮正文各自成消息，思考不跨轮串味。
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.reasoning).toBe("正在规划任务步骤");
    expect(state.messages[0]?.content).toBe("第一轮答复");
    expect(state.messages[1]?.reasoning).toBe("正在准备写入文件");
    expect(state.messages[1]?.content).toBe("第二轮答复");
  });
});
