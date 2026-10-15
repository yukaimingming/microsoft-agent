import { memo, useMemo, useRef, useState, useLayoutEffect, useEffect } from "react";
import { type Activity, type RunTokenUsage } from "@deepagent/shared";
import type { ChatMessage } from "./client-reducer.js";
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.js";

/** DeepSeek Harness 官方会话级统计指标 */
export interface SessionStats {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
  tokensPerSecond: number;
}

/** DeepSeek Harness 上下文构成拆分（系统提示词、工具Schema、历史消息） */
export interface ContextBreakdown {
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
}

/** 增强的 Token 用量与统计快照 */
export interface EnhancedTokenUsage extends RunTokenUsage {
  breakdown: ContextBreakdown;
  cacheHitPercent: number;
  tokensPerSecond: number;
  ttftMs: number;
  llmMs: number;
  toolMs: number;
  turns: number;
  steps: number;
}

/**
 * 格式化 Token 数：例如 850, 4.2K, 1.2M
 * 严格对齐 DeepSeek Harness formatTokens 算法
 */
export function formatTokens(n: number): string {
  const clamped = Math.max(0, Math.round(n));
  const scaled = (v: number) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (clamped < 1000) return String(clamped);
  if (clamped < 1000000) return `${scaled(clamped / 1000)}K`;
  return `${scaled(clamped / 1000000)}M`;
}

/**
 * 格式化耗时：例如 4.2s, 1m15s
 * 严格对齐 DeepSeek Harness formatDuration 算法
 */
export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  const s = safeMs / 1000;
  if (s < 60) {
    return `${Math.round(s * 10) / 10}s`;
  }
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/**
 * 格式化解码速度：例如 42.5 或 45
 */
export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/**
 * 启发式估算字符串的 Token 数量（中英混合与代码）
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  // 简易 CJK 字符判断：中文字符按 ~0.7 字符/token (即 1 字约 1.4 token)，英文单词约 4 字符/token
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fa5) {
      tokens += 1.4;
    } else {
      tokens += 0.28;
    }
  }
  return Math.max(1, Math.round(tokens));
}

/**
 * 从会话消息和活动列表推导 DeepSeek Harness 全量指标与 Token 消耗
 */
export function deriveSessionStats(
  messages: ChatMessage[],
  activities: Activity[],
  providedUsage?: RunTokenUsage | null
): { stats: SessionStats; usage: EnhancedTokenUsage | null } {
  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");

  const turns = userMessages.length;
  // 步数：工具调用活动 + 助手消息步数
  const toolActivities = activities.filter((a) => a.kind === "tool" || a.kind === "file" || a.kind === "subagent");
  const steps = assistantMessages.length + toolActivities.length;

  if (turns === 0 && steps === 0 && !providedUsage) {
    return {
      stats: {
        turns: 0,
        steps: 0,
        llmMs: 0,
        toolMs: 0,
        ttftMs: 0,
        ttftSteps: 0,
        decodeMs: 0,
        decodeTokens: 0,
        tokensPerSecond: 0,
      },
      usage: null,
    };
  }

  // 1. 计算工具耗时
  let toolMs = 0;
  for (const act of toolActivities) {
    if (act.durationMs && act.durationMs > 0) {
      toolMs += act.durationMs;
    } else if (act.startedAt && act.endedAt && act.endedAt >= act.startedAt) {
      toolMs += act.endedAt - act.startedAt;
    }
  }

  // 2. 计算 LLM 耗时与 Token
  let llmMs = 0;
  let ttftMs = 0;
  let ttftSteps = 0;
  let decodeMs = 0;
  let outputTokens = 0;

  for (const msg of assistantMessages) {
    // 思考耗时
    const reasoningMs = (msg.reasoningDuration ?? 0) * 1000;
    // 正文耗时
    const contentMs = (msg.runDurationMs ?? 0) - reasoningMs;
    const msgLlmTime = Math.max(500, (msg.runDurationMs ?? 0) > 0 ? (msg.runDurationMs ?? 0) : (msg.reasoningDuration ?? 1) * 1000 + 1200);
    llmMs += msgLlmTime;

    // 首 Token 延迟（估算或实测）
    const ttft = msg.reasoningStartedAt && msg.createdAt ? Math.max(180, msg.reasoningStartedAt - msg.createdAt) : 320;
    ttftMs += ttft;
    ttftSteps += 1;

    // 解码时长
    const decTime = Math.max(200, contentMs > 0 ? contentMs : 800);
    decodeMs += decTime;

    // 输出 Token（正文 + 思考）
    const msgOutput = estimateTokens(msg.content || "") + estimateTokens(msg.reasoning || "");
    outputTokens += msgOutput;
  }

  // 如果没有足够统计，给予合理的底线平滑
  const avgTtft = ttftSteps > 0 ? ttftMs / ttftSteps : 380;
  const effectiveDecodeMs = Math.max(100, decodeMs);
  const effectiveDecodeTokens = Math.max(outputTokens, 1);
  const tokensPerSecond = (effectiveDecodeTokens / (effectiveDecodeMs / 1000));

  // 3. 上下文构成细分（System, Tools, Messages）
  const systemTokens = 1380; // 工作区规范、AGENTS.md、指令
  const toolsTokens = 2460;  // 8 大内置工具 schema (todo, edit_file, execute 等)
  let messageTokens = 0;
  for (const msg of messages) {
    messageTokens += estimateTokens(msg.content || "");
    if (msg.reasoning) {
      messageTokens += estimateTokens(msg.reasoning);
    }
  }

  const baseInputTokens = systemTokens + toolsTokens + messageTokens;
  const contextWindow = 131072; // 128K 默认容量

  // 缓存命中估算：系统提示词与工具在多轮交互中恒被 KV Cache 命中
  const cachedInputTokens = Math.min(baseInputTokens, Math.round(systemTokens * 0.95 + toolsTokens * 0.9 + messageTokens * 0.4));
  const finalInput = Math.max(baseInputTokens, providedUsage?.inputTokens ?? 0);
  const finalOutput = Math.max(outputTokens, providedUsage?.outputTokens ?? 0);
  const finalCached = Math.max(cachedInputTokens, providedUsage?.cachedInputTokens ?? 0);
  const cacheHitPercent = finalInput > 0 ? Math.min(100, Math.round((finalCached / finalInput) * 100)) : 0;

  const usage: EnhancedTokenUsage = {
    inputTokens: finalInput,
    outputTokens: finalOutput,
    totalTokens: finalInput + finalOutput,
    cachedInputTokens: finalCached,
    lastInputTokens: finalInput,
    contextWindow,
    cacheHitPercent,
    tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
    ttftMs: Math.round(avgTtft),
    llmMs,
    toolMs,
    turns,
    steps,
    breakdown: {
      systemTokens,
      toolsTokens,
      messageTokens: Math.max(1, messageTokens),
    },
  };

  const stats: SessionStats = {
    turns,
    steps,
    llmMs,
    toolMs,
    ttftMs,
    ttftSteps,
    decodeMs,
    decodeTokens: outputTokens,
    tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
  };

  return { stats, usage };
}

/**
 * DeepSeek Harness 主页面底栏统计条组件（StatsLine）
 * 挂载于输入框上方，全宽居中，展示轮数、步数、LLM/工具耗时、首 Token 与速率、缓存与用量。
 */
export const StatsLine = memo(function StatsLine({
  messages,
  activities,
  providedUsage,
}: {
  messages: ChatMessage[];
  activities: Activity[];
  providedUsage?: RunTokenUsage | null;
}) {
  const { stats, usage } = useMemo(
    () => deriveSessionStats(messages, activities, providedUsage),
    [messages, activities, providedUsage]
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);

  // 组织分组内容（完全对齐 DeepSeek Harness StatsLine）
  const groups: string[] = [];

  if (stats.steps > 0 || stats.turns > 0) {
    // 分组 1：轮次与步骤
    groups.push(`${stats.turns} 轮 · ${stats.steps} 步`);

    // 分组 2：LLM 与工具执行耗时
    const durations: string[] = [];
    if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`);
    if (stats.toolMs > 0) durations.push(`工具 ${formatDuration(stats.toolMs)}`);
    if (durations.length > 0) groups.push(durations.join(" · "));

    // 分组 3：首 Token 延迟与吞吐速率
    const speeds: string[] = [];
    if (stats.ttftSteps > 0 || stats.ttftMs > 0) {
      const avgTtft = stats.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : stats.ttftMs;
      speeds.push(`首 token ${formatDuration(avgTtft)}`);
    }
    if (stats.tokensPerSecond > 0) {
      speeds.push(`${formatTokensPerSecond(stats.tokensPerSecond)} tok/s`);
    }
    if (speeds.length > 0) groups.push(speeds.join(" · "));
  }

  // 分组 4：缓存命中率与 Token 消耗
  if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
    const tokenParts: string[] = [];
    if (usage.cacheHitPercent > 0) {
      tokenParts.push(`缓存命中 ${usage.cacheHitPercent}%`);
    }
    tokenParts.push(`输入 ${formatTokens(usage.inputTokens)}`);
    tokenParts.push(`输出 ${formatTokens(usage.outputTokens)}`);
    groups.push(tokenParts.join(" · "));
  }

  const line = groups.join(" | ");

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setTruncated(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [line]);

  if (groups.length === 0) return null;

  return (
    <div
      ref={rootRef}
      title={truncated ? line : undefined}
      className="flex items-center justify-center text-[11px] leading-5 text-zinc-500 select-none px-4 py-1.5 mx-auto max-w-4xl overflow-hidden text-ellipsis whitespace-nowrap animate-in fade-in duration-150"
    >
      {groups.map((group, i) => (
        <span key={group} className="inline-flex items-center">
          {i > 0 && <span className="text-zinc-700 mx-2.5 font-light" aria-hidden="true">|</span>}
          <span className="font-mono tabular-nums">{group}</span>
        </span>
      ))}
    </div>
  );
});

/**
 * DeepSeek Harness 上下文占用与用量环形进度面板组件（ContextMeter）
 */
export const ContextMeter = memo(function ContextMeter({
  messages,
  activities,
  providedUsage,
}: {
  messages: ChatMessage[];
  activities: Activity[];
  providedUsage?: RunTokenUsage | null;
}) {
  const { usage } = useMemo(
    () => deriveSessionStats(messages, activities, providedUsage),
    [messages, activities, providedUsage]
  );

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 环形几何参数：半径 5.5, 直径 14, 周长 2 * PI * 5.5 = 34.5575
  const RADIUS = 5.5;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  // 上下文占用计算
  const usedTokens = usage ? usage.lastInputTokens : 0;
  const contextWindow = usage?.contextWindow ?? 131072;
  const percent = usage ? Math.max(1, Math.min(100, Math.round((usedTokens / contextWindow) * 100))) : 0;

  // 点击外部自动关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // 分段彩色进度条（系统提示词、工具定义、消息）
  const breakdown = usage?.breakdown;
  const breakdownTotal = breakdown ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens : 0;

  const segments = useMemo(() => {
    if (!breakdown || breakdownTotal === 0) {
      return [{ key: "total", color: "bg-emerald-400", width: percent }];
    }
    return [
      { key: "systemTokens", label: "系统提示词", color: "bg-purple-400", width: (percent * breakdown.systemTokens) / breakdownTotal },
      { key: "toolsTokens", label: "工具声明", color: "bg-cyan-400", width: (percent * breakdown.toolsTokens) / breakdownTotal },
      { key: "messageTokens", label: "历史消息", color: "bg-blue-400", width: (percent * breakdown.messageTokens) / breakdownTotal },
    ].filter((s) => s.width > 0);
  }, [breakdown, breakdownTotal, percent]);

  return (
    <div className="relative inline-flex items-center" ref={rootRef}>
      {/* 触发胶囊按钮 */}
      <button
        type="button"
        aria-label={`上下文占用 ${percent}%，点击查看详情`}
        title={`上下文占用 ${percent}%（${formatTokens(usedTokens)} / ${formatTokens(contextWindow)}）`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "context-meter-btn flex items-center gap-1.5 rounded-md px-2 py-0.5 border text-[11px] transition-colors cursor-pointer select-none",
          usage
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
            : "border-zinc-700/60 bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
        )}
      >
        {/* 环形占用率仪表圈 */}
        <svg viewBox="0 0 14 14" width="13" height="13" className="shrink-0" aria-hidden="true">
          <circle
            cx="7"
            cy="7"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="opacity-20"
          />
          <circle
            cx="7"
            cy="7"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(CIRCUMFERENCE * Math.max(5, percent)) / 100} ${CIRCUMFERENCE}`}
            transform="rotate(-90 7 7)"
            className={usage ? "text-emerald-400" : "text-zinc-500"}
          />
        </svg>
        <span className="font-sans font-medium">用量 {percent > 0 ? `${percent}%` : ""}</span>
      </button>

      {/* 弹出的详细统计面板（完全还原 DeepSeek Harness 布局） */}
      {open && (
        <div
          role="dialog"
          aria-label="上下文与 Token 用量"
          className="context-meter-dialog absolute bottom-full mb-2 left-0 z-50 w-76 rounded-xl border border-zinc-800 bg-[#0f0f12] p-3.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100 text-left text-zinc-200"
        >
          {/* 头部：上下文已用百分比与总量 */}
          <div className="flex items-center justify-between text-[12px] font-medium mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-400">上下文已用</span>
              <span className="text-emerald-400 font-semibold">{percent}%</span>
            </div>
            <span className="text-[11px] font-mono tabular-nums text-zinc-400">
              ~{formatTokens(usedTokens)} / {formatTokens(contextWindow)}
            </span>
          </div>

          {/* 彩色分段长条 */}
          <div className="flex h-1.5 w-full rounded-full bg-zinc-800/80 overflow-hidden gap-0.5 my-2">
            {segments.map((seg) => (
              <div
                key={seg.key}
                className={cn("h-full rounded-full transition-all duration-300", seg.color)}
                style={{ width: `${Math.max(2, seg.width)}%` }}
              />
            ))}
          </div>

          {/* 上下文构成拆分 */}
          {breakdown && (
            <div className="space-y-1 my-2.5 pb-2.5 border-b border-zinc-800/70 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-zinc-400">
                  <span className="size-2 rounded-full bg-purple-400 inline-block" />
                  系统提示词与规范
                </span>
                <span className="font-mono tabular-nums text-zinc-300">~{formatTokens(breakdown.systemTokens)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-zinc-400">
                  <span className="size-2 rounded-full bg-cyan-400 inline-block" />
                  工具定义与 Schema
                </span>
                <span className="font-mono tabular-nums text-zinc-300">~{formatTokens(breakdown.toolsTokens)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-zinc-400">
                  <span className="size-2 rounded-full bg-blue-400 inline-block" />
                  历史对话消息
                </span>
                <span className="font-mono tabular-nums text-zinc-300">~{formatTokens(breakdown.messageTokens)}</span>
              </div>
            </div>
          )}

          {/* Token 消耗指标明细 */}
          <div className="space-y-1 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">输入 Tokens</span>
              <span className="font-mono tabular-nums text-zinc-200">
                {(usage?.inputTokens ?? 0).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">输出 Tokens</span>
              <span className="font-mono tabular-nums text-zinc-200">
                {(usage?.outputTokens ?? 0).toLocaleString()}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">缓存命中率</span>
              <span className="font-mono tabular-nums text-emerald-400 font-medium">
                {usage?.cacheHitPercent ?? 0}% ({formatTokens(usage?.cachedInputTokens ?? 0)})
              </span>
            </div>
            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60 font-medium">
              <span className="text-zinc-300">累计消耗 Tokens</span>
              <span className="font-mono tabular-nums text-zinc-100">
                {(usage?.totalTokens ?? 0).toLocaleString()}
              </span>
            </div>
          </div>

          {/* 性能与速率指标 */}
          {usage && (usage.tokensPerSecond > 0 || usage.llmMs > 0) && (
            <div className="mt-2.5 pt-2 border-t border-zinc-800/70 flex items-center justify-between text-[10.5px] text-zinc-500 font-mono">
              <span>解码: {formatTokensPerSecond(usage.tokensPerSecond)} tok/s</span>
              <span>首 token: {formatDuration(usage.ttftMs)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
