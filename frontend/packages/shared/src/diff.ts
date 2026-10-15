/**
 * 纯文本行级 Diff 计算（无第三方依赖）。
 *
 * 服务端在文件写入/修改/删除前后各取一次内容，交给这里算出
 * 统计（+新增 / −删除行数）与 unified 风格 patch 文本，
 * 随文件活动卡片下发，前端直接渲染。
 */

export interface FileDiff {
  /** 新增行数。 */
  additions: number;
  /** 删除行数。 */
  deletions: number;
  /** unified 风格 patch：`@@` hunk 头 + `+`/`-`/` `(上下文) 行前缀。 */
  patch: string;
  /** patch 超出上限被截断时为 true。 */
  truncated: boolean;
}

/** LCS 行 diff 的规模上限：超过则退化为「整段替换」粗粒度结果，避免 O(n·m) 爆内存。 */
const MAX_LCS_LINES = 1200;
/** patch 文本的最大行数。 */
const DEFAULT_MAX_PATCH_LINES = 400;
/** hunk 上下文行数。 */
const CONTEXT_LINES = 3;

type Op = { type: "equal" | "add" | "remove"; line: string };

/**
 * 计算两个文本（null 表示文件不存在）之间的行级差异。
 *
 * - 双方都为 null：零差异。
 * - 一方为 null：整文件新增或整文件删除。
 */
export function computeFileDiff(
  before: string | null,
  after: string | null,
  maxPatchLines: number = DEFAULT_MAX_PATCH_LINES,
): FileDiff {
  if (before === null && after === null) {
    return { additions: 0, deletions: 0, patch: "", truncated: false };
  }
  const beforeLines = before === null ? [] : before.split("\n");
  const afterLines = after === null ? [] : after.split("\n");

  const ops = diffLines(beforeLines, afterLines);
  const additions = ops.filter((op) => op.type === "add").length;
  const deletions = ops.filter((op) => op.type === "remove").length;

  const { patch, truncated } = buildPatch(beforeLines, afterLines, ops, maxPatchLines);
  return { additions, deletions, patch, truncated };
}

/** 前缀/后缀裁剪 + 受规模约束的 LCS 行 diff。 */
function diffLines(before: string[], after: string[]): Op[] {
  // 1. 裁掉公共前缀与后缀，中间部分才需要真正的 diff。
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "equal", line: before[i]! });

  const midB = before.slice(start, endB);
  const midA = after.slice(start, endA);
  if (midB.length > MAX_LCS_LINES || midA.length > MAX_LCS_LINES) {
    // 规模超限：中间段整体按「删旧加新」处理，统计仍然准确。
    for (const line of midB) ops.push({ type: "remove", line });
    for (const line of midA) ops.push({ type: "add", line });
  } else {
    ops.push(...lcsOps(midB, midA));
  }

  for (let i = endB; i < before.length; i++) ops.push({ type: "equal", line: before[i]! });
  return ops;
}

/** 经典 LCS 动态规划（输入已保证规模受控）。 */
function lcsOps(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  // dp[i][j] = before[i..] 与 after[j..] 的最长公共子序列长度。
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = before[i] === after[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: "equal", line: before[i]! });
      i++;
      j++;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      ops.push({ type: "remove", line: before[i]! });
      i++;
    } else {
      ops.push({ type: "add", line: after[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "remove", line: before[i++]! });
  while (j < m) ops.push({ type: "add", line: after[j++]! });
  return ops;
}

/** 把 op 序列组装成带 hunk 头的 unified 风格 patch，超行截断。 */
function buildPatch(
  before: string[],
  after: string[],
  ops: Op[],
  maxPatchLines: number,
): { patch: string; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;

  // 先定位每个 op 在原文件中的行号，供 hunk 头使用。
  let bLine = 0;
  let aLine = 0;
  const entries = ops.map((op) => {
    const entry = { op, b: bLine, a: aLine };
    if (op.type === "equal") {
      bLine++;
      aLine++;
    } else if (op.type === "remove") {
      bLine++;
    } else {
      aLine++;
    }
    return entry;
  });

  // 按「变更簇 + 上下文」切 hunk：相邻变更（间隔 ≤ 2*上下文）合并为同一个 hunk。
  const changedIdx = entries
    .map((e, idx) => (e.op.type !== "equal" ? idx : -1))
    .filter((idx) => idx >= 0);
  if (changedIdx.length === 0) return { patch: "", truncated: false };

  const ranges: Array<[number, number]> = [];
  let curStart = -1;
  let curEnd = -1;
  for (const idx of changedIdx) {
    const from = Math.max(0, idx - CONTEXT_LINES);
    const to = Math.min(entries.length - 1, idx + CONTEXT_LINES);
    if (curEnd !== -1 && from > curEnd + 1) {
      ranges.push([curStart, curEnd]);
      curStart = -1;
      curEnd = -1;
    }
    if (curStart === -1) curStart = from;
    curEnd = Math.max(curEnd, to);
  }
  if (curStart !== -1) ranges.push([curStart, curEnd]);

  for (const [from, to] of ranges) {
    const hunk = entries.slice(from, to + 1);
    const bStart = hunk[0]!.b + 1;
    const aStart = hunk[0]!.a + 1;
    const bCount = hunk.filter((e) => e.op.type !== "add").length;
    const aCount = hunk.filter((e) => e.op.type !== "remove").length;
    const header = `@@ -${bStart},${bCount} +${aStart},${aCount} @@`;
    if (lines.length + hunk.length + 1 > maxPatchLines) {
      truncated = true;
      break;
    }
    lines.push(header);
    for (const e of hunk) {
      const prefix = e.op.type === "add" ? "+" : e.op.type === "remove" ? "-" : " ";
      lines.push(prefix + e.op.line);
    }
  }
  return { patch: lines.join("\n"), truncated };
}
