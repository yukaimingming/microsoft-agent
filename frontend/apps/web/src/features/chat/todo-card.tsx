/**
 * 任务列表组件（基于 AI SDK Elements 官方 Queue 组件重构）。
 *
 * 全面适配深浅双色主题（Light / Dark），确保在亮白和深黑模式下均具备
 * 卓越的对比度、柔和的质感和优雅的状态指示。
 */

import {
  Queue,
  QueueSection,
  QueueSectionTrigger,
  QueueSectionLabel,
  QueueSectionContent,
  QueueList,
  QueueItem,
  QueueItemIndicator,
  QueueItemContent,
} from "../../components/ai-elements/queue.js";
import { ListTodoIcon, CheckCircle2Icon, ArrowRightIcon, CheckIcon } from "lucide-react";
import type { Activity, TodoDetail } from "@deepagent/shared";

interface TodoCardProps {
  activity: Activity;
}

export function TodoCard({ activity }: TodoCardProps) {
  const detail = activity.detail as TodoDetail | undefined;
  if (!detail?.items?.length) return null;

  const isAllDone = detail.completed >= detail.total && detail.total > 0;

  return (
    <Queue className="todo-card-container my-1 w-fit max-w-full rounded-xl border border-zinc-200 bg-white shadow-xs transition-colors dark:border-zinc-800 dark:bg-[#18181b] dark:shadow-md">
      <QueueSection defaultOpen={false}>
        <QueueSectionTrigger className="todo-card-trigger flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors bg-zinc-100/90 hover:bg-zinc-200/90 text-zinc-800 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 dark:text-zinc-200 border-0 outline-none">
          <QueueSectionLabel
            count={detail.total}
            label={`项待办任务 (${detail.completed}/${detail.total} 已完成)`}
            icon={
              isAllDone ? (
                <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              ) : (
                <ListTodoIcon className="size-4 text-amber-500 dark:text-amber-400 shrink-0" />
              )
            }
          />
          {activity.status === "failed" || activity.status === "cancelled" ? (
            <span className="ml-2 text-xs font-medium text-amber-600 dark:text-amber-400">
              {activity.status === "failed" ? "执行中断，可继续" : "已取消，可继续"}
            </span>
          ) : null}
        </QueueSectionTrigger>

        <QueueSectionContent>
          <QueueList className="mt-1">
            {detail.items.map((item, index) => {
              const isCompleted = item.status === "completed";
              const isRunning = item.status === "in_progress";

              return (
                <QueueItem
                  key={`${index}-${item.content}`}
                  className="todo-card-item rounded-lg px-2.5 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
                >
                  <div className="flex items-center gap-2.5 py-0.5">
                    {/* 状态指示：进行中 → 右箭头；已完成 → 打勾；待办 → 空心圆环 */}
                    {isCompleted ? (
                      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                        <CheckIcon className="size-3" strokeWidth={3} />
                      </span>
                    ) : isRunning ? (
                      <span
                        className="flex size-4 shrink-0 items-center justify-center text-blue-600 dark:text-blue-400"
                        aria-label="正在执行"
                      >
                        <ArrowRightIcon className="size-3.5 animate-pulse" strokeWidth={2.5} />
                      </span>
                    ) : (
                      <QueueItemIndicator className="size-3.5 shrink-0 border-zinc-400 bg-zinc-50 dark:border-zinc-600 dark:bg-transparent" />
                    )}
                    <QueueItemContent
                      completed={isCompleted}
                      className={
                        isCompleted
                          ? "text-zinc-400 line-through dark:text-zinc-500"
                          : "text-zinc-800 dark:text-zinc-200 font-normal"
                      }
                    >
                      {item.content}
                    </QueueItemContent>
                    {isRunning && (
                      <span className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 bg-blue-50 border border-blue-200/80 dark:text-blue-400 dark:bg-blue-950/40 dark:border-blue-800/50 animate-pulse select-none">
                        执行中
                      </span>
                    )}
                  </div>
                </QueueItem>
              );
            })}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  );
}
