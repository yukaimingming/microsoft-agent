/**
 * @vitest-environment jsdom
 */
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  highlightCode,
  highlightCodeSync,
  normalizeLanguage,
} from "../src/components/ai-elements/code-block.js";
import { MarkdownCodeBlock } from "../src/components/ai-elements/markdown-code-block.js";

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    });
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("CodeBlock 语法高亮与稳定性测试", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  it("normalizeLanguage 支持常用别名、Shiki 内置冷门语言及未知语言回退", () => {
    expect(normalizeLanguage("py")).toBe("python");
    expect(normalizeLanguage("TS")).toBe("typescript");
    expect(normalizeLanguage("c#")).toBe("csharp");
    expect(normalizeLanguage("C++")).toBe("cpp");
    expect(normalizeLanguage("pwsh")).toBe("powershell");
    expect(normalizeLanguage("yml")).toBe("yaml");
    expect(normalizeLanguage("conf")).toBe("nginx");
    expect(normalizeLanguage("plaintext")).toBe("text");

    // bundledLanguages 中未显式列在别名表中的语言也应保留支持
    expect(normalizeLanguage("vue")).toBe("vue");
    expect(normalizeLanguage("svelte")).toBe("svelte");
    expect(normalizeLanguage("lua")).toBe("lua");
    expect(normalizeLanguage("dart")).toBe("dart");

    // 空值或不存在的语言优雅降级为 text
    expect(normalizeLanguage("")).toBe("text");
    expect(normalizeLanguage(undefined)).toBe("text");
    expect(normalizeLanguage("nonexistent-lang-123")).toBe("text");
  });

  it("长代码仅中间行不同时缓存键不发生首尾碰撞", async () => {
    const prefix = `// ${"a".repeat(120)}\n`;
    const suffix = `\n// ${"z".repeat(120)}`;
    const codeA = `${prefix}const alpha = 1001;${suffix}`;
    const codeB = `${prefix}const beta = "distinct_middle_value";${suffix}`;

    const waitHighlight = (snippet: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Shiki highlight timed out")),
          8000
        );
        const immediate = highlightCode(
          snippet,
          "typescript" as BundledLanguage,
          () => {
            clearTimeout(timer);
            resolve();
          }
        );
        if (immediate) {
          clearTimeout(timer);
          resolve();
        }
      });

    await waitHighlight(codeA);
    await waitHighlight(codeB);

    const resA = highlightCodeSync(codeA, "typescript" as BundledLanguage);
    const resB = highlightCodeSync(codeB, "typescript" as BundledLanguage);

    expect(resA).not.toBeNull();
    expect(resB).not.toBeNull();
    expect(resA).not.toBe(resB);

    const textA = resA!.tokens.map((l) => l.map((t) => t.content).join("")).join("\n");
    const textB = resB!.tokens.map((l) => l.map((t) => t.content).join("")).join("\n");
    expect(textA).toBe(codeA);
    expect(textB).toBe(codeB);
  });

  it("StrictMode 下初次渲染及连续流式增量更新时能立即呈现双主题 Token 颜色，无需切换对话", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const streamChunks = [
      'fn main() {\n    let msg = "hello";',
      'fn main() {\n    let msg = "hello";\n    let count: usize = 42;\n    println!("{} {}", msg, count);\n}',
    ];

    // 使用未在 PRELOAD_LANGUAGES 中预加载的 rust 语言，验证按需异步加载链路
    await act(async () => {
      root!.render(
        createElement(
          StrictMode,
          null,
          createElement(MarkdownCodeBlock, {
            className: "language-rust",
            children: `${streamChunks[0]}\n`,
          })
        )
      );
    });

    // 紧接着推送最终块（模拟 140ms 流式追加）
    await act(async () => {
      root!.render(
        createElement(
          StrictMode,
          null,
          createElement(MarkdownCodeBlock, {
            className: "language-rust",
            children: `${streamChunks[1]}\n`,
          })
        )
      );
    });

    // 不卸载/不切换会话，等待异步 Shiki 高亮直接刷出着色 Token
    await waitForCondition(() => {
      const spans = Array.from(
        container?.querySelectorAll("pre code span span") ?? []
      ) as HTMLElement[];
      const colors = new Set(
        spans
          .map((s) => s.style.color)
          .filter((c) => Boolean(c) && c !== "inherit")
      );
      return colors.size >= 3;
    });

    const tokenSpans = Array.from(
      container.querySelectorAll("pre code span span")
    ) as HTMLElement[];
    const lightColors = new Set(
      tokenSpans.map((s) => s.style.color).filter((c) => Boolean(c) && c !== "inherit")
    );
    const hasDarkVarAndClass = tokenSpans.some(
      (s) =>
        Boolean(s.style.getPropertyValue("--shiki-dark")) &&
        s.className.includes("dark:!text-[var(--shiki-dark)]")
    );

    expect(lightColors.size).toBeGreaterThanOrEqual(3);
    expect(hasDarkVarAndClass).toBe(true);
  });

  it("纯文本与行内代码渲染正确，且已预热语言在首帧同步着色", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // 先触发 typescript 预加载完成
    await new Promise<void>((resolve) => {
      const hit = highlightCode("const x = 1;", "typescript" as BundledLanguage, () =>
        resolve()
      );
      if (hit) resolve();
    });

    await act(async () => {
      root!.render(
        createElement(
          "div",
          null,
          createElement(MarkdownCodeBlock, {
            inline: true,
            children: "inlineVar",
          }),
          createElement(CodeBlock, {
            code: "export const ready: boolean = true;",
            language: "typescript" as BundledLanguage,
          }),
          createElement(CodeBlock, {
            code: "plain text line 1\nplain text line 2",
            language: "text" as BundledLanguage,
          })
        )
      );
    });

    const inlineCode = container.querySelector('[data-streamdown="inline-code"]');
    expect(inlineCode?.textContent).toBe("inlineVar");

    // 同步命中的 TypeScript 代码块首帧即应包含着色的 token（无须等待）
    const tsBlock = container.querySelector('[data-language="typescript"]');
    const tsSpans = Array.from(
      tsBlock?.querySelectorAll("pre code span span") ?? []
    ) as HTMLElement[];
    const tsColors = new Set(
      tsSpans.map((s) => s.style.color).filter((c) => Boolean(c) && c !== "inherit")
    );
    expect(tsColors.size).toBeGreaterThanOrEqual(2);

    // text 语言回退正确且文本完整
    const textBlock = container.querySelector('[data-language="text"]');
    expect(textBlock?.textContent).toContain("plain text line 1");
    expect(textBlock?.textContent).toContain("plain text line 2");
  });
});
