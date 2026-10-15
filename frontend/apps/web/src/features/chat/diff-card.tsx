/** 文件变更 Diff 汇总卡片。 */

import { useState } from "react";
import {
  Queue,
  QueueSection,
  QueueSectionTrigger,
  QueueSectionLabel,
  QueueSectionContent,
  QueueList,
} from "../../components/ai-elements/queue.js";
import {
  FileDiffIcon,
  ChevronRightIcon,
  FilePlusIcon,
  FilePenIcon,
  FileXIcon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";

/** 单次修订的 Diff 内容。 */
export interface FileRevision {
  additions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
}

/** 聚合后的单文件变更：行数为所有修订累计，修订明细按时间排列。 */
export interface FileChangeSummary {
  path: string;
  operation: "write" | "edit" | "delete";
  additions: number;
  deletions: number;
  revisions: FileRevision[];
}

interface DiffCardProps {
  changes: FileChangeSummary[];
}

export function DiffCard({ changes }: DiffCardProps) {
  if (changes.length === 0) return null;

  const totalAdditions = changes.reduce((sum, change) => sum + change.additions, 0);
  const totalDeletions = changes.reduce((sum, change) => sum + change.deletions, 0);

  return (
    <Queue className="my-2 border-zinc-800/80 bg-zinc-950/60">
      <QueueSection defaultOpen={false}>
        <QueueSectionTrigger className="bg-zinc-900/60 text-zinc-300 hover:bg-zinc-900">
          <QueueSectionLabel
            count={changes.length}
            label={`个文件变更 (+${totalAdditions} −${totalDeletions})`}
            icon={
              <span className="flex shrink-0 items-center gap-1.5">
                <FileDiffIcon className="size-4 text-blue-400" />
                <span className="font-mono text-[11px] text-emerald-400">+{totalAdditions}</span>
                <span className="font-mono text-[11px] text-red-400">−{totalDeletions}</span>
              </span>
            }
          />
        </QueueSectionTrigger>

        <QueueSectionContent>
          <QueueList className="mt-1">
            {changes.map((change) => (
              <FileDiffRow key={change.path} change={change} />
            ))}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  );
}

/** 单文件行：路径和行数统计，可展开查看着色 diff。 */
function FileDiffRow({ change }: { change: FileChangeSummary }) {
  const [expanded, setExpanded] = useState(false);
  const fileName = change.path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? change.path;
  const dirPart = change.path.slice(0, change.path.length - fileName.length).replace(/\\/g, "/");
  const OperationIcon = change.operation === "delete"
    ? FileXIcon
    : change.operation === "edit"
      ? FilePenIcon
      : FilePlusIcon;
  const operationLabel = change.operation === "delete" ? "删除" : change.operation === "edit" ? "修改" : "新建";

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="-mx-1 flex w-full select-none items-center gap-2.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-zinc-900/60"
        title={change.path}
        aria-expanded={expanded}
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 text-zinc-500 transition-transform", expanded && "rotate-90")} />
        <OperationIcon
          className={cn(
            "size-3.5 shrink-0",
            change.operation === "delete"
              ? "text-red-400/80"
              : change.operation === "edit"
                ? "text-amber-400/80"
                : "text-emerald-400/80",
          )}
        />
        <span className="truncate font-mono text-[12.5px] text-zinc-200">
          {dirPart && <span className="text-zinc-500">{dirPart}</span>}
          {fileName}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="select-none text-[10.5px] text-zinc-500">{operationLabel}</span>
          {change.additions > 0 && <span className="font-mono text-[11px] text-emerald-400">+{change.additions}</span>}
          {change.deletions > 0 && <span className="font-mono text-[11px] text-red-400">−{change.deletions}</span>}
        </span>
      </button>

      {expanded && change.revisions.length > 0 && (
        <div className="mb-1.5 mt-1 ml-5 flex flex-col gap-2">
          {change.revisions.map((revision, revisionIndex) => (
            <div key={revisionIndex} className="max-h-64 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] py-1">
              {change.revisions.length > 1 && (
                <div className="flex items-center gap-2 border-b border-zinc-800/60 px-2 pt-1 pb-0.5 text-[10.5px] text-zinc-500">
                  <span>第 {revisionIndex + 1} 次修改</span>
                  {revision.additions > 0 && <span className="font-mono text-emerald-400/90">+{revision.additions}</span>}
                  {revision.deletions > 0 && <span className="font-mono text-red-400/90">−{revision.deletions}</span>}
                </div>
              )}
              <pre className="whitespace-pre px-2 font-mono text-[11px] leading-[1.55]">
                {revision.patch.split("\n").map((line, lineIndex) => (
                  <div
                    key={lineIndex}
                    className={cn(
                      "-mx-1 px-1",
                      line.startsWith("+") && "bg-emerald-500/10 text-[var(--color-diff-add)]",
                      line.startsWith("-") && "bg-red-500/10 text-[var(--color-diff-delete)]",
                      line.startsWith("@@") && "bg-blue-500/10 text-blue-400",
                      !line.startsWith("+") && !line.startsWith("-") && !line.startsWith("@@") && "text-[var(--color-diff-context)]",
                    )}
                  >
                    {line || " "}
                  </div>
                ))}
              </pre>
              {revision.truncated && (
                <div className="px-2 pt-1 text-[10.5px] text-zinc-500">差异内容过长，仅显示部分行。</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
