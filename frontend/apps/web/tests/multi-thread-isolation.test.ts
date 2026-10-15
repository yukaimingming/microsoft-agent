/**
 * 多会话并发下的状态隔离测试。
 *
 * 背景：原先 reasoning / text 的 messageId → assistant messageId 绑定是
 * 模块级全局 Map。两个会话同时在跑时，一个会话的绑定会被另一个会话覆盖，
 * 表现为「A 会话的正文流到一半就没了」。
 *
 * 这里用两个线程交错推进事件流来复现该场景，验证绑定已按 threadId 隔离。
 */

import { describe, expect, it } from "vitest";
import {
  createInitialState,
  reduceClientEvent,
  resetReasoningBindings,
  type ClientAction,
  type ClientState,
} from "../src/features/chat/client-reducer.js";

/** 把一批动作应用到指定状态上。 */
function apply(state: ClientState, actions: ClientAction[]): ClientState {
  let next = state;
  for (const action of actions) next = reduceClientEvent(next, action);
  return next;
}

describe("多线程状态隔离", () => {
  it("两个线程同时流式输出时，正文不会串到对方的消息上", () => {
    resetReasoningBindings();

    const threadA = "thread-A";
    const threadB = "thread-B";
    let stateA = createInitialState(threadA);
    let stateB = createInitialState(threadB);

    // A 先开始一条助手消息（此时 A 的 text 绑定为 a1 → a1）。
    stateA = apply(stateA, [{ type: "startAssistant", runId: "run-a", messageId: "a1" }]);

    // B 先用 reasoning 建了占位消息（B 的 id 恰好也叫 a1 的场景最容易串味），
    // 然后 B 的正文用另一个 id 合并进 B 自己的占位消息。
    stateB = apply(stateB, [
      { type: "startReasoning", runId: "run-b", messageId: "r-b" },
      { type: "appendReasoning", messageId: "r-b", delta: "B 的思考" },
    ]);
    stateB = apply(stateB, [{ type: "startAssistant", runId: "run-b", messageId: "a1" }]);

    // 交错：B 先追加正文，再轮到 A 追加正文。
    stateB = apply(stateB, [{ type: "appendAssistant", messageId: "a1", delta: "B 的答复" }]);
    stateA = apply(stateA, [{ type: "appendAssistant", messageId: "a1", delta: "A 的答复" }]);

    // A 的正文必须落在 A 自己的消息上，不能被 B 的绑定带跑。
    expect(stateA.messages).toHaveLength(1);
    expect(stateA.messages[0]?.content).toBe("A 的答复");
    expect(stateA.messages[0]?.reasoning).toBeUndefined();

    // B 的正文与思考都留在 B 自己这边。
    expect(stateB.messages).toHaveLength(1);
    expect(stateB.messages[0]?.content).toBe("B 的答复");
    expect(stateB.messages[0]?.reasoning).toBe("B 的思考");

    // 两个状态各自独立，互不影响。
    expect(stateA.threadId).toBe(threadA);
    expect(stateB.threadId).toBe(threadB);
  });

  it("重置绑定只影响目标线程，不打断仍在运行的另一个线程", () => {
    resetReasoningBindings();
    const threadRunning = "thread-running";
    const threadNew = "thread-new";

    let running = createInitialState(threadRunning);
    // 运行中的线程：reasoning 建占位消息后，正文合并进它。
    running = apply(running, [
      { type: "startReasoning", runId: "run-1", messageId: "reason-1" },
      { type: "startAssistant", runId: "run-1", messageId: "text-1" },
    ]);

    // 另一个线程执行 newThread（会重置它自己的绑定）。
    const fresh = reduceClientEvent(createInitialState(threadNew), {
      type: "newThread",
      threadId: "thread-new-2",
    });
    expect(fresh.messages).toHaveLength(0);

    // 运行中的线程继续流式输出，绑定必须仍然有效。
    running = apply(running, [{ type: "appendAssistant", messageId: "text-1", delta: "继续输出" }]);
    expect(running.messages).toHaveLength(1);
    expect(running.messages[0]?.content).toBe("继续输出");
  });

  it("createInitialState 为每个线程生成互不相同的初始状态对象", () => {
    const a = createInitialState("t-1");
    const b = createInitialState("t-2");
    expect(a).not.toBe(b);
    expect(a.threadId).toBe("t-1");
    expect(b.threadId).toBe("t-2");
    expect(a.run.status).toBe("idle");
    // 两个状态不共享 messages / activities 数组引用。
    expect(a.messages).not.toBe(b.messages);
    expect(a.activities).not.toBe(b.activities);
  });
});
