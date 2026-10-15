/**
 * 子 Agent 卡片。
 *
 * 展示 task 工具派发的子 Agent：名称、运行状态与（可展开的）
 * 结果摘要。子 Agent 自身的工具调用由通用工具行渲染（标题带
 * `子代理名/工具名` 前缀），这里只负责子 Agent 本体。
 */

import { useState } from "react";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import type { Activity } from "@deepagent/shared";
import { cn } from "../../lib/utils.js";

interface SubagentCardProps {
  activity: Activity;
}

export function SubagentCard({ activity }: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const detail = activity.detail as { name?: string; resultSummary?: string } | undefined;
  const isRunning = activity.status === "running";
  const isFailed = activity.status === "failed";
  const summary = (detail?.resultSummary ?? "").trim();
  const name = detail?.name ?? (activity.title.replace(/^子 Agent · /, "") || "subagent");

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left select-none"
        title="点击展开/收起子 Agent 详情"
      >
        <ChevronRightIcon
          className={cn("size-3 text-zinc-500 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <BotIcon
          className={cn(
            "size-4 shrink-0",
            isRunning ? "text-blue-400" : isFailed ? "text-red-400" : "text-emerald-400",
          )}
        />
        <span className="text-xs text-zinc-300 truncate">
          {isRunning ? "正在派发子 Agent：" : isFailed ? "子 Agent 失败：" : "子 Agent 已完成："}
          <span className="text-zinc-100 font-medium">{name}</span>
        </span>
        {isRunning ? (
          <span className="ml-auto shrink-0 text-[11px] text-blue-400/90 animate-pulse">运行中</span>
        ) : isFailed ? (
          <span className="ml-auto shrink-0 text-[11px] text-red-400">失败</span>
        ) : (
          <span className="ml-auto shrink-0 text-[11px] text-emerald-500/80">完成</span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 ml-5 max-h-48 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] p-2">
          {summary ? (
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
              {summary}
            </pre>
          ) : (
            <div className="text-[11px] text-zinc-500">
              {isRunning ? "子 Agent 仍在运行，结束后显示结果摘要。" : "无结果摘要。"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
