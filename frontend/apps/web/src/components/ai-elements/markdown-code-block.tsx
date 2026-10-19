/**
 * 对齐 AI SDK Elements 官网规范的 Markdown 代码块组件：
 * https://elements.ai-sdk.dev/components/code-block
 *
 * 核心特性：
 * 1. 深度适配深浅双色主题（Light 纯白高雅卡片 / Dark 纯黑深邃卡片）
 * 2. 具备语言标题栏、一键复制代码按钮及复制状态反馈
 * 3. 智能兼容行内代码（inline code）与多行围栏代码块（fenced code block）
 * 4. 健壮的语言名称别名归一化与优雅降级（支持 py/js/ts/sh/shell/vue 等各种写法）
 */

import { memo, type ComponentProps } from "react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockFilename,
  CodeBlockActions,
  CodeBlockCopyButton,
  normalizeLanguage,
} from "./code-block.js";
import { cn } from "@/lib/utils";

interface MarkdownCodeBlockProps extends ComponentProps<"code"> {
  node?: unknown;
  inline?: boolean;
}

export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  className,
  children,
  inline,
  node,
  ...props
}: MarkdownCodeBlockProps) {
  // 提取纯文本内容
  const rawContent = typeof children === "string"
    ? children
    : Array.isArray(children)
      ? children.map((c) => (typeof c === "string" ? c : "")).join("")
      : String(children ?? "");

  // 判断是否为行内代码：
  // 1. 显式带有 inline 属性
  // 2. 没有包含任何换行且类名中未包含 language- 前缀
  const hasMultipleLines = rawContent.includes("\n");
  const hasLanguageClass = Boolean(className?.includes("language-"));
  const isInline = inline === true || (!hasLanguageClass && !hasMultipleLines);

  // 行内代码渲染：适配黑白双色主题
  if (isInline) {
    return (
      <code
        className={cn(
          "rounded-md border border-zinc-200/90 bg-zinc-100/90 px-1.5 py-0.5 font-mono text-[12.5px] text-zinc-800 dark:border-zinc-800 dark:bg-zinc-800/80 dark:text-zinc-200",
          className
        )}
        data-streamdown="inline-code"
        {...props}
      >
        {children}
      </code>
    );
  }

  // 提取语言名称（如 language-typescript -> typescript）
  const langMatch = className?.match(/language-([a-zA-Z0-9_+#.-]+)/);
  const rawLang = langMatch ? langMatch[1] : "";
  const normalizedLang = normalizeLanguage(rawLang);
  const displayLang = rawLang || normalizedLang || "code";

  // 去除代码结尾多余的换行符
  const cleanCode = rawContent.replace(/\n$/, "");

  return (
    <div className="my-3.5 w-full overflow-hidden" data-streamdown="code-block-wrapper">
      <CodeBlock
        code={cleanCode}
        language={normalizedLang as BundledLanguage}
        className="w-full rounded-xl border border-zinc-200 bg-white shadow-xs dark:border-zinc-800 dark:bg-zinc-950 transition-colors"
      >
        {/* 顶部 Header：语言标题 + 复制按钮 */}
        <CodeBlockHeader className="flex items-center justify-between border-b border-zinc-200/80 bg-zinc-100/80 px-3.5 py-2 text-zinc-600 dark:border-zinc-800/80 dark:bg-zinc-900/90 dark:text-zinc-400 select-none">
          <CodeBlockTitle>
            <CodeBlockFilename className="text-[12px] font-mono lowercase">
              {displayLang}
            </CodeBlockFilename>
          </CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton className="size-7 rounded-md text-zinc-500 hover:bg-zinc-200/80 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white transition-colors cursor-pointer" />
          </CodeBlockActions>
        </CodeBlockHeader>
      </CodeBlock>
    </div>
  );
});

MarkdownCodeBlock.displayName = "MarkdownCodeBlock";
