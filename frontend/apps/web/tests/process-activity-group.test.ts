/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatElapsedDuration,
  hasActiveProcess,
  getToolActionLabel,
  ProcessActivityGroup,
} from "../src/features/chat/process-activity-group.js";

describe("过程摘要格式", () => {
  it("显示具体工具动作名称", () => {
    expect(getToolActionLabel("execute")).toBe("执行了命令");
    expect(getToolActionLabel("read_file")).toBe("分析了文件");
    expect(getToolActionLabel("edit_file")).toBe("编辑了文件");
    expect(getToolActionLabel("write_file")).toBe("写入了文件");
  });

  it("用分钟和秒显示耗时", () => {
    expect(formatElapsedDuration(0)).toBe("0分0秒");
    expect(formatElapsedDuration(125_999)).toBe("2分5秒");
  });
});

describe("ProcessActivityGroup 状态展示", () => {
  const reasoningItem = {
    id: "reasoning:answer",
    kind: "assistant" as const,
    section: "reasoning" as const,
    label: "正在思考",
    content: "模型返回的原始推理内容。",
    startedAt: Date.now(),
    streaming: false,
  };

  it("运行开始但尚无推理或工具事件时立即显示时间线", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [],
      isActive: true,
      startedAt: Date.now() - 2_000,
      runCompleted: false,
    }));

    expect(html).toContain("正在分析");
    expect(html).toContain('aria-expanded="true"');
  });

  it("正文流式结束后立即汇总为完成，同时顶部时间线自动收缩", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [reasoningItem],
      finalAnswerComplete: true,
      finalAnswerStreaming: false,
      runCompleted: false,
      durationMs: 83_000,
    }));

    expect(html).toContain("已完成分析，用时 1分23秒");
    expect(html).not.toContain("正在分析");
    expect(html).not.toContain("正在思考");
    expect(html).toContain('aria-expanded="false"');
  });

  it("工具和思考输出完后停止计时，正式输出正文时时间线自动收缩", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [reasoningItem],
      finalAnswerComplete: false,
      finalAnswerStreaming: true,
      runCompleted: false,
      durationMs: 83_000,
    }));

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("已完成分析，用时 1分23秒");
    expect(html).not.toContain("正在分析");
  });

  it("思考还在输出时计时继续，思考明细本身保持折叠", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [{ ...reasoningItem, streaming: true }],
      finalAnswerComplete: false,
      finalAnswerStreaming: false,
      runCompleted: false,
      durationMs: 0,
    }));

    expect(html).toContain("正在分析，用时 0分0秒");
    expect(html).toContain("bg-clip-text");
    expect(html).toContain(">思考<");
    expect(html).not.toContain("正在思考");
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('open=""');
    expect(html).toContain("模型返回的原始推理内容。");
  });

  it("首个思考出现时继承已有的 runStartedAt 计时，绝不重置为0秒", () => {
    const runStart = Date.now() - 5_000;
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [{ ...reasoningItem, streaming: true, startedAt: Date.now() }],
      startedAt: runStart,
      finalAnswerComplete: false,
      finalAnswerStreaming: false,
      runCompleted: false,
    }));

    expect(html).toContain("正在分析，用时 0分5秒");
  });

  it("工具、子 Agent 或过程消息仍活动时阻止最终正文抢先出现", () => {
    const activeSubagent = {
      id: "subagent:1",
      kind: "activity" as const,
      activity: { id: "subagent:1", kind: "subagent" as const, status: "pending" as const, title: "子任务", startedAt: Date.now() },
    };
    const activeTool = {
      id: "tool:1",
      kind: "activity" as const,
      activity: { id: "tool:1", kind: "tool" as const, status: "running" as const, title: "execute", startedAt: Date.now() },
    };

    expect(hasActiveProcess([activeSubagent])).toBe(true);
    expect(hasActiveProcess([activeTool])).toBe(true);
    expect(hasActiveProcess([{ ...reasoningItem, kind: "assistant" as const, section: "reasoning" as const, streaming: true }])).toBe(true);
    expect(hasActiveProcess([])).toBe(false);
  });

  it("思考和工具详情默认都折叠，思考标题保留流光", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [
        { ...reasoningItem, streaming: true, content: "第一段推理" },
        {
          id: "tool:read",
          kind: "activity" as const,
          activity: {
            id: "tool:read",
            kind: "tool" as const,
            status: "running" as const,
            title: "read_file",
            startedAt: Date.now(),
            detail: { toolName: "read_file", input: { path: "README.md" } },
          },
        },
      ],
      runCompleted: false,
    }));

    expect(html).toContain("README.md");
    expect(html).toContain("正在分析文件");
    expect(html).toContain(">思考<");
    expect(html).toContain("bg-clip-text");
    expect(html).toContain("输入参数");
    expect(html).not.toContain('open=""');
  });

  it("只有过程说明时保持分析总线展开，工具详情仍然默认折叠", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [
        reasoningItem,
        {
          id: "message:mid",
          kind: "assistant" as const,
          label: "正在整理过程",
          content: "目录里有三个文件，我再读一下说明。",
          startedAt: Date.now(),
          streaming: true,
        },
      ],
      finalAnswerComplete: false,
      finalAnswerStreaming: false,
      runCompleted: false,
    }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("正在分析");
    expect(html).toContain("目录里有三个文件，我再读一下说明。");
  });

  it("浏览器渲染后思考增量会进入可见文本", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(ProcessActivityGroup, {
        items: [{ ...reasoningItem, streaming: true, content: "第一段推理" }],
        runCompleted: false,
      }));
    });
    expect(host.textContent).toContain("第一段推理");
    await act(async () => {
      root.render(createElement(ProcessActivityGroup, {
        items: [{ ...reasoningItem, streaming: true, content: "第一段推理，第二段也到了" }],
        runCompleted: false,
      }));
    });
    expect(host.textContent).toContain("第一段推理，第二段也到了");
    act(() => root.unmount());
    host.remove();
  });
});
