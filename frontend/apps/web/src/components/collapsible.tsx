/** 可折叠容器：默认折叠大型输入/输出。 */

import { useId, useState, type ReactNode } from "react";

interface CollapsibleProps {
  summary: string;
  children: ReactNode;
  /** 默认是否展开。 */
  defaultOpen?: boolean;
  /** 展开时显示的内容是否已截断（用于提示）。 */
  truncated?: boolean;
}

export function Collapsible({ summary, children, defaultOpen = false, truncated }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
      >
        <span className="text-[10px] text-text-muted">{open ? "▼" : "▶"}</span>
        <span className="truncate">{summary}</span>
        {truncated ? <span className="shrink-0 text-[10px] text-state-warn">已截断</span> : null}
      </button>
      {open ? (
        <div id={contentId} className="mt-1.5">
          {children}
        </div>
      ) : null}
    </div>
  );
}
