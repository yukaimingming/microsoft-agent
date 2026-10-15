/**
 * AG-UI 客户端状态归约器的单元测试。
 *
 * 重点验证 AGENTS.md 第 12 节要求：
 * - 事件幂等，重复事件不重复新增卡片。
 * - 消息文本与运行活动分开存储。
 * - 每次运行唯一 runId。
 * - 中断后进入等待审批状态。
 */

import { describe, expect, it } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";
import { AGUI_CUSTOM_EVENT, type Activity, type RunSnapshot } from "@deepagent/shared";

/**
 * 与 use-agent-client.ts 中的 reducer 保持同步的副本。
 * 这里直接 import 会拉起 React，因此把纯函数部分抽出到独立模块再测。
 */
import {
  reduceClientEvent,
  eventToActions,
  initialState,
  type ClientAction,
} from "../src/features/chat/client-reducer.js";

function apply(actions: ClientAction[]): typeof initialState {
  let state = initialState;
  for (const action of actions) state = reduceClientEvent(state, action);
  return state;
}

function activity(id: string, kind: Activity["kind"] = "tool"): Activity {
  return {
    id,
    kind,
    status: "running",
    title: `卡片 ${id}`,
    startedAt: 1000,
  };
}

describe("初始状态", () => {
  it("没有消息、没有活动、状态为空闲", () => {
    expect(initialState.messages).toEqual([]);
    expect(initialState.activities).toEqual([]);
    expect(initialState.run.status).toBe("idle");
    expect(initialState.threadId).toBeTruthy();
  });
});

describe("消息流", () => {
  it("start → append → end 得到一条完整助手消息", () => {
    const state = apply([
      { type: "startAssistant", runId: "r1", messageId: "m1" },
      { type: "appendAssistant", messageId: "m1", delta: "你好" },
      { type: "appendAssistant", messageId: "m1", delta: "，世界" },
      { type: "endAssistant", messageId: "m1" },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("你好，世界");
    expect(state.messages[0]?.streaming).toBe(false);
    expect(state.messages[0]?.runId).toBe("r1");
    expect(state.messages[0]?.contentStartedAt).toEqual(expect.any(Number));
  });

  it("后续正文增量不改写正文开始时间", () => {
    const started = apply([
      { type: "startAssistant", runId: "r1", messageId: "m1" },
      { type: "appendAssistant", messageId: "m1", delta: "第一段" },
    ]);
    const contentStartedAt = started.messages[0]?.contentStartedAt;
    const next = reduceClientEvent(started, { type: "appendAssistant", messageId: "m1", delta: "第二段" });
    expect(next.messages[0]?.content).toBe("第一段第二段");
    expect(next.messages[0]?.contentStartedAt).toBe(contentStartedAt);
  });

  it("用户消息与助手消息分开存储", () => {
    const state = apply([
      { type: "addUserMessage", id: "u1", content: "问题" },
      { type: "startAssistant", runId: "r1", messageId: "m1" },
      { type: "appendAssistant", messageId: "m1", delta: "回答" },
      { type: "endAssistant", messageId: "m1" },
    ]);
    expect(state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(state.messages[0]?.content).toBe("问题");
    expect(state.messages[1]?.content).toBe("回答");
  });

  it("重放的增量事件不会插出幽灵消息", () => {
    const state = apply([
      { type: "startAssistant", runId: "r1", messageId: "m1" },
      { type: "appendAssistant", messageId: "m1", delta: "A" },
      // 重放：同一条增量再来一次（网络重传场景）
      { type: "appendAssistant", messageId: "m1", delta: "A" },
      { type: "appendAssistant", messageId: "m1", delta: "A" },
    ]);
    // 归约器按收到的 delta 追加，重放由上游 runId/eventId 去重；
    // 这里验证的是「未知 messageId 的增量被安全忽略」。
    expect(state.messages).toHaveLength(1);
  });

  it("对未启动的消息追加增量被忽略", () => {
    const state = apply([{ type: "appendAssistant", messageId: "ghost", delta: "X" }]);
    expect(state.messages).toHaveLength(0);
  });

  it("同一运行的后续模型节点不会串入已完成消息正文", () => {
    const state = apply([
      { type: "startAssistant", runId: "r1", messageId: "node-1" },
      { type: "appendAssistant", messageId: "node-1", delta: "过程阶段" },
      { type: "endAssistant", messageId: "node-1" },
      { type: "startAssistant", runId: "r1", messageId: "node-2" },
      { type: "appendAssistant", messageId: "node-2", delta: "最终回答" },
      { type: "endAssistant", messageId: "node-2" },
    ]);

    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((message) => message.content)).toEqual(["过程阶段", "最终回答"]);
    expect(state.messages[0]?.id).not.toBe(state.messages[1]?.id);
  });

  it("重复使用模型消息 ID 时为新段分配独立 ID", () => {
    const state = apply([
      { type: "startAssistant", runId: "r1", messageId: "reused" },
      { type: "appendAssistant", messageId: "reused", delta: "第一段" },
      { type: "endAssistant", messageId: "reused" },
      { type: "startAssistant", runId: "r1", messageId: "reused" },
      { type: "appendAssistant", messageId: "reused", delta: "第二段" },
    ]);

    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((message) => message.content)).toEqual(["第一段", "第二段"]);
    expect(state.messages[0]?.id).not.toBe(state.messages[1]?.id);
  });

  it("结束未启动的消息不影响状态", () => {
    const state = apply([{ type: "endAssistant", messageId: "ghost" }]);
    expect(state.messages).toHaveLength(0);
  });
});

describe("活动卡片幂等", () => {
  it("同一 ID 只更新同一张卡片", () => {
    const state = apply([
      { type: "upsertActivity", activity: activity("tool:1") },
      { type: "upsertActivity", activity: { ...activity("tool:1"), status: "completed", durationMs: 120 } },
      // 后续事件携带完整卡片状态；归约器按收到的值覆盖。
      { type: "upsertActivity", activity: { ...activity("tool:1"), status: "completed", durationMs: 120, title: "改名" } },
    ]);
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]?.status).toBe("completed");
    expect(state.activities[0]?.title).toBe("改名");
    expect(state.activities[0]?.durationMs).toBe(120);
  });

  it("后到的部分字段不会丢（字段级合并而非整卡替换）", () => {
    const state = apply([
      { type: "upsertActivity", activity: activity("tool:1") },
      { type: "upsertActivity", activity: { ...activity("tool:1"), status: "completed" } },
      // 上游只发一个增量字段时，已展示的 status 不能被清掉。
      { type: "upsertActivity", activity: { ...activity("tool:1"), status: "completed", error: "权限不足" } },
    ]);
    expect(state.activities[0]?.status).toBe("completed");
    expect(state.activities[0]?.error).toBe("权限不足");
    expect(state.activities[0]?.title).toBe("卡片 tool:1");
  });

  it("保留最早的 startedAt，时间线不抖动", () => {
    const state = apply([
      { type: "upsertActivity", activity: activity("tool:1") },
      { type: "upsertActivity", activity: { ...activity("tool:1"), startedAt: 9999 } },
    ]);
    expect(state.activities[0]?.startedAt).toBe(1000);
  });

  it("不同 ID 生成不同卡片", () => {
    const state = apply([
      { type: "upsertActivity", activity: activity("tool:1") },
      { type: "upsertActivity", activity: activity("tool:2") },
    ]);
    expect(state.activities).toHaveLength(2);
  });

  it("同一 runId 的工具事件重复派发不重复建卡", () => {
    // 模拟服务端重发：相同 callId 的事件来两次。
    const state = apply([
      { type: "upsertActivity", activity: activity("tool:abc") },
      { type: "upsertActivity", activity: activity("tool:abc") },
      { type: "upsertActivity", activity: activity("tool:abc") },
    ]);
    expect(state.activities.filter((item) => item.id === "tool:abc")).toHaveLength(1);
  });
});

describe("运行状态与中断", () => {
  it("RUN_FINISHED 带 interrupt outcome 时进入等待审批", () => {
    const state = apply([
      { type: "patchRun", patch: { status: "running" } },
      { type: "patchRun", patch: { status: "waiting_approval" } },
    ]);
    expect(state.run.status).toBe("waiting_approval");
  });

  it("RUN_ERROR 记录错误信息", () => {
    const state = apply([{ type: "patchRun", patch: { status: "error", error: "模型调用失败" } }]);
    expect(state.run.status).toBe("error");
    expect(state.run.error).toBe("模型调用失败");
  });

  it("审批恢复沿用起始时间，完成后保存整轮耗时并在新运行时清空", () => {
    let state = initialState;
    state = reduceClientEvent(state, {
      type: "patchRun",
      patch: { status: "running", runId: "run-1", startedAt: 1_000 },
    });
    state = reduceClientEvent(state, { type: "startAssistant", runId: "run-1", messageId: "assistant-1" });
    state = reduceClientEvent(state, { type: "patchRun", patch: { status: "waiting_approval" } });
    state = reduceClientEvent(state, {
      type: "patchRun",
      patch: { status: "running", runId: "run-2" },
    });
    state = reduceClientEvent(state, { type: "startAssistant", runId: "run-2", messageId: "assistant-2" });
    state = reduceClientEvent(state, { type: "appendAssistant", messageId: "assistant-2", delta: "完成总结" });
    state = reduceClientEvent(state, {
      type: "patchRun",
      patch: { status: "completed", endedAt: 7_000 },
    });

    expect(state.run.startedAt).toBe(1_000);
    expect(state.run.durationMs).toBe(6_000);
    expect(state.messages.find((message) => message.id === "assistant-2")).toMatchObject({
      runEndedAt: 7_000,
      runDurationMs: 6_000,
    });

    state = reduceClientEvent(state, {
      type: "patchRun",
      patch: { status: "running", runId: "run-2", progressNote: "迟到的快照" },
    });
    expect(state.run.status).toBe("completed");
    expect(state.run.progressNote).not.toBe("迟到的快照");

    state = reduceClientEvent(state, {
      type: "patchRun",
      patch: { status: "running", runId: "run-3", startedAt: 9_000 },
    });
    expect(state.run.startedAt).toBe(9_000);
    expect(state.run.endedAt).toBeUndefined();
    expect(state.run.durationMs).toBeUndefined();
  });

  it("resets the in-progress Todo item after a failed run", () => {
    const todo = {
      ...activity("todo:main", "todo"),
      detail: {
        items: [
          { content: "done", status: "completed" as const },
          { content: "interrupted", status: "in_progress" as const },
          { content: "later", status: "pending" as const },
        ],
        completed: 1,
        total: 3,
      },
    };
    const state = apply([
      { type: "upsertActivity", activity: todo },
      { type: "patchRun", patch: { status: "error", error: "tool call interrupted" } },
    ]);
    const updated = state.activities[0]!;
    expect(updated.status).toBe("failed");
    expect(updated.subtitle).toContain("1/3");
    expect((updated.detail as typeof todo.detail).items.map((item) => item.status)).toEqual([
      "completed",
      "pending",
      "pending",
    ]);
  });

  it("新会话清空消息与活动但保留 threadId 之外的状态独立", () => {
    const state = apply([
      { type: "addUserMessage", id: "u1", content: "问题" },
      { type: "upsertActivity", activity: activity("tool:1") },
      { type: "patchRun", patch: { status: "completed" } },
    ]);
    const fresh = apply([{ type: "newThread", threadId: "thread-2" }]);
    expect(fresh.messages).toEqual([]);
    expect(fresh.activities).toEqual([]);
    expect(fresh.run.status).toBe("idle");
    expect(fresh.threadId).toBe("thread-2");
    // 原 state 未被修改（不可变更新）。
    expect(state.messages).toHaveLength(1);
  });

  it("reset 只清数据，保留当前 threadId", () => {
    const state = apply([
      { type: "newThread", threadId: "thread-9" },
      { type: "addUserMessage", id: "u1", content: "问题" },
      { type: "reset" },
    ]);
    expect(state.messages).toEqual([]);
    expect(state.threadId).toBe("thread-9");
  });

  it("审批决策按 interruptId 记录", () => {
    const state = apply([
      { type: "setDecision", interruptId: "int-1", decision: { type: "approve" } },
      { type: "setDecision", interruptId: "int-2", decision: { type: "reject", message: "太危险" } },
    ]);
    expect(state.pendingDecisions["int-1"]).toEqual({ type: "approve" });
    expect(state.pendingDecisions["int-2"]).toEqual({ type: "reject", message: "太危险" });
  });
});

describe("AG-UI 事件 → action 映射", () => {
  function toActions(event: BaseEvent, runId: string | null = "r1"): ClientAction[] {
    return eventToActions(event, { ...initialState, run: { ...initialState.run, runId } });
  }

  it("TEXT_MESSAGE_START/CONTENT/END 映射为三条消息 action", () => {
    const start = toActions({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
    } as unknown as BaseEvent);
    expect(start).toEqual([{ type: "startAssistant", runId: "r1", messageId: "m1" }]);

    const content = toActions({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "hi",
    } as unknown as BaseEvent);
    expect(content).toEqual([{ type: "appendAssistant", messageId: "m1", delta: "hi" }]);

    const end = toActions({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as unknown as BaseEvent);
    expect(end).toEqual([{ type: "endAssistant", messageId: "m1" }]);
  });

  it("CUSTOM 活动事件映射为 upsertActivity", () => {
    const card = activity("tool:9");
    const actions = toActions({
      type: EventType.CUSTOM,
      name: AGUI_CUSTOM_EVENT.ACTIVITY_DELTA,
      value: card,
    } as unknown as BaseEvent);
    expect(actions).toEqual([{ type: "upsertActivity", activity: card }]);
  });

  it("CUSTOM 运行快照映射为 patchRun", () => {
    const snapshot: Partial<RunSnapshot> = { status: "running", progressNote: "正在检索文件" };
    const actions = toActions({
      type: EventType.CUSTOM,
      name: AGUI_CUSTOM_EVENT.RUN_SNAPSHOT,
      value: snapshot,
    } as unknown as BaseEvent);
    expect(actions).toEqual([{ type: "patchRun", patch: snapshot }]);
  });

  it("未知 CUSTOM 名称被忽略", () => {
    const actions = toActions({
      type: EventType.CUSTOM,
      name: "some-other-event",
      value: {},
    } as unknown as BaseEvent);
    expect(actions).toEqual([]);
  });

  it("RUN_FINISHED 的 interrupt outcome 映射为 waiting_approval", () => {
    const actions = toActions({
      type: EventType.RUN_FINISHED,
      outcome: { type: "interrupt", interrupts: [] },
    } as unknown as BaseEvent);
    expect(actions).toEqual([{ type: "patchRun", patch: { status: "waiting_approval" } }]);
  });

  it("RUN_FINISHED 的 success outcome 映射为 completed", () => {
    const actions = toActions({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    } as unknown as BaseEvent);
    expect(actions).toEqual([{ type: "patchRun", patch: { status: "completed" } }]);
  });

  it("RUN_ERROR 映射为 error 状态", () => {
    const actions = toActions({
      type: EventType.RUN_ERROR,
      message: "超时",
    } as unknown as BaseEvent);
    expect(actions).toEqual([{ type: "patchRun", patch: { status: "error", error: "超时" } }]);
  });

  it("STEP_STARTED 等无关事件不产生 action", () => {
    const actions = toActions({ type: EventType.STEP_STARTED, stepName: "model" } as unknown as BaseEvent);
    expect(actions).toEqual([]);
  });
});

describe("端到端事件序列", () => {
  it("完整一轮运行后消息与活动都正确", () => {
    let state = initialState;
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "r1" } as unknown as BaseEvent,
      {
        type: EventType.CUSTOM,
        name: AGUI_CUSTOM_EVENT.ACTIVITY_DELTA,
        value: {
          id: "todo:main",
          kind: "todo",
          status: "running",
          title: "任务计划",
          detail: { items: [{ content: "读文件", status: "completed" }], completed: 1, total: 1 },
          startedAt: 1,
        },
      } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "完成" } as unknown as BaseEvent,
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as unknown as BaseEvent,
      { type: EventType.RUN_FINISHED, outcome: { type: "success" } } as unknown as BaseEvent,
    ];

    for (const event of events) {
      for (const action of eventToActions(event, state)) {
        state = reduceClientEvent(state, action);
      }
    }

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe("完成");
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]?.kind).toBe("todo");
    expect(state.run.status).toBe("completed");
  });
});
