/**
 * 任务列表组件（基于 AI SDK Elements 官方 Queue 组件重构）。
 *
 * 参考官网规范：https://elements.ai-sdk.dev/components/queue
 * 包含：
 * - 紧凑行内胶囊触发条（与工作区选择器平行独立对齐，高度一致）
 * - 独立向上展开的待办任务详情浮动面板（适配黑白双色主题，不影响工作区展开与底栏高度）
 * - QueueList 任务条目列表
 * - QueueItem 独立任务项
 * - QueueItemIndicator 状态圆环指示器（待办/进行中/完成）
 * - QueueItemContent 任务标题内容（已完成划线）
 */

import { useState, useRef, useEffect, useCallback } from "react";
import {
  QueueList,
  QueueItem,
  QueueItemIndicator,
  QueueItemContent,
} from "../../components/ai-elements/queue.js";
import {
  ListTodoIcon,
  CheckCircle2Icon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import type { Activity, TodoDetail } from "@deepagent/shared";

interface TodoCardProps {
  activity: Activity;
  isOpen?: boolean;
  onToggleOpen?: () => void;
  onClose?: () => void;
}

export function TodoCard({ activity, isOpen: controlledOpen, onToggleOpen, onClose }: TodoCardProps) {
  const detail = activity.detail as TodoDetail | undefined;
  const hasItems = Boolean(detail?.items?.length);
  const isAllDone = Boolean(detail && detail.completed >= detail.total && detail.total > 0);
  const [internalOpen, setInternalOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  const handleToggle = () => {
    if (isControlled) {
      onToggleOpen?.();
    } else {
      setInternalOpen((v) => !v);
    }
  };

  const handleClose = useCallback(() => {
    if (isControlled) {
      onClose?.();
    } else {
      setInternalOpen(false);
    }
  }, [isControlled, onClose]);

  // 点击外部自动收起待办面板
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, handleClose]);

  if (!hasItems || !detail) return null;

  return (
    <div
      ref={containerRef}
      data-testid="todo-queue-card"
      className="relative flex w-fit shrink-0 items-center"
    >
      {/* 独立触发按钮：与工作区选择器保持完全一致的规格、主题与独立性 */}
      <button
        type="button"
        data-testid="todo-queue-trigger"
        onClick={handleToggle}
        className={cn(
          "group inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-[13px] font-medium transition-colors select-none max-w-[320px] border-0 outline-none cursor-pointer",
          "bg-transparent hover:bg-zinc-200/80 text-zinc-800",
          "dark:hover:bg-zinc-900/80 dark:text-zinc-100"
        )}
        title="点击展开/收起待办任务详情"
      >
        {isAllDone ? (
          <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
        ) : (
          <ListTodoIcon className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
        )}
        <span className="truncate">
          {detail.total} 项待办任务 ({detail.completed}/{detail.total} 已完成)
        </span>
        {activity.status === "failed" || activity.status === "cancelled" ? (
          <span className="ml-1 text-xs text-amber-600 dark:text-amber-400 shrink-0">
            {activity.status === "failed" ? "执行中断" : "已取消"}
          </span>
        ) : null}
        <ChevronDownIcon
          className={cn(
            "size-3.5 text-zinc-500 dark:text-zinc-400 shrink-0 transition-transform duration-200 ml-0.5",
            isOpen && "rotate-180 text-zinc-800 dark:text-zinc-200",
          )}
        />
      </button>

      {/* 独立向上展开的待办任务详情浮动卡片（完全独立浮层，适配黑白双色主题，绝不拉伸或影响工作区） */}
      {isOpen && (
        <div
          data-testid="todo-queue-panel"
          className={cn(
            "todo-queue-panel absolute right-0 bottom-full mb-2 z-50 w-80 sm:w-96 rounded-2xl p-2.5 select-none animate-in fade-in zoom-in-95 duration-100",
            "bg-white text-zinc-900 border border-zinc-200/90 shadow-xl",
            "dark:bg-[#242427] dark:text-zinc-100 dark:border-zinc-800/80 dark:shadow-2xl"
          )}
        >
          {/* 顶栏状态与进度概览 */}
          <div className="flex items-center justify-between px-2 py-1 mb-1.5 border-b border-zinc-200/80 dark:border-zinc-700/50 text-[12px] font-medium text-zinc-600 dark:text-zinc-400">
            <span className="flex items-center gap-1.5">
              {isAllDone ? (
                <CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <ListTodoIcon className="size-3.5 text-amber-600 dark:text-amber-400" />
              )}
              <span>任务清单 ({detail.completed}/{detail.total} 已完成)</span>
            </span>
            {isAllDone ? (
              <span className="text-emerald-600 dark:text-emerald-400 text-[11px] font-medium">全部完成</span>
            ) : (
              <span className="text-blue-600 dark:text-blue-400 text-[11px] font-medium animate-pulse">进行中</span>
            )}
          </div>

          {/* 任务列表条目 */}
          <QueueList className="mt-0 max-h-56 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700">
            {detail.items.map((item, index) => {
              const isCompleted = item.status === "completed";
              const isRunning = item.status === "in_progress";

              return (
                <QueueItem
                  key={`${index}-${item.content}`}
                  className="px-2 py-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-[#2f2f35] transition-colors"
                >
                  <div className="flex items-center gap-2.5 py-0.5 text-[13px]">
                    {/* 状态指示：进行中 → 右箭头；已完成 → 打勾；待办 → 空心圆环 */}
                    {isCompleted ? (
                      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
                        <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
                      </span>
                    ) : isRunning ? (
                      <span
                        className="flex size-4 shrink-0 items-center justify-center"
                        aria-label="正在执行"
                      >
                        <ArrowRightIcon className="size-3.5 text-blue-600 dark:text-blue-400 animate-pulse" strokeWidth={2.5} />
                      </span>
                    ) : (
                      <QueueItemIndicator className="size-3.5 shrink-0 border-zinc-400 dark:border-zinc-500" />
                    )}
                    <QueueItemContent
                      completed={isCompleted}
                      className={cn(
                        isCompleted
                          ? "text-zinc-400 dark:text-zinc-500 line-through"
                          : "text-zinc-800 dark:text-zinc-200"
                      )}
                    >
                      {item.content}
                    </QueueItemContent>
                    {isRunning && (
                      <span className="ml-auto shrink-0 text-[11px] font-medium text-blue-600 dark:text-blue-400/90 animate-pulse select-none">
                        执行中
                      </span>
                    )}
                  </div>
                </QueueItem>
              );
            })}
          </QueueList>

          {activity.status === "failed" || activity.status === "cancelled" ? (
            <div className="mt-2 px-2 pt-1 border-t border-zinc-200/80 dark:border-zinc-700/40 text-[11px] text-amber-600 dark:text-amber-400">
              {activity.status === "failed" ? "任务执行中断，可继续发送指令继续" : "任务已取消"}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
