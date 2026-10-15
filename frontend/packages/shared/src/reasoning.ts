/**
 * 推理强度（reasoning effort）类型与规范化逻辑。
 *
 * 约定：
 * - 普通模型提供 low / medium / high 三档。
 * - StepFun 的 step-3.5-flash-2603 仅提供 low / high 两档，
 *   选中该模型时必须隐藏或禁用 medium，禁止把 medium 当作有效参数下发。
 */

/** 推理强度档位。 */
export type ReasoningEffort = "low" | "medium" | "high";

/** 前端可选的推理强度集合（顺序即 UI 展示顺序）。 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

/** 默认推理强度。 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/** 只支持两档推理强度的模型 ID。 */
export const TWO_TIER_MODEL_IDS: readonly string[] = ["step-3.5-flash-2603"];

/** 判断某个模型是否只支持 low / high 两档。 */
export function isTwoTierModel(modelId: string): boolean {
  return TWO_TIER_MODEL_IDS.includes(modelId);
}

/** 取某个模型可用的推理强度档位。 */
export function availableEffortsForModel(modelId: string): readonly ReasoningEffort[] {
  return isTwoTierModel(modelId) ? ["low", "high"] : REASONING_EFFORTS;
}

/** 把任意输入规范化为合法推理强度；越界时回落到默认档。 */
export function normalizeEffort(value: unknown): ReasoningEffort {
  if (typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as ReasoningEffort;
  }
  return DEFAULT_REASONING_EFFORT;
}

/**
 * 按模型能力校验推理强度。
 *
 * 若所选档位在当前模型上不可用（包括传入值本身非法），返回该模型的
 * 最高可用档（两档模型回落 low，其余回落 medium），并告知调用方
 * 是否发生了回落，以便 UI 提示用户。
 */
export function resolveEffortForModel(
  modelId: string,
  effort: unknown,
): { effort: ReasoningEffort; fallbackApplied: boolean; supported: readonly ReasoningEffort[] } {
  const supported = availableEffortsForModel(modelId);
  const requestedValid =
    typeof effort === "string" && (REASONING_EFFORTS as readonly string[]).includes(effort);
  const normalized = normalizeEffort(effort);
  if (requestedValid && supported.includes(normalized)) {
    return { effort: normalized, fallbackApplied: false, supported };
  }
  const fallback = isTwoTierModel(modelId) ? "low" : DEFAULT_REASONING_EFFORT;
  return { effort: fallback, fallbackApplied: true, supported };
}
