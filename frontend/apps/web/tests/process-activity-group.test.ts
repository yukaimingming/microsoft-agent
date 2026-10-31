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
  plainProcessText,
  formatReasoningPreview,
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
    expect(html).toContain("shimmer");
    expect(html).toContain("正在思考");
    expect(html).toContain("animated-gradient-text");
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
    expect(html).toContain("正在思考");
    expect(html).toContain("animated-gradient-text");
    expect(html).toContain("shimmer");
    expect(html).toContain("输入参数");
    expect(html).not.toContain('open=""');
  });

  it("闪光效果仅在正在执行的思考或工具项上显示，已完成的内容不再显示闪光", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [
        { ...reasoningItem, id: "reasoning:done", streaming: false, content: "已完成的第一段思考" },
        {
          id: "tool:done",
          kind: "activity" as const,
          activity: {
            id: "tool:done",
            kind: "tool" as const,
            status: "completed" as const,
            title: "file_access_write",
            startedAt: Date.now() - 2000,
            detail: { toolName: "file_access_write", input: { fileName: "old.txt" } },
          },
        },
        {
          id: "tool:running",
          kind: "activity" as const,
          activity: {
            id: "tool:running",
            kind: "tool" as const,
            status: "running" as const,
            title: "file_access_replace",
            startedAt: Date.now(),
            detail: { toolName: "file_access_replace", input: { fileName: "demo-notes.txt" } },
          },
        },
      ],
      isActive: true,
      runCompleted: false,
      finalAnswerStreaming: false,
      finalAnswerComplete: false,
    }));

    // 已完成的工具（写入了文件 old.txt）和已完成的思考不带 shimmer
    expect(html).toContain("<span>写入了文件</span>");
    expect(html).not.toMatch(/class="[^"]*shimmer[^"]*"[^>]*>写入了文件</);
    expect(html).not.toMatch(/class="[^"]*shimmer[^"]*"[^>]*>old\.txt</);
    expect(html).not.toMatch(/class="[^"]*shimmer[^"]*"[^>]*>已完成的第一段思考</);

    // 正在执行的工具动作文案与参数合并为同一整行微光闪烁
    expect(html).toMatch(/class="[^"]*shimmer[^"]*"[^>]*>正在编辑文件 demo-notes\.txt</);
  });

  it("工具仍在执行时即使上一条过程摘要已流式完毕，整组保持正在分析且工具行保持闪光", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [
        {
          id: "message:note",
          kind: "assistant" as const,
          label: "过程摘要",
          content: "已完成的中间说明。",
          startedAt: Date.now(),
          streaming: false,
        },
        {
          id: "tool:running",
          kind: "activity" as const,
          activity: {
            id: "tool:running",
            kind: "tool" as const,
            status: "running" as const,
            title: "execute",
            startedAt: Date.now(),
            detail: { toolName: "execute", input: { command: "ping localhost" } },
          },
        },
      ],
      isActive: true,
      finalAnswerComplete: true,
      finalAnswerStreaming: false,
      runCompleted: false,
    }));

    expect(html).toContain("正在分析");
    expect(html).not.toContain("已完成分析");
    expect(html).toMatch(/class="[^"]*shimmer[^"]*"[^>]*>正在执行命令/);
    expect(html).not.toMatch(/class="[^"]*shimmer[^"]*"[^>]*>执行了命令</);
  });

  it("整轮运行结束后运行中的活动收敛为静态，不再闪光", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [
        {
          id: "tool:running",
          kind: "activity" as const,
          activity: {
            id: "tool:running",
            kind: "tool" as const,
            status: "running" as const,
            title: "execute",
            startedAt: Date.now(),
            detail: { toolName: "execute", input: { command: "ping localhost" } },
          },
        },
      ],
      isActive: true,
      finalAnswerComplete: false,
      finalAnswerStreaming: false,
      runCompleted: true,
    }));

    expect(html).toContain("已完成分析");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("正在执行命令");
    expect(html).not.toMatch(/class="[^"]*shimmer[^"]*"/);
  });

  it("最新一条已完成工具在下一步出现前保持闪光，出现新条目后恢复静态", () => {
    const completedTool = {
      id: "tool:done",
      kind: "activity" as const,
      activity: {
        id: "tool:done",
        kind: "tool" as const,
        status: "completed" as const,
        title: "execute",
        startedAt: Date.now(),
        detail: { toolName: "execute", input: { command: "ping localhost" } },
      },
    };
    const items = [
      { ...reasoningItem, id: "reasoning:done", streaming: false, content: "已完成的第一段思考" },
      completedTool,
    ];

    // 已完成工具是最新条目且整组未完成：保持闪光等待下一步
    const liveHtml = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items,
      isActive: true,
      runCompleted: false,
      finalAnswerStreaming: false,
      finalAnswerComplete: false,
    }));
    expect(liveHtml).toMatch(/class="[^"]*shimmer[^"]*"[^>]*>执行了命令 ping localhost</);
    expect(liveHtml).toContain("正在分析");

    // 新条目（第二个工具）出现后：前一条恢复静态，只有最新条目闪光
    const supersededHtml = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [
        ...items,
        {
          id: "tool:next",
          kind: "activity" as const,
          activity: {
            id: "tool:next",
            kind: "tool" as const,
            status: "running" as const,
            title: "read_file",
            startedAt: Date.now(),
            detail: { toolName: "read_file", input: { path: "README.md" } },
          },
        },
      ],
      isActive: true,
      runCompleted: false,
      finalAnswerStreaming: false,
      finalAnswerComplete: false,
    }));
    expect(supersededHtml).not.toMatch(/class="[^"]*shimmer[^"]*"[^>]*>执行了命令 ping localhost</);
    expect(supersededHtml).toMatch(/class="[^"]*shimmer[^"]*"[^>]*>正在分析文件 README\.md</);
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

  it("思考内容多行拼接解析完整保留所有思考阶段", () => {
    const multilineContent = `
# 正在规划步骤
- 检索工作区文件结构
- 分析并定位关键渲染逻辑
正在修改对应代码...
`;
    const preview = formatReasoningPreview(multilineContent);
    expect(preview).toBe("正在规划步骤 · 检索工作区文件结构 · 分析并定位关键渲染逻辑 · 正在修改对应代码...");
  });

  it("思考流式进行中与输出结束时的预览渲染模式切换", () => {
    const multilineContent = "正在分析需求\n检索相关代码\n执行验证";

    // 流式中：ZCode 式折叠 + 末行滚动预览容器（overflow-hidden 且尾行贴右）
    const streamingHtml = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [{ ...reasoningItem, streaming: true, content: multilineContent }],
      runCompleted: false,
    }));
    expect(streamingHtml).toContain("正在思考");
    expect(streamingHtml).toContain("overflow-hidden");
    // 预览只取最后一个非空行，不再拼接全部行
    expect(streamingHtml).toContain("执行验证");
    expect(streamingHtml).not.toContain("正在分析需求 · 检索相关代码 · 执行验证");

    // 输出结束：定格为「思考 · 持续了 N 秒」，预览彻底消失
    const completedHtml = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [
        { ...reasoningItem, streaming: false, reasoningDuration: 5, content: multilineContent },
        { id: "tool:after", kind: "activity" as const, activity: { id: "tool:after", kind: "tool" as const, status: "completed" as const, title: "ls", startedAt: 200 } },
      ],
      isActive: true,
      runCompleted: false,
    }));
    expect(completedHtml).toContain("思考");
    expect(completedHtml).toContain("持续了 5 秒");
    expect(completedHtml).not.toContain("正在思考");
    expect(completedHtml).not.toContain("overflow-hidden");
    expect(completedHtml).not.toContain("执行验证");
  });

  it("过程说明 Markdown 转普通文本（去除 ## 标题、代码围栏、加粗与行内代码）", () => {
    const rawMarkdown = "### 当前文件内容如下：\n\n```\n版本 1.0.3\n```\n\n### 现在修改文件（修改其中两行内容）：\n**注意**：只改 `demo-notes.txt`。";
    const text = plainProcessText(rawMarkdown);
    expect(text).not.toContain("###");
    expect(text).not.toContain("```");
    expect(text).not.toContain("**");
    expect(text).not.toContain("`");
    expect(text).toContain("当前文件内容如下：");
    expect(text).toContain("现在修改文件（修改其中两行内容）：");
    expect(text).toContain("版本 1.0.3");
    expect(text).toContain("注意：只改 demo-notes.txt。");
  });
});
