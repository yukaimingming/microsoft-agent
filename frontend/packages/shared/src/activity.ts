/**
 * 前端活动时间线与运行状态共用的类型。
 *
 * 这些类型与 AG-UI 事件解耦：前端只依赖这里的稳定结构，
 * 服务端负责把 Deep Agents 的内部事件映射成这些卡片。
 */

import type { FileDiff } from "./diff.js";

/** 卡片类型。 */
export type ActivityKind =
  | "todo"
  | "tool"
  | "subagent"
  | "file"
  | "approval"
  | "answer"
  | "error";

/** 卡片生命周期状态。 */
export type ActivityStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

/** 一条活动记录（所有卡片共用外层结构）。 */
export interface Activity {
  /** 稳定 ID，同一 ID 的事件只会更新同一张卡片。 */
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  title: string;
  /** 卡片副标题或简要说明。 */
  subtitle?: string;
  /** 结构化详情，按 kind 解释。 */
  detail?: unknown;
  /** 产生这张卡片的运行 ID，前端用它把工具卡片归属到正确的回复轮次。 */
  runId?: string;
  /** 开始时间（毫秒时间戳）。 */
  startedAt: number;
  /** 结束时间（毫秒时间戳）。 */
  endedAt?: number;
  /** 耗时（毫秒），可获取时填充。 */
  durationMs?: number;
  /** 错误信息。 */
  error?: string;
}

/** Todo 卡片详情。 */
export interface TodoDetail {
  items: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  /** 已完成条数。 */
  completed: number;
  total: number;
}

/** 工具调用卡片详情。 */
export interface ToolDetail {
  toolName: string;
  /** 输入参数摘要（已截断）。 */
  input?: unknown;
  /** 输出结果摘要（已截断）。 */
  output?: unknown;
  /** 输出是否被截断。 */
  truncated?: boolean;
}

/** 子 Agent 卡片详情。 */
export interface SubagentDetail {
  name: string;
  /** 子任务目标。 */
  goal?: string;
  /** 结果摘要。 */
  resultSummary?: string;
}

/** 文件活动卡片详情。 */
export interface FileDetail {
  path: string;
  operation: "read" | "write" | "edit" | "delete" | "list" | "grep" | "glob";
  /** 写入/修改/删除操作的内容差异（只读操作没有）。 */
  diff?: FileDiff;
}

/** 人工审批卡片详情。 */
export interface ApprovalDetail {
  /** 待批准的工具名。 */
  toolName: string;
  /** 工具参数。 */
  args?: unknown;
  /** 影响范围说明。 */
  impact?: string;
  /** 允许的决策。 */
  allowedDecisions: Array<"approve" | "edit" | "reject">;
  /** 处理结果。 */
  decision?: "approve" | "edit" | "reject";
}

/** 运行状态。 */
export type RunStatus =
  | "idle"
  | "connecting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "cancelled"
  | "error";

/** 前端运行快照（由 AG-UI 客户端订阅维护）。 */
/** 单次运行的 Token 用量统计（来自模型返回的 usage_metadata 汇总）。 */
export interface RunTokenUsage {
  /** 累计输入 Token（全部模型调用之和）。 */
  inputTokens: number;
  /** 累计输出 Token。 */
  outputTokens: number;
  /** 累计总 Token。 */
  totalTokens: number;
  /** 命中缓存的输入 Token（提示词缓存）。 */
  cachedInputTokens: number;
  /** 最后一次模型调用的输入 Token，近似当前上下文占用。 */
  lastInputTokens: number;
  /** 模型上下文窗口大小（Token 数），未知为 null（前端显示参考值说明）。 */
  contextWindow: number | null;
}

export interface RunSnapshot {
  status: RunStatus;
  runId: string | null;
  threadId: string | null;
  /** 当前任务从首次发起到结束的墙钟时间戳与用时。 */
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  /** 面向用户的公开进度摘要，不含原始思维链。 */
  progressNote: string | null;
  /** 待人工审批的中断列表。 */
  interrupts: Array<{
    id: string;
    reason: string;
    message?: string;
    toolName?: string;
    args?: unknown;
    allowedDecisions: Array<"approve" | "edit" | "reject">;
  }>;
  error: string | null;
  /** 本次运行的 Token 用量（运行结束/进入等待审批时下发）。 */
  usage?: RunTokenUsage;
}

/** 大文本截断工具：限制前端展示长度，保留完整内容的查看入口。 */
export const MAX_INLINE_TEXT = 4000;

export function truncateText(text: string, limit = MAX_INLINE_TEXT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n…（已截断，完整内容共 ${text.length} 字符）`, truncated: true };
}

/** 安全序列化任意值为可展示字符串。 */
export function safeStringify(value: unknown, limit = MAX_INLINE_TEXT): { text: string; truncated: boolean } {
  if (value === undefined) return { text: "", truncated: false };
  if (typeof value === "string") return truncateText(value, limit);
  try {
    return truncateText(JSON.stringify(value, null, 2), limit);
  } catch {
    return truncateText(String(value), limit);
  }
}
