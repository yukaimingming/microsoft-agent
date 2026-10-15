import { describe, expect, it } from "vitest";
import { appendTimelineOrder, buildTurnProcessTimeline } from "../src/features/chat/chat-messages.js";
import type { ProcessTimelineItem } from "../src/features/chat/process-activity-group.js";

describe("助手过程时间线顺序", () => {
  it("同一时间戳下按推理、模型中间文本、工具活动排序，最终答复留在正文", () => {
    const timeline = buildTurnProcessTimeline(
      [
        {
          id: "node-one",
          role: "assistant",
          content: "我先检查目录，再汇报结果。",
          streaming: false,
          runId: "run-one",
          reasoning: "先确认工作区内容。",
          reasoningStreaming: false,
          reasoningStartedAt: 100,
          createdAt: 100,
        },
        {
          id: "final",
          role: "assistant",
          content: "工作区包含项目文件。",
          streaming: false,
          runId: "run-one",
          createdAt: 300,
        },
      ],
      [
        {
          id: "tool-one",
          kind: "tool",
          status: "completed",
          title: "查看目录",
          runId: "run-one",
          startedAt: 100,
        },
      ],
    );

    const items = timeline.byFinalMessage.get("node-one") ?? [];
    expect(items.map((item) => item.kind === "assistant" ? item.content : item.activity.title)).toEqual([
      "先确认工作区内容。",
      "我先检查目录，再汇报结果。",
      "查看目录",
    ]);
    expect(timeline.ownedMessageIds.has("node-one")).toBe(true);
    expect(timeline.ownedMessageIds.has("final")).toBe(false);
  });

  it("中间说明按正文开始时间排在已经发生的工具下面", () => {
    const timeline = buildTurnProcessTimeline(
      [
        {
          id: "note",
          role: "assistant",
          content: "目录里有三个文件。",
          streaming: false,
          runId: "run-one",
          createdAt: 100,
          contentStartedAt: 450,
        },
        {
          id: "final",
          role: "assistant",
          content: "检查完成。",
          streaming: false,
          runId: "run-one",
          createdAt: 700,
        },
      ],
      [
        { id: "tool-one", kind: "tool", status: "completed", title: "ls", runId: "run-one", startedAt: 300 },
      ],
    );
    const items = timeline.byFinalMessage.get("note") ?? [];
    expect(items.map((item) => item.kind === "assistant" ? item.content : item.activity.id)).toEqual([
      "tool-one",
      "目录里有三个文件。",
    ]);
  });

  it("后到的工具接在已显示过程下面，不插进中间", () => {
    const order = new Map<string, number>();
    const firstTool: ProcessTimelineItem = {
      id: "tool-one",
      kind: "activity",
      activity: { id: "tool-one", kind: "tool", status: "completed", title: "ls", startedAt: 300 },
    };
    const note: ProcessTimelineItem = {
      id: "message:note",
      kind: "assistant",
      label: "已完成分析",
      content: "先看到目录。",
      startedAt: 400,
    };
    const first = appendTimelineOrder(order, [note, firstTool]);
    const lateTool: ProcessTimelineItem = {
      id: "tool-late",
      kind: "activity",
      activity: { id: "tool-late", kind: "tool", status: "running", title: "read_file", startedAt: 50 },
    };
    const second = appendTimelineOrder(order, [note, firstTool, lateTool]);
    expect(first.map((item) => item.id)).toEqual(["tool-one", "message:note"]);
    expect(second.map((item) => item.id)).toEqual(["tool-one", "message:note", "tool-late"]);
  });
});
