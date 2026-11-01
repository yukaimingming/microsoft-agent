/**
 * Split View 分屏容器（移植自 langchain 项目 0bd92e5/b8799de 两个提交）。
 *
 * - 单屏模式：只渲染 leftPane，同时监听会话标签拖拽到右半侧的分屏放置探测
 * - 分屏模式：左右双 Pane + VS Code 风格可拖拽分割条（双击恢复对半平分）
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Columns2Icon } from "lucide-react";

export interface SplitChatViewProps {
  isSplit: boolean;
  leftPane: ReactNode;
  rightPane?: ReactNode;
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  onOpenSplitWithSession: (sessionId: string) => void;
}

export function SplitChatView({
  isSplit,
  leftPane,
  rightPane,
  splitRatio,
  onSplitRatioChange,
  onOpenSplitWithSession,
}: SplitChatViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);

  // 单屏模式下的全局右侧分屏放置探测
  const [isDropTargetActive, setIsDropTargetActive] = useState(false);

  // 分割条拖动逻辑（使用 PointerEvent 与 setPointerCapture，绝不丢帧）
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSplit) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDraggingSplitter(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingSplitter || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const clientX = e.clientX;
    const newRatio = (clientX - rect.left) / rect.width;
    // 限制比例在 25% ~ 75% 之间，防止某一侧被完全压扁
    const clampedRatio = Math.max(0.25, Math.min(0.75, newRatio));
    onSplitRatioChange(clampedRatio);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingSplitter) {
      setIsDraggingSplitter(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // 容错
      }
    }
  };

  // 监听单屏模式下拖拽会话项到右半部分
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (isSplit) return;
      if (!e.dataTransfer.types.includes("application/x-deepagent-session")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const relativeX = e.clientX - rect.left;
      // 只要鼠标移入主视图的右侧区域（后半程），激活右侧落焦指示
      if (relativeX > rect.width * 0.45) {
        setIsDropTargetActive(true);
      } else {
        setIsDropTargetActive(false);
      }
    },
    [isSplit],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsDropTargetActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (isSplit) return;
      setIsDropTargetActive(false);
      const droppedSessionId = e.dataTransfer.getData("application/x-deepagent-session");
      if (droppedSessionId) {
        e.preventDefault();
        onOpenSplitWithSession(droppedSessionId);
      }
    },
    [isSplit, onOpenSplitWithSession],
  );

  // 拖动分割条时全局禁用用户选中文本，避免闪烁
  useEffect(() => {
    if (isDraggingSplitter) {
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    } else {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isDraggingSplitter]);

  const leftPercent = `${(splitRatio * 100).toFixed(2)}%`;
  const rightPercent = `${((1 - splitRatio) * 100).toFixed(2)}%`;

  return (
    <div
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex h-full min-w-0 flex-1 overflow-hidden bg-white dark:bg-black"
    >
      {/* 单屏模式下右半侧落焦高亮提示层 */}
      {!isSplit && isDropTargetActive && (
        <div
          data-testid="split-drop-zone-indicator"
          className="pointer-events-none absolute inset-y-0 right-0 z-50 flex w-1/2 items-center justify-center bg-sky-500/10 backdrop-blur-[2px] dark:bg-sky-950/40 border-l-2 border-dashed border-sky-400 animate-in fade-in duration-150"
        >
          <div className="flex flex-col items-center gap-2 rounded-2xl bg-white/95 dark:bg-zinc-950/90 p-5 text-center shadow-2xl border border-sky-500/50">
            <div className="flex size-10 items-center justify-center rounded-xl bg-sky-100 dark:bg-sky-950 border border-sky-400/60 dark:border-sky-700/60 text-sky-600 dark:text-sky-400">
              <Columns2Icon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">释放以在右侧分屏显示</p>
              <p className="text-[12px] text-zinc-500 dark:text-zinc-400 mt-0.5">将对话以独立视窗左右并排对比查看</p>
            </div>
          </div>
        </div>
      )}

      {/* 单屏模式 */}
      {!isSplit ? (
        <div className="flex h-full w-full min-w-0 flex-1 overflow-hidden">{leftPane}</div>
      ) : (
        /* 分屏模式：左右双 Pane + 中间拖拽分割条 */
        <div className="flex h-full w-full min-w-0 flex-1 overflow-hidden">
          {/* 左侧面板 */}
          <div
            style={{ width: leftPercent, minWidth: "300px" }}
            className="flex h-full flex-col min-w-0 overflow-hidden"
          >
            {leftPane}
          </div>

          {/* VS Code 风格细分割线（可左右拖拽自由调节比例，双击重置居中） */}
          <div
            data-testid="split-chat-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(splitRatio * 100)}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDoubleClick={() => onSplitRatioChange(0.5)}
            title="按住左右拖拽调整分屏大小，双击恢复对半平分"
            className={`group relative flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-zinc-200 hover:bg-sky-500/80 dark:bg-zinc-900 transition-colors z-20 ${
              isDraggingSplitter ? "bg-sky-500" : ""
            }`}
          >
            {/* 分割线中央微小的拉手指示器 */}
            <div
              className={`h-8 w-0.5 rounded-full bg-zinc-400 group-hover:bg-white dark:bg-zinc-600 transition-colors ${
                isDraggingSplitter ? "bg-white" : ""
              }`}
            />
          </div>

          {/* 右侧面板 */}
          <div
            style={{ width: rightPercent, minWidth: "300px" }}
            className="flex h-full flex-col min-w-0 overflow-hidden"
          >
            {rightPane}
          </div>
        </div>
      )}
    </div>
  );
}
