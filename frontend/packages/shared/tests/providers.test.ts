import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URLS,
  maskApiKey,
  providerInputSchema,
  toPublicProvider,
  type ProviderConfig,
} from "../src/providers.js";

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "prov-1",
    type: "stepfun",
    label: "StepFun",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    apiKey: "sk-abcdef1234567890wxyz",
    models: ["step-3.5-flash-2603"],
    defaultModel: "step-3.5-flash-2603",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("密钥掩码", () => {
  it("只保留前后各 4 位", () => {
    expect(maskApiKey("sk-abcdef1234567890wxyz")).toBe("sk-a…wxyz");
  });

  it("短密钥全部打码", () => {
    expect(maskApiKey("short")).toBe("*****");
    expect(maskApiKey("")).toBe("");
  });

  it("掩码结果不包含完整密钥", () => {
    const key = "sk-abcdef1234567890wxyz";
    expect(maskApiKey(key)).not.toContain(key);
  });
});

describe("toPublicProvider", () => {
  it("不下发明文 API Key", () => {
    const config = makeConfig();
    const publicView = toPublicProvider(config);
    const serialized = JSON.stringify(publicView);
    expect(serialized).not.toContain(config.apiKey);
    expect(publicView.hasApiKey).toBe(true);
    expect(publicView.apiKeyMask).toBe("sk-a…wxyz");
  });

  it("未配置密钥时 hasApiKey 为 false", () => {
    const publicView = toPublicProvider(makeConfig({ apiKey: "" }));
    expect(publicView.hasApiKey).toBe(false);
    expect(publicView.apiKeyMask).toBe("");
  });

  it("保留模型与默认模型信息", () => {
    const publicView = toPublicProvider(makeConfig());
    expect(publicView.models).toEqual(["step-3.5-flash-2603"]);
    expect(publicView.defaultModel).toBe("step-3.5-flash-2603");
  });
});

describe("providerInputSchema", () => {
  const valid = {
    type: "stepfun" as const,
    label: "StepFun",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    apiKey: "sk-test-key",
    models: ["step-3.5-flash-2603"],
    defaultModel: "step-3.5-flash-2603",
    enabled: true,
  };

  it("接受合法配置", () => {
    const result = providerInputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("拒绝非 http(s) 的 Base URL", () => {
    const result = providerInputSchema.safeParse({ ...valid, baseUrl: "ftp://example.com" });
    expect(result.success).toBe(false);
  });

  it("拒绝包含空白字符的 Base URL", () => {
    const result = providerInputSchema.safeParse({ ...valid, baseUrl: "https://a.com/ x" });
    expect(result.success).toBe(false);
  });

  it("拒绝空 API Key", () => {
    const result = providerInputSchema.safeParse({ ...valid, apiKey: "" });
    expect(result.success).toBe(false);
  });

  it("拒绝空显示名称", () => {
    const result = providerInputSchema.safeParse({ ...valid, label: "   " });
    expect(result.success).toBe(false);
  });

  it("拒绝未知提供商类型", () => {
    const result = providerInputSchema.safeParse({ ...valid, type: "gemini" });
    expect(result.success).toBe(false);
  });

  it("models 与 enabled 有默认值", () => {
    const { models: _models, enabled: _enabled, ...rest } = valid;
    const result = providerInputSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models).toEqual([]);
      expect(result.data.enabled).toBe(true);
    }
  });
});

describe("默认 Base URL", () => {
  it("StepFun 默认指向 step_plan/v1", () => {
    expect(DEFAULT_BASE_URLS.stepfun).toBe("https://api.stepfun.com/step_plan/v1");
  });

  it("四种提供商类型都有默认值", () => {
    for (const key of ["stepfun", "openai", "anthropic", "openai-compatible"] as const) {
      expect(DEFAULT_BASE_URLS[key]).toMatch(/^https?:\/\//);
    }
  });
});
