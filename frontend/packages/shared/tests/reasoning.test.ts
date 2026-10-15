import { describe, expect, it } from "vitest";
import {
  availableEffortsForModel,
  isTwoTierModel,
  normalizeEffort,
  resolveEffortForModel,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
} from "../src/reasoning.js";

describe("推理强度规范化", () => {
  it("普通模型提供三档", () => {
    expect(REASONING_EFFORTS).toEqual(["low", "medium", "high"]);
    expect(availableEffortsForModel("gpt-5")).toEqual(["low", "medium", "high"]);
  });

  it("默认档位是 medium", () => {
    expect(DEFAULT_REASONING_EFFORT).toBe("medium");
  });

  it("step-3.5-flash-2603 只提供 low 和 high", () => {
    expect(isTwoTierModel("step-3.5-flash-2603")).toBe(true);
    expect(availableEffortsForModel("step-3.5-flash-2603")).toEqual(["low", "high"]);
    expect(availableEffortsForModel("step-3.5-flash-2603")).not.toContain("medium");
  });

  it("其他模型不按两档处理", () => {
    expect(isTwoTierModel("step-3.5-flash-2604")).toBe(false);
    expect(isTwoTierModel("claude-sonnet-4-5")).toBe(false);
  });

  it("非法输入回落到默认档", () => {
    expect(normalizeEffort("ultra")).toBe("medium");
    expect(normalizeEffort(42)).toBe("medium");
    expect(normalizeEffort(undefined)).toBe("medium");
    expect(normalizeEffort(null)).toBe("medium");
    expect(normalizeEffort("low")).toBe("low");
  });

  it("两档模型上选择 medium 时回落到 low 并标记 fallback", () => {
    const result = resolveEffortForModel("step-3.5-flash-2603", "medium");
    expect(result.effort).toBe("low");
    expect(result.fallbackApplied).toBe(true);
    expect(result.supported).toEqual(["low", "high"]);
  });

  it("两档模型上选择 high 时不发生回落", () => {
    const result = resolveEffortForModel("step-3.5-flash-2603", "high");
    expect(result.effort).toBe("high");
    expect(result.fallbackApplied).toBe(false);
  });

  it("普通模型上任意合法档位都不回落", () => {
    for (const effort of REASONING_EFFORTS) {
      const result = resolveEffortForModel("gpt-5", effort);
      expect(result.effort).toBe(effort);
      expect(result.fallbackApplied).toBe(false);
    }
  });

  it("普通模型上传入非法值回落到 medium", () => {
    const result = resolveEffortForModel("gpt-5", "extreme");
    expect(result.effort).toBe("medium");
    expect(result.fallbackApplied).toBe(true);
  });
});
