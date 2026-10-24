import { useEffect, useMemo, useRef, useState } from "react";
import { MessageResponse } from "../../components/ai-elements/message.js";
import { cn } from "../../lib/utils.js";
import {
  BrainCircuitIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileSearchIcon,
  GlobeIcon,
  ListTodoIcon,
  PencilLineIcon,
  TerminalIcon,
  TriangleAlertIcon,
  PanelRightOpenIcon,
} from "lucide-react";
import type { Activity } from "@deepagent/shared";
import { Shimmer } from "../../components/ai-elements/shimmer.js";
import { openInWebPreview } from "../review/web-preview-events.js";

export type ProcessTimelineItem =
  | {
      id: string;
      kind: "assistant";
      label: string;
      content: string;
      startedAt: number;
      streaming?: boolean;
      section?: "reasoning";
      reasoningDuration?: number;
    }
  | {
      id: string;
      kind: "activity";
      activity: Activity;
    };

export function hasActiveProcess(items: ProcessTimelineItem[], toolActivities: Activity[] = []): boolean {
  const isActive = (activity: Activity) =>
    activity.status === "running" || activity.status === "pending" || activity.status === "waiting_approval";
  return items.some((item) => item.kind === "assistant" ? item.streaming : isActive(item.activity))
    || toolActivities.some(isActive);
}

interface ProcessActivityGroupProps {
  items: ProcessTimelineItem[];
  isActive?: boolean;
  startedAt?: number;
  finalAnswerComplete?: boolean;
  finalAnswerStreaming?: boolean;
  runCompleted?: boolean;
  durationMs?: number;
}

const TOOL_ACTIONS: Record<string, string> = {
  execute: "执行了命令",
  run_shell: "执行了终端命令",
  ls: "查看了目录",
  file_access_ls: "查看了目录",
  read_file: "分析了文件",
  file_access_read: "分析了文件",
  file_access_read_lines: "读取了文件片段",
  write_file: "写入了文件",
  file_access_write: "写入了文件",
  edit_file: "编辑了文件",
  file_access_replace: "编辑了文件",
  file_access_replace_lines: "替换了文件行",
  write_todos: "更新了计划",
  todos_add: "规划了待办任务",
  todos_complete: "完成了待办任务",
  todos_remove: "移除了待办任务",
  todos_list: "查看了待办任务",
  todos_get_remaining: "检查了剩余待办",
  todos_get_all: "查看了待办清单",
  task: "派发了子任务",
  glob: "查找了文件",
  grep: "搜索了文件",
  file_access_grep: "搜索了文件内容",
  delete_file: "删除了文件",
  file_access_delete: "删除了文件",
  mode_get: "查看了工作模式",
  mode_set: "切换了工作模式",
  file_memory_Read: "读取了长期记忆",
  file_memory_Write: "写入了长期记忆",
  file_memory_Edit: "更新了长期记忆",
  file_memory_Delete: "清理了长期记忆",
  file_memory_ListFiles: "查看了记忆库",
  file_memory_Search: "检索了长期记忆",
  file_memory_read: "读取了长期记忆",
  file_memory_write: "写入了长期记忆",
  file_memory_edit: "更新了长期记忆",
  file_memory_delete: "清理了长期记忆",
  file_memory_ls: "查看了记忆库",
  file_memory_search: "检索了长期记忆",
  read_pdf: "解析了 PDF 文档",
  read_excel: "解析了 Excel 表格",
  reflection_judge: "完成了反思评估",
  web_search: "搜索了网络",
  search_web: "搜索了网络",
  web_search_exa: "搜索了网络",
  web_fetch_exa: "抓取了网页",
  web_fetch: "抓取了网页",
};

const ACTIVE_TOOL_ACTIONS: Record<string, string> = {
  execute: "正在执行命令",
  run_shell: "正在执行终端命令",
  ls: "正在查看目录",
  file_access_ls: "正在查看目录",
  read_file: "正在分析文件",
  file_access_read: "正在分析文件",
  file_access_read_lines: "正在读取文件片段",
  write_file: "正在写入文件",
  file_access_write: "正在写入文件",
  edit_file: "正在编辑文件",
  file_access_replace: "正在编辑文件",
  file_access_replace_lines: "正在替换文件行",
  write_todos: "正在更新计划",
  todos_add: "正在规划待办任务",
  todos_complete: "正在完成待办任务",
  todos_remove: "正在移除待办任务",
  todos_list: "正在查看待办任务",
  todos_get_remaining: "正在检查剩余待办",
  todos_get_all: "正在查看待办清单",
  task: "正在派发子任务",
  glob: "正在查找文件",
  grep: "正在搜索文件",
  file_access_grep: "正在搜索文件内容",
  delete_file: "正在删除文件",
  file_access_delete: "正在删除文件",
  mode_get: "正在查看工作模式",
  mode_set: "正在切换工作模式",
  file_memory_Read: "正在读取长期记忆",
  file_memory_Write: "正在写入长期记忆",
  file_memory_Edit: "正在更新长期记忆",
  file_memory_Delete: "正在清理长期记忆",
  file_memory_ListFiles: "正在查看记忆库",
  file_memory_Search: "正在检索长期记忆",
  file_memory_read: "正在读取长期记忆",
  file_memory_write: "正在写入长期记忆",
  file_memory_edit: "正在更新长期记忆",
  file_memory_delete: "正在清理长期记忆",
  file_memory_ls: "正在查看记忆库",
  file_memory_search: "正在检索长期记忆",
  read_pdf: "正在解析 PDF 文档",
  read_excel: "正在解析 Excel 表格",
  reflection_judge: "正在进行反思评估",
  web_search: "正在搜索网络",
  search_web: "正在搜索网络",
  web_search_exa: "正在搜索网络",
  web_fetch_exa: "正在抓取网页",
  web_fetch: "正在抓取网页",
};

export function formatElapsedDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`;
}

export function getToolActionLabel(toolName: string): string {
  return TOOL_ACTIONS[toolName] ?? `调用了 ${toolName}`;
}

function toolName(activity: Activity): string {
  const detail = activity.detail as { toolName?: unknown } | undefined;
  if (typeof detail?.toolName === "string") return detail.toolName;
  return activity.title.split(" · ").at(-1) ?? activity.title;
}

function toolInputSummary(activity: Activity): string {
  const detail = activity.detail as { input?: unknown; path?: unknown } | undefined;
  if (typeof detail?.path === "string" && detail.path.trim()) return `文件：${detail.path.trim()}`;
  if (!detail?.input || typeof detail.input !== "object") return "";
  const input = detail.input as Record<string, unknown>;
  const get = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ");
    }
    return "";
  };
  const path = get("fileName", "file_path", "filePath", "path", "dir_path", "directory");
  const command = get("command", "cmd");
  const pattern = get("pattern", "regex", "searchPattern");
  const query = get("query", "glob", "q");
  const url = get("url", "urls");
  const mode = get("mode");
  const name = toolName(activity);
  const parts = (name === "execute" || name === "run_shell")
    ? [command]
    : (name === "grep" || name === "file_access_grep")
      ? [pattern, path]
      : name === "glob"
        ? [query, path]
        : name === "mode_set"
          ? [mode]
          : (name.includes("search") || name === "web_search" || name === "web_search_exa")
            ? [query || path]
            : (name.includes("fetch") || name === "web_fetch" || name === "web_fetch_exa")
              ? [url || path]
              : [path];
  const summary = parts.filter(Boolean).join(" · ");
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
}

function stringifyDetail(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function detailSections(activity: Activity): Array<{ label: string; value: string }> {
  const detail = activity.detail as { input?: unknown; output?: unknown; args?: unknown } | undefined;
  const input = detail?.input ?? detail?.args;
  const sections: Array<{ label: string; value: string }> = [];
  if (input !== undefined) sections.push({ label: "输入参数", value: stringifyDetail(input) });
  if (detail?.output !== undefined) sections.push({ label: "执行结果", value: stringifyDetail(detail.output) });
  if (activity.error) sections.push({ label: "错误信息", value: activity.error });
  return sections;
}

/**
 * 过程说明统一按普通文本展示：
 * 模型在调用工具前常把过程说明写成「### 当前文件内容如下」这类 Markdown，
 * 这里去掉标题井号、代码围栏、引用符号和加粗/行内代码标记，
 * 既避免被误认为最终总结的 Markdown，也让时间线内的过程文本更干净。
 */
export function plainProcessText(content: string): string {
  return content
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}(?:```|~~~)[^\n]*$/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]{0,3}[-*+][ \t]+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export function formatReasoningPreview(content: string): string {
  const cleaned = plainProcessText(content);
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.join(" · ");
}

export const reasoningPreview = formatReasoningPreview;

function isLiveActivity(activity: Activity): boolean {
  return activity.status === "running" || activity.status === "pending" || activity.status === "waiting_approval";
}

function ActionGlyph({ name, className }: { name: string; className?: string }) {
  if (name === "web_search" || name === "search_web" || name === "web_search_exa" || name === "web_fetch" || name === "web_fetch_exa" || name.includes("search_web") || name.includes("web_")) {
    return <GlobeIcon className={className} />;
  }
  if (name === "execute" || name === "run_shell") return <TerminalIcon className={className} />;
  if (name === "write_todos" || name.startsWith("todos_") || name === "write_file" || name === "edit_file" || name === "file_access_write" || name === "file_access_replace" || name === "file_access_replace_lines" || name === "file_memory_Write" || name === "file_memory_Edit" || name === "file_memory_write" || name === "file_memory_edit") {
    return <PencilLineIcon className={className} />;
  }
  if (name === "read_file" || name === "ls" || name === "grep" || name === "glob" || name === "file_access_read" || name === "file_access_read_lines" || name === "file_access_ls" || name === "file_access_grep" || name === "read_pdf" || name === "read_excel" || name === "file_memory_Read" || name === "file_memory_Search" || name === "file_memory_ListFiles" || name === "file_memory_read" || name === "file_memory_search" || name === "file_memory_ls") {
    return <FileSearchIcon className={className} />;
  }
  if (name === "task" || name === "reflection_judge" || name.startsWith("background_agents_")) return <BrainCircuitIcon className={className} />;
  if (name === "delete_file" || name === "file_access_delete" || name === "file_memory_Delete" || name === "file_memory_delete") return <TriangleAlertIcon className={className} />;
  return <ListTodoIcon className={className} />;
}

export interface ExtractedSource {
  title: string;
  url: string;
  snippet?: string;
}

function extractToolSources(activity: Activity): ExtractedSource[] {
  const name = toolName(activity);
  // 仅从联网搜索或网页抓取工具提取外部来源引用，防止读取本地代码文件时把文件中的 127.0.0.1 等地址误判为网页引用
  if (
    !name.includes("web_") &&
    !name.includes("search_web") &&
    !name.includes("fetch")
  ) {
    return [];
  }
  const detail = activity.detail as { output?: unknown; input?: unknown } | undefined;
  const sources: ExtractedSource[] = [];
  const seenUrls = new Set<string>();

  const addSource = (url: string, rawTitle?: string) => {
    if (!url || typeof url !== "string") return;
    const cleanUrl = url.trim().replace(/[)\],;]+$/, "");
    if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) return;
    if (seenUrls.has(cleanUrl)) return;
    seenUrls.add(cleanUrl);

    let host = cleanUrl;
    try {
      host = new URL(cleanUrl).hostname.replace(/^www\./, "");
      if (host === "127.0.0.1" || host === "localhost") return;
    } catch {
      // 保持原样
    }
    sources.push({
      title: (rawTitle && rawTitle.trim()) ? rawTitle.trim() : host,
      url: cleanUrl,
    });
  };

  // 1. 尝试从结构化对象提取（如 Exa results / sources / items）
  const parseObject = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) parseObject(item);
      return;
    }
    const record = obj as Record<string, unknown>;
    // 直接有 url 属性
    if (typeof record.url === "string") {
      addSource(record.url, typeof record.title === "string" ? record.title : undefined);
    }
    if (Array.isArray(record.results)) {
      for (const r of record.results) parseObject(r);
    }
    if (Array.isArray(record.sources)) {
      for (const s of record.sources) parseObject(s);
    }
  };

  if (detail?.output) {
    if (typeof detail.output === "object") {
      parseObject(detail.output);
    } else if (typeof detail.output === "string") {
      try {
        const parsed = JSON.parse(detail.output);
        parseObject(parsed);
      } catch {
        // 纯文本正则匹配 URLs
        const urlMatches = detail.output.match(/https?:\/\/[^\s"'<>]+/g);
        if (urlMatches) {
          for (const u of urlMatches) addSource(u);
        }
      }
    }
  }

  // 2. 如果是从 input 抓取网页（web_fetch_exa 的 url/urls 参数）
  if (sources.length === 0 && detail?.input && typeof detail.input === "object") {
    const inputObj = detail.input as Record<string, unknown>;
    if (typeof inputObj.url === "string") addSource(inputObj.url);
    if (Array.isArray(inputObj.urls)) {
      for (const u of inputObj.urls) {
        if (typeof u === "string") addSource(u);
      }
    }
  }

  return sources.slice(0, 6);
}

function StreamingText({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <MessageResponse mode="static" isAnimating={Boolean(streaming)}>
      {content}
    </MessageResponse>
  );
}

export function ReasoningPreview({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  const preview = useMemo(() => formatReasoningPreview(content), [content]);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollPosRef = useRef(0);

  useEffect(() => {
    if (!streaming) {
      scrollPosRef.current = 0;
      if (containerRef.current) {
        containerRef.current.scrollLeft = 0;
      }
      return;
    }

    let animId: number;
    let lastTime = performance.now();
    const speed = 36; // 36px/s 为清晰易读的滚动速度

    const step = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      const el = containerRef.current;
      if (el) {
        const maxScroll = el.scrollWidth - el.clientWidth;
        if (maxScroll > 1) {
          scrollPosRef.current += speed * dt;
          // 滚至尾部留有微小间隔后平滑循环
          if (scrollPosRef.current > maxScroll + 48) {
            scrollPosRef.current = 0;
          }
          el.scrollLeft = scrollPosRef.current;
        } else {
          scrollPosRef.current = 0;
          el.scrollLeft = 0;
        }
      }

      animId = requestAnimationFrame(step);
    };

    animId = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(animId);
      if (containerRef.current) {
        containerRef.current.scrollLeft = 0;
      }
    };
  }, [streaming]);

  if (!preview) return null;

  // 输出完毕或非流式状态：立即结束滚动，恢复为平静的单行截断文本
  if (!streaming) {
    return (
      <span
        className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-muted)]"
        title={preview}
      >
        {preview}
      </span>
    );
  }

  // 流式输出中：从后往前平滑滚动显示，两侧添加渐隐遮罩
  return (
    <div
      ref={containerRef}
      className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[12px] text-[var(--color-text-muted)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{
        maskImage:
          "linear-gradient(to right, transparent 0, black 8px, black calc(100% - 12px), transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to right, transparent 0, black 8px, black calc(100% - 12px), transparent 100%)",
      }}
      title={preview}
    >
      <span className="inline-block select-none shimmer shimmer-color-blue-500/60 font-medium">
        {preview}
      </span>
    </div>
  );
}

function ReasoningActivity({
  item,
  isGroupComplete = false,
}: {
  item: Extract<ProcessTimelineItem, { kind: "assistant" }>;
  isGroupComplete?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shimmerActive = Boolean(!isGroupComplete && item.streaming);

  return (
    <details
      className="process-activity-enter group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex w-full cursor-pointer list-none items-center gap-2 text-[13px] text-[var(--color-text-secondary)] [&::-webkit-details-marker]:hidden">
        <BrainCircuitIcon className="size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
        {shimmerActive ? (
          <span className="shimmer shimmer-color-blue-500/60 shrink-0 font-medium inline-block">思考</span>
        ) : (
          <span className="shrink-0">思考</span>
        )}
        {!open && (
          <ReasoningPreview
            content={item.content}
            streaming={Boolean(!isGroupComplete && item.streaming)}
          />
        )}
        <ChevronDownIcon className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="ml-[26px] mt-1.5 break-words border-l border-[var(--color-border-subtle)] pl-3 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
        <StreamingText content={item.content} streaming={item.streaming} />
      </div>
    </details>
  );
}

function ToolActivityRow({
  itemId,
  activity,
  style,
  isGroupComplete = false,
}: {
  itemId: string;
  activity: Activity;
  style: { animationDelay: string };
  isGroupComplete?: boolean;
}) {
  const shimmerActive = !isGroupComplete && isLiveActivity(activity);
  const [open, setOpen] = useState(false);
  const name = toolName(activity);
  const summaryText = toolInputSummary(activity);
  const sections = detailSections(activity);
  const sources = extractToolSources(activity);
  const detail = activity.detail as { truncated?: unknown } | undefined;
  const tone = activity.status === "failed"
    ? "text-[var(--color-state-error)]"
    : (!isGroupComplete && activity.status === "waiting_approval")
      ? "text-[var(--color-state-warn)]"
      : "text-[var(--color-text-secondary)]";
  const labelText = activityLabel(activity, isGroupComplete);
  return (
    <div key={itemId} className={`process-activity-enter flex min-w-0 items-start gap-2 text-[13px] ${tone}`} style={style}>
      <ActionGlyph name={name} className="mt-0.5 size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
      <div className="min-w-0 flex-1">
        <details className="group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 [&::-webkit-details-marker]:hidden">
            {shimmerActive ? (
              // 运行中的工具行：动作文案与路径/命令参数合并成一整行微光，避免只有开头几个字在闪。
              <span className="shimmer shimmer-color-blue-500/60 font-medium inline-block">
                {summaryText ? `${labelText} ${summaryText}` : labelText}
              </span>
            ) : (
              <>
                <span>{labelText}</span>
                {summaryText && (
                  <code className="rounded-md bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--color-text-primary)]">
                    {summaryText}
                  </code>
                )}
              </>
            )}
            <ChevronDownIcon className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          {sources.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <span className="text-[11px] font-medium text-[var(--color-text-muted)]">来源引用：</span>
              {sources.map((src, idx) => (
                <button
                  type="button"
                  key={`${src.url}-${idx}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openInWebPreview(src.url, src.title);
                  }}
                  className="inline-flex max-w-[280px] items-center gap-1.5 truncate rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-0.5 text-[11px] text-sky-600 dark:text-sky-400 transition-colors hover:border-sky-500/50 hover:bg-sky-500/20 cursor-pointer text-left"
                  title={`在右侧Webview预览：\n${src.title}\n${src.url}`}
                >
                  <GlobeIcon className="size-3 shrink-0 text-sky-500" />
                  <span className="truncate">{src.title || src.url}</span>
                  <PanelRightOpenIcon className="size-2.5 shrink-0 opacity-70" />
                </button>
              ))}
            </div>
          )}
          <div className="mt-2 space-y-3">
            {sections.map((section) => (
              <section key={section.label}>
                <h4 className="mb-1 text-[11px] font-medium text-[var(--color-text-muted)]">{section.label}</h4>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-2)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--color-text-primary)]">{section.value}</pre>
              </section>
            ))}
            {detail?.truncated === true && <p className="text-[12px] text-[var(--color-text-muted)]">服务端返回的结果已截断</p>}
            {sections.length === 0 && <p className="text-[13px] text-[var(--color-text-muted)]">此工具调用没有提供可展示的参数或结果。</p>}
          </div>
        </details>
        {/* 当详情未手动展开时，在下方直接展示醒目的来源引用胶囊，点击在右侧Webview中直接展开预览 */}
        {!open && sources.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <span className="text-[11px] font-medium text-[var(--color-text-muted)]">来源引用：</span>
            {sources.map((src, idx) => (
              <button
                type="button"
                key={`collapsed-${src.url}-${idx}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openInWebPreview(src.url, src.title);
                }}
                className="inline-flex max-w-[280px] items-center gap-1.5 truncate rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-0.5 text-[11px] text-sky-600 dark:text-sky-400 transition-colors hover:border-sky-500/50 hover:bg-sky-500/20 cursor-pointer text-left"
                title={`在右侧Webview预览：\n${src.title}\n${src.url}`}
              >
                <GlobeIcon className="size-3 shrink-0 text-sky-500" />
                <span className="truncate">{src.title || src.url}</span>
                <PanelRightOpenIcon className="size-2.5 shrink-0 opacity-70" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function activityLabel(activity: Activity, isGroupComplete = false): string {
  const name = toolName(activity);
  const label = TOOL_ACTIONS[name] ?? `调用了 ${name}`;
  if (!isGroupComplete && (activity.status === "running" || activity.status === "pending")) {
    return ACTIVE_TOOL_ACTIONS[name] ?? `正在调用 ${name}`;
  }
  if (!isGroupComplete && activity.status === "waiting_approval") return `等待审批：${label}`;
  if (activity.status === "failed") return `${label}（失败）`;
  if (activity.status === "cancelled") return `${label}（已取消）`;
  return label;
}

function ProcessNoteActivity({
  item,
  isGroupComplete = false,
}: {
  item: Extract<ProcessTimelineItem, { kind: "assistant" }>;
  isGroupComplete?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shimmerActive = Boolean(!isGroupComplete && item.streaming);
  const displayLabel = item.streaming
    ? item.label.replace(/^已完成/, "正在")
    : item.label === "已完成分析"
      ? "过程摘要"
      : item.label;
  const cleanedContent = plainProcessText(item.content);
  const singleLinePreview = cleanedContent.replace(/\s+/g, " ").trim();

  return (
    <details
      className="process-activity-enter group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex w-full cursor-pointer list-none items-center gap-2 text-[13px] text-[var(--color-text-secondary)] [&::-webkit-details-marker]:hidden">
        {shimmerActive ? (
          <BrainCircuitIcon className="size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
        ) : (
          <CheckCircle2Icon className="size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
        )}
        {shimmerActive ? (
          <span className="shimmer shimmer-color-blue-500/60 shrink-0 font-medium inline-block">
            {displayLabel}
          </span>
        ) : (
          <span className="shrink-0">{displayLabel}</span>
        )}
        {!open && singleLinePreview && (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-muted)]",
              shimmerActive && "shimmer shimmer-color-blue-500/60 font-medium inline-block"
            )}
          >
            {singleLinePreview}
          </span>
        )}
        <ChevronDownIcon className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      {open && (
        <div className="ml-[26px] mt-1.5 break-words border-l border-[var(--color-border-subtle)] pl-3 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
          <p
            className={cn(
              "whitespace-pre-wrap",
              shimmerActive && "streaming-caret shimmer shimmer-color-blue-500/60"
            )}
          >
            {cleanedContent}
          </p>
        </div>
      )}
    </details>
  );
}

export function ProcessActivityGroup({
  items,
  isActive = false,
  startedAt: runStartedAt,
  finalAnswerComplete = false,
  finalAnswerStreaming = false,
  runCompleted = false,
  durationMs,
}: ProcessActivityGroupProps) {
  const activities = items.flatMap((item) => item.kind === "activity" ? [item.activity] : []);
  const failedCount = activities.filter((activity) => activity.status === "failed").length;
  const hasStreamingMessage = items.some((item) => item.kind === "assistant" && item.streaming);
  const rawActiveCount = activities.filter((activity) =>
    activity.status === "running" || activity.status === "pending" || activity.status === "waiting_approval",
  ).length;

  // 判定总体过程是否已进入终态或正文输出阶段：
  // 1. 运行已结束 (runCompleted)；
  // 2. 最终答复已完成 (finalAnswerComplete)；
  // 3. 最终答复已开始流式揭示且思考过程已结束 (finalAnswerStreaming && !hasStreamingMessage)；
  // 4. 当前既非活跃态且无任何正在流式输出的思考/过程消息或运行中工具。
  const isComplete = Boolean(
    runCompleted ||
    finalAnswerComplete ||
    (finalAnswerStreaming && !hasStreamingMessage) ||
    (!isActive && rawActiveCount === 0 && !hasStreamingMessage)
  );

  // 当整轮已完成或正文已进入输出阶段时，activeCount 强制视为 0，杜绝状态残留导致的持续展开
  const activeCount = isComplete ? 0 : rawActiveCount;

  const analysisBusy =
    !isComplete &&
    (activeCount > 0 ||
      hasStreamingMessage ||
      (isActive && !finalAnswerStreaming && !finalAnswerComplete && !runCompleted));

  const settled = !analysisBusy && items.length > 0;
  // 展开与收缩策略（严格对齐 agentscope-harness）：
  // 1. 过程进行中（思考、中间过程说明、工具调用等执行中，!settled）大时间线默认保持展开；
  // 2. 内部思考项与过程摘要项本身不展开多行正文，单行呈现 Shimmer 闪光与预览摘要；
  // 3. 总体工具和思考执行完毕、开始正式输出最后总结正文（settled 为 true）时大时间线自动收缩；
  // 4. 用户手动点击标题栏可随时展开/收起查看详情；过渡到正式正文时重置手动状态，确保自然收缩。
  const [manualExpanded, setManualExpanded] = useState<boolean | undefined>(undefined);
  const prevSettledRef = useRef(settled);
  useEffect(() => {
    if (prevSettledRef.current !== settled) {
      prevSettledRef.current = settled;
      setManualExpanded(undefined);
    }
  }, [settled]);

  const expanded = manualExpanded ?? !settled;
  const statusLabel = isComplete ? "已完成分析" : "正在分析";

  // 提取历史活动记录中的有效毫秒时间戳（过滤异常 0 或小序号，防止跨数量级相减导致数万分钟虚假耗时）
  const itemStartTimes: number[] = [];
  const itemEndTimes: number[] = [];
  for (const item of items) {
    if (item.kind === "assistant") {
      if (typeof item.startedAt === "number" && item.startedAt >= 1_000_000_000_000) {
        itemStartTimes.push(item.startedAt);
        if (typeof item.reasoningDuration === "number" && item.reasoningDuration > 0) {
          itemEndTimes.push(item.startedAt + item.reasoningDuration * 1000);
        }
      }
    } else {
      if (typeof item.activity.startedAt === "number" && item.activity.startedAt >= 1_000_000_000_000) {
        itemStartTimes.push(item.activity.startedAt);
      }
      if (typeof item.activity.endedAt === "number" && item.activity.endedAt >= 1_000_000_000_000) {
        itemEndTimes.push(item.activity.endedAt);
      }
    }
  }

  // 历史静态耗时秒数（完成态或历史会话加载时使用）
  const historySeconds = (() => {
    if (typeof durationMs === "number" && durationMs >= 0) {
      return Math.floor(durationMs / 1000);
    }
    if (itemStartTimes.length > 0 && itemEndTimes.length > 0) {
      const minStart = Math.min(...itemStartTimes);
      const maxEnd = Math.max(...itemEndTimes);
      const spanMs = maxEnd - minStart;
      if (spanMs >= 0 && spanMs <= 3_600_000) {
        return Math.max(1, Math.floor(spanMs / 1000));
      }
    }
    return 1;
  })();

  // 活跃运行初始秒数：支持继承 runStartedAt 或外部传入的 durationMs
  const initialActiveSeconds = (() => {
    if (typeof durationMs === "number" && durationMs >= 0) {
      return Math.max(0, Math.floor(durationMs / 1000));
    }
    if (typeof runStartedAt === "number" && runStartedAt > 0) {
      const diff = Date.now() - runStartedAt;
      if (diff >= 0 && diff < 3_600_000) {
        return Math.floor(diff / 1000);
      }
    }
    return 0;
  })();

  // 记录本轮组件是否是以已完成状态初次挂载（历史会话）
  const isHistoryMountRef = useRef<boolean>(isComplete && settled);

  // 严格按 1 秒 1 秒稳步累加的秒数计数器
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(() => {
    return isHistoryMountRef.current ? historySeconds : initialActiveSeconds;
  });

  // 分析完成时锁定的最终秒数（杜绝输出正文或整轮结束时跳变）
  const lockedSecondsRef = useRef<number | undefined>(undefined);

  // 仅在正在分析中（!isComplete）启动 1 秒步进累加定时器
  useEffect(() => {
    if (isComplete) {
      if (lockedSecondsRef.current === undefined) {
        lockedSecondsRef.current =
          typeof durationMs === "number" && durationMs >= 0
            ? Math.floor(durationMs / 1000)
            : isHistoryMountRef.current
              ? historySeconds
              : Math.max(1, elapsedSeconds);
      }
      return;
    }

    // 重新进入分析时重置锁定
    lockedSecondsRef.current = undefined;

    const timer = window.setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isComplete, durationMs, historySeconds, elapsedSeconds]);

  // 最终显示的秒数：若外部明确给定 durationMs 则优先精确对齐，否则取锁定秒数或实时累加秒数
  const displaySeconds =
    typeof durationMs === "number" && durationMs >= 0
      ? Math.floor(durationMs / 1000)
      : isComplete
        ? (lockedSecondsRef.current ?? (isHistoryMountRef.current ? historySeconds : Math.max(1, elapsedSeconds)))
        : elapsedSeconds;

  const displayDurationText = `${Math.floor(displaySeconds / 60)}分${displaySeconds % 60}秒`;

  if (items.length === 0 && !isActive) return null;

  return (
    <section className="process-group my-3 w-full text-[var(--color-text-primary)]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManualExpanded(!expanded)}
        className="flex w-full items-center gap-2 border-b border-[var(--color-border-subtle)] py-2.5 text-left text-[15px] text-[var(--color-text-secondary)] transition-colors"
      >
        {!isComplete ? (
          <span className="text-[13px]">
            <Shimmer as="span" duration={2} spread={3} className="font-medium">{`${statusLabel}，用时 ${displayDurationText}`}</Shimmer>
          </span>
        ) : (
          <span className="text-[13px] font-medium">{statusLabel}，用时 {displayDurationText}</span>
        )}
        {failedCount > 0 && <span className="text-xs text-[var(--color-state-error)]">（{failedCount} 项失败）</span>}
        {expanded ? (
          <ChevronDownIcon className="ml-0.5 size-3.5 -rotate-180 transition-transform" />
        ) : (
          <ChevronDownIcon className="ml-0.5 size-3.5 transition-transform" />
        )}
      </button>

      {expanded && (
        <div className="flex flex-col gap-4 pt-4">
          {items.map((item, index) => {
            const staggerStyle = { animationDelay: `${Math.min(index, 8) * 45}ms` };
            if (item.kind === "assistant") {
              if (item.section === "reasoning") {
                return <div key={item.id} style={staggerStyle}><ReasoningActivity item={item} isGroupComplete={isComplete} /></div>;
              }
              return (
                <div key={item.id} style={staggerStyle}>
                  <ProcessNoteActivity item={item} isGroupComplete={isComplete} />
                </div>
              );
            }

            const activity = item.activity;
            if (activity.kind === "subagent") {
              const detail = activity.detail as { name?: string; goal?: string; resultSummary?: string } | undefined;
              const isSubagentRunning = !isComplete && (activity.status === "running" || activity.status === "pending");
              const label = activity.status === "completed" || isComplete
                ? "完成了子任务"
                : activity.status === "failed"
                  ? "子任务执行失败"
                  : "正在执行子任务";
              const description = detail?.goal ?? detail?.name ?? activity.title;
              return (
                <div key={item.id} className="process-activity-enter text-[13px] text-[var(--color-text-secondary)]" style={staggerStyle}>
                  <div className="flex items-center gap-2.5">
                    <BrainCircuitIcon className="size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
                    {isSubagentRunning ? (
                      <span className="shimmer shimmer-color-blue-500/60 font-medium inline-block">{label}</span>
                    ) : (
                      <span>{label}</span>
                    )}
                    {description && (
                      isSubagentRunning ? (
                        <span className="shimmer shimmer-color-blue-500/60 truncate inline-block">{description}</span>
                      ) : (
                        <span className="truncate">{description}</span>
                      )
                    )}
                  </div>
                  {detail?.resultSummary && (
                    <p className="ml-[26px] mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-text-primary)]">
                      {detail.resultSummary}
                    </p>
                  )}
                </div>
              );
            }

            return (
              <ToolActivityRow
                key={item.id}
                itemId={item.id}
                activity={activity}
                style={staggerStyle}
                isGroupComplete={isComplete}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
