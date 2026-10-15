/**
 * 任务列表组件（基于 AI SDK Elements 官方 Queue 组件重构）。
 *
 * 参考官网规范：https://elements.ai-sdk.dev/components/queue
 * 包含：
 * - Queue 队列容器
 * - QueueSection 可折叠区块
 * - QueueSectionTrigger 触发栏
 * - QueueSectionLabel 状态统计标签
 * - QueueSectionContent 任务内容区
 * - QueueList 任务条目列表
 * - QueueItem 独立任务项
 * - QueueItemIndicator 状态圆环指示器（待办/进行中/完成）
 * - QueueItemContent 任务标题内容（已完成划线）
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
    <Queue className="my-1 w-fit max-w-full border-[var(--color-border-subtle)] bg-[var(--color-surface-1)]">
      <QueueSection defaultOpen={false}>
        <QueueSectionTrigger className="bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]">
          <QueueSectionLabel
            count={detail.total}
            label={`项待办任务 (${detail.completed}/${detail.total} 已完成)`}
            icon={
              isAllDone ? (
                <CheckCircle2Icon className="size-4 text-emerald-400 shrink-0" />
              ) : (
                <ListTodoIcon className="size-4 text-amber-400 shrink-0" />
              )
            }
          />
          {activity.status === "failed" || activity.status === "cancelled" ? (
            <span className="ml-2 text-xs text-amber-400">
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
                <QueueItem key={`${index}-${item.content}`}>
                  <div className="flex items-center gap-2.5 py-0.5">
                    {/* 状态指示：进行中 → 右箭头；已完成 → 打勾；待办 → 空心圆环 */}
                    {isCompleted ? (
                      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
                        <CheckIcon className="size-3 text-emerald-400" strokeWidth={3} />
                      </span>
                    ) : isRunning ? (
                      <span
                        className="flex size-4 shrink-0 items-center justify-center"
                        aria-label="正在执行"
                      >
                        <ArrowRightIcon className="size-3.5 text-blue-400 animate-pulse" strokeWidth={2.5} />
                      </span>
                    ) : (
                      <QueueItemIndicator className="size-3.5 shrink-0" />
                    )}
                    <QueueItemContent completed={isCompleted}>
                      {item.content}
                    </QueueItemContent>
                    {isRunning && (
                      <span className="ml-auto shrink-0 text-[11px] text-blue-400/90 animate-pulse select-none">
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
