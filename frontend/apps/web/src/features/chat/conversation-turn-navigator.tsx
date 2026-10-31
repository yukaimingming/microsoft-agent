import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils.js";

/** 聊天区左侧的上下文回合时间线导航项 */
export interface ConversationTurn {
  /** 回合锚点：该轮用户消息的 id（消息容器上带 data-message-id 供滚动定位） */
  id: string;
  /** HH:mm 格式简短时间 */
  time: string;
  /** 完整日期时间（例如：2026年10月28日 10:12） */
  dateTime: string;
  /** 该轮用户提问的首行标题 */
  prompt: string;
  /** 该轮助手回答的纯文本摘要预览 */
  replyPreview: string;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ConversationTurnNavigator({
  turns,
  getScrollElement,
  stopScroll,
}: {
  turns: ConversationTurn[];
  /** 取真实滚动元素（use-stick-to-bottom 的 scrollRef） */
  getScrollElement?: () => HTMLElement | null;
  /** 解除粘底锁定，让点击跳转不被拉回底部 */
  stopScroll?: () => void;
}) {
  const railRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredTurnId, setHoveredTurnId] = useState<string | null>(null);
  const [previewTop, setPreviewTop] = useState<number>(0);
  // 跳转动画令牌：连续点击时取消上一次动画
  const jumpTokenRef = useRef(0);

  // 导航条位于滚动容器外层（避免绝对定位随内容滚走）。
  // 优先使用 use-stick-to-bottom 提供的真实滚动元素，兜底取 [role=log] 的首个子节点。
  const getScrollContainer = (): HTMLElement | null => {
    const viaContext = getScrollElement?.();
    if (viaContext) return viaContext;
    const log = document.querySelector<HTMLElement>('[role="log"]');
    if (!log) return null;
    return log.firstElementChild instanceof HTMLElement ? log.firstElementChild : log;
  };

  // 点击：平滑滚动到对应回合
  const jumpTo = (messageId: string) => {
    const scroller = getScrollContainer();
    const target = scroller?.querySelector(`[data-message-id="${messageId}"]`);
    if (!scroller || !target) return;
    stopScroll?.();
    const targetTop =
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const from = scroller.scrollTop;
    const delta = targetTop - from;
    if (Math.abs(delta) < 2) return;

    if (prefersReducedMotion() || document.hidden) {
      scroller.scrollTop = targetTop;
      return;
    }

    const token = ++jumpTokenRef.current;
    const duration = 420;
    const start = performance.now();
    const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now: number): void => {
      if (token !== jumpTokenRef.current) return;
      const t = Math.min(1, (now - start) / duration);
      scroller.scrollTop = from + delta * ease(t);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // 按滚动位置推导当前所处的回合，高亮对应横条
  const items = useMemo(() => turns, [turns]);
  useEffect(() => {
    const container = getScrollContainer();
    if (!container || items.length === 0) return;
    const containerTop = () => container.getBoundingClientRect().top;
    const computeActive = () => {
      let current: string | null = items[0]?.id ?? null;
      for (const turn of items) {
        const el = container.querySelector(`[data-message-id="${turn.id}"]`);
        if (el && el.getBoundingClientRect().top <= containerTop() + 160) {
          current = turn.id;
        } else {
          break;
        }
      }
      setActiveId((prev) => (prev === current ? prev : current));
    };
    computeActive();
    container.addEventListener("scroll", computeActive, { passive: true });
    return () => container.removeEventListener("scroll", computeActive);
  }, [items]);

  // 导航条自身滚动到当前高亮项
  useEffect(() => {
    if (activeId) {
      activeRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [activeId]);

  const handleItemEnter = (turnId: string, buttonEl: HTMLButtonElement) => {
    const railEl = railRef.current;
    if (railEl) {
      const railRect = railEl.getBoundingClientRect();
      const btnRect = buttonEl.getBoundingClientRect();
      const rawCenterY = btnRect.top - railRect.top + btnRect.height / 2;
      const clampedY = Math.max(72, Math.min(Math.max(72, railRect.height - 72), rawCenterY));
      setPreviewTop(clampedY);
    }
    setHoveredTurnId(turnId);
  };

  if (items.length === 0) return null;

  const hoveredIndex = hoveredTurnId ? items.findIndex((t) => t.id === hoveredTurnId) : -1;
  const hoveredTurn = hoveredIndex >= 0 ? items[hoveredIndex] : null;

  return (
    <nav
      ref={railRef}
      aria-label="会话回合导航"
      data-testid="conversation-turn-navigator"
      onMouseLeave={() => setHoveredTurnId(null)}
      className="pointer-events-none absolute inset-y-0 left-2 z-30 flex w-7 flex-col select-none"
    >
      {/* 垂直居中的回合刻度槽，内部可独立滚动 */}
      <div className="pointer-events-auto m-auto flex max-h-[calc(100%-2rem)] w-full flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((turn, idx) => {
          const isActive = activeId === turn.id;
          const isHovered = hoveredTurnId === turn.id;
          return (
            <button
              key={turn.id}
              ref={isActive ? activeRef : undefined}
              type="button"
              data-testid={`turn-nav-item-${idx}`}
              aria-current={isActive ? "location" : undefined}
              aria-label={`第 ${idx + 1} 回合：${turn.prompt}`}
              onClick={() => jumpTo(turn.id)}
              onMouseEnter={(e) => handleItemEnter(turn.id, e.currentTarget)}
              onFocus={(e) => handleItemEnter(turn.id, e.currentTarget)}
              onBlur={() => setHoveredTurnId((prev) => (prev === turn.id ? null : prev))}
              className="group/nav-item relative flex h-3.5 w-6 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-1 focus-visible:ring-blue-500 cursor-pointer"
            >
              {/* 回合横条：紧凑间距，悬停或当前回合拉长并高亮 */}
              <span
                className={cn(
                  "turn-navigator-tick block h-[2px] rounded-full transition-all duration-150",
                  isActive || isHovered
                    ? "w-4 bg-zinc-800 dark:bg-zinc-100"
                    : "w-2.5 bg-zinc-300 group-hover/nav-item:w-4 group-hover/nav-item:bg-zinc-500 dark:bg-zinc-600 dark:group-hover/nav-item:bg-zinc-400",
                )}
              />
            </button>
          );
        })}
      </div>

      {/* 悬停内容预览卡片：挂载在 overflow-x-hidden 容器外层，避免被裁剪，向右弹出 */}
      {hoveredTurn && (
        <div
          role="tooltip"
          data-testid="turn-navigator-preview-card"
          style={{ top: `${previewTop}px` }}
          className={cn(
            "turn-navigator-preview-card pointer-events-none absolute left-full z-50 ml-2 w-[300px] sm:w-[340px] -translate-y-1/2 rounded-2xl border px-4 py-3.5 text-left transition-all duration-150 animate-in fade-in zoom-in-95",
            "bg-white border-zinc-200/90 text-zinc-900 shadow-xl",
            "dark:bg-[#1c1c1f] dark:border-zinc-800/90 dark:text-zinc-100 dark:shadow-[0_12px_32px_rgba(0,0,0,0.65)]",
          )}
        >
          {/* 1. 顶部：用户消息标题（单行截断） */}
          <div className="turn-preview-title truncate text-[14px] font-medium leading-snug text-zinc-900 dark:text-zinc-100 mb-1.5">
            {hoveredTurn.prompt}
          </div>

          {/* 2. 中部：助手回复内容摘要（最多 3 行截断） */}
          {hoveredTurn.replyPreview ? (
            <div className="turn-preview-body line-clamp-3 break-words text-[12.5px] leading-[1.6] text-zinc-600 dark:text-zinc-400 mb-3">
              {hoveredTurn.replyPreview}
            </div>
          ) : (
            <div className="turn-preview-body text-[12.5px] leading-[1.6] text-zinc-400 dark:text-zinc-500 mb-3">
              暂无回复内容
            </div>
          )}

          {/* 3. 底部：左侧回合进度 (如 23 of 23) + 右侧完整日期时间 (如 2026年10月28日 10:12) */}
          <div className="turn-preview-footer flex items-center justify-between gap-3 text-[12px] leading-none text-zinc-400 dark:text-zinc-500">
            <span className="tabular-nums">
              {hoveredIndex + 1} of {items.length}
            </span>
            {hoveredTurn.dateTime && (
              <span className="tabular-nums">
                {hoveredTurn.dateTime}
              </span>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
