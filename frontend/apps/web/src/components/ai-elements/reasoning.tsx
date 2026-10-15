"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";

import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
  elapsedSeconds: number;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = Omit<
  ComponentProps<typeof Collapsible>,
  "duration" | "onDurationChange"
> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  onDurationChange?: (duration: number | undefined) => void;
  startedAt?: number;
};

const AUTO_CLOSE_DELAY = 1200;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    onDurationChange,
    startedAt,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = defaultOpen ?? isStreaming;
    const isExplicitlyClosed = defaultOpen === false;

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      onChange: onDurationChange,
      prop: durationProp,
    });

    const startTimeRef = useRef<number>(startedAt ?? Date.now());
    if (startedAt && startTimeRef.current !== startedAt) {
      startTimeRef.current = startedAt;
    }

    const [elapsedSeconds, setElapsedSeconds] = useState(() => {
      const elapsedMs = Math.max(0, Date.now() - startTimeRef.current);
      return Math.max(1, Math.floor(elapsedMs / MS_IN_S) + 1);
    });

    const hasEverStreamedRef = useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);

    // 实时高频秒钟：完全解耦外部流式打字与 re-render 干扰，确保每过 1 秒物理时间 UI 实时无缝递增
    useEffect(() => {
      if (!isStreaming) {
        // 思考流结束时，锁定最终持续秒数
        const baseStart = startTimeRef.current;
        const elapsed = Math.max(0, Date.now() - baseStart);
        const finalSecs = durationProp ?? Math.max(1, Math.round(elapsed / MS_IN_S));
        setDuration(finalSecs);
        onDurationChange?.(finalSecs);
        return;
      }

      hasEverStreamedRef.current = true;

      // 立即精准计算一次当前流逝秒数（自然秒：0~999ms 为第 1 秒，满 1000ms 即刻同步为第 2 秒）
      const tick = () => {
        const baseStart = startTimeRef.current;
        const elapsedMs = Math.max(0, Date.now() - baseStart);
        const secs = Math.max(1, Math.floor(elapsedMs / MS_IN_S) + 1);
        setElapsedSeconds((prev) => (prev !== secs ? secs : prev));
      };
      tick();

      // 100ms 高频精准轮询：物理秒数一满立即同步，彻底消除任何相位延迟与卡秒
      const timer = setInterval(tick, 100);
      return () => clearInterval(timer);
    }, [isStreaming, durationProp]);

    // Auto-open when streaming starts (unless explicitly closed)
    useEffect(() => {
      if (isStreaming) {
        setHasAutoClosed(false);
        if (!isOpen && !isExplicitlyClosed) {
          setIsOpen(true);
        }
      }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

    // Auto-close when streaming ends (once only per streaming cycle)
    useEffect(() => {
      if (
        hasEverStreamedRef.current &&
        !isStreaming &&
        isOpen &&
        !hasAutoClosed
      ) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen);
      },
      [setIsOpen]
    );

    const effectiveDuration = durationProp ?? duration;

    const contextValue = useMemo(
      () => ({ duration: effectiveDuration, isOpen, isStreaming, setIsOpen, elapsedSeconds }),
      [effectiveDuration, isOpen, isStreaming, setIsOpen, elapsedSeconds]
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number, elapsedSeconds?: number) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number, elapsedSeconds = 1) => {
  if (isStreaming) {
    return (
      <span className="flex items-center gap-1.5 font-medium text-xs text-zinc-300">
        <Shimmer as="span" duration={2} spread={3}>
          正在思考中
        </Shimmer>
        <span className="tabular-nums text-zinc-400">{elapsedSeconds} 秒</span>
      </span>
    );
  }
  const displayDuration = typeof duration === "number" && duration > 0 ? duration : 2;
  return <span className="text-zinc-400 text-xs">完成思考 {displayDuration} 秒</span>;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration, elapsedSeconds } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4 shrink-0" />
            {getThinkingMessage(isStreaming, duration, elapsedSeconds)}
            <ChevronDownIcon
              className={cn(
                "size-4 shrink-0 transition-transform",
                isOpen ? "rotate-180" : "rotate-0"
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};


export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    const { isStreaming } = useReasoning();
    const content = typeof children === "string" ? children : "";
    return (
      <CollapsibleContent
        className={cn(
          "mt-4 text-sm",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
          className
        )}
        {...props}
      >
        <div className={cn(isStreaming ? "streaming-caret" : "")}>
          {content ? <Streamdown>{content}</Streamdown> : null}
        </div>
      </CollapsibleContent>
    );
  }
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
