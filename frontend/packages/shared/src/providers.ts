/**
 * 提供商配置的类型定义与 Zod 校验 schema。
 *
 * 安全约束：
 * - `apiKey` 只允许出现在服务端内存/配置文件中，绝不出现在返回给前端的
 *   载荷里（见 `toPublicProvider`）。
 * - 前端拿到的只有掩码摘要。
 */

import { z } from "zod";
import { REASONING_EFFORTS, type ReasoningEffort } from "./reasoning.js";

/** 受支持的提供商类型。 */
export const PROVIDER_TYPES = ["stepfun", "openai", "anthropic", "openai-compatible"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** 推理强度能力声明。 */
export interface ReasoningCapabilities {
  /** 该提供商实际支持的档位，顺序即 UI 顺序。 */
  efforts: ReasoningEffort[];
  /** 模型 ID → 该模型支持的档位；缺省视为使用 `efforts`。 */
  perModel?: Record<string, ReasoningEffort[]>;
  /** 为 true 时表示该提供商不暴露推理强度参数，UI 应提示设置会被忽略。 */
  unsupported?: boolean;
}

/** 单个提供商的配置（含明文密钥，仅服务端持有）。 */
export interface ProviderConfig {
  id: string;
  type: ProviderType;
  /** 用户自定义显示名。 */
  label: string;
  /** API Base URL。 */
  baseUrl: string;
  /** 明文 API Key，绝不外泄。 */
  apiKey: string;
  /** 手动维护的模型列表。 */
  models: string[];
  /** 当前默认模型 ID。 */
  defaultModel: string | null;
  /** 是否启用。 */
  enabled: boolean;
  /** 推理强度能力声明。 */
  reasoning?: ReasoningCapabilities;
  /** 创建/更新时间（ISO 字符串）。 */
  createdAt: string;
  updatedAt: string;
}

/** 返回给前端的提供商信息（密钥已掩码）。 */
export interface PublicProvider {
  id: string;
  type: ProviderType;
  label: string;
  baseUrl: string;
  /** 是否已配置密钥。 */
  hasApiKey: boolean;
  /** 掩码摘要，例如 `sk-abcd…wxyz`；未配置时为空串。 */
  apiKeyMask: string;
  models: string[];
  defaultModel: string | null;
  enabled: boolean;
  reasoning?: ReasoningCapabilities;
  createdAt: string;
  updatedAt: string;
}

/** 掩码 API Key：只保留前 4 位与后 4 位。 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 8) return `${"*".repeat(trimmed.length)}`;
  return `${trimmed.slice(0, 4)}${"…"}${trimmed.slice(-4)}`;
}

/** 把内部配置转换为可安全下发前端的载荷。 */
export function toPublicProvider(config: ProviderConfig): PublicProvider {
  return {
    id: config.id,
    type: config.type,
    label: config.label,
    baseUrl: config.baseUrl,
    hasApiKey: config.apiKey.trim().length > 0,
    apiKeyMask: maskApiKey(config.apiKey),
    models: config.models,
    defaultModel: config.defaultModel,
    enabled: config.enabled,
    ...(config.reasoning ? { reasoning: config.reasoning } : {}),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

/** 推理强度能力 schema。 */
export const reasoningCapabilitiesSchema = z.object({
  efforts: z.array(z.enum(REASONING_EFFORTS)).min(1, "至少选择一个推理强度档位"),
  perModel: z
    .record(z.string(), z.array(z.enum(REASONING_EFFORTS)).min(1, "至少选择一个推理强度档位"))
    .optional(),
  unsupported: z.boolean().optional(),
});

/** 新增/更新提供商的请求体 schema。 */
export const providerInputSchema = z.object({
  type: z.enum(PROVIDER_TYPES, { message: "请选择受支持的提供商类型" }),
  label: z
    .string({ message: "请输入显示名称" })
    .trim()
    .min(1, "显示名称不能为空")
    .max(64, "显示名称不能超过 64 个字符"),
  baseUrl: z
    .string({ message: "请输入 API Base URL" })
    .trim()
    .min(1, "API Base URL 不能为空")
    .refine((value) => /^https?:\/\//i.test(value), "Base URL 必须以 http:// 或 https:// 开头")
    .refine((value) => !/\s/.test(value), "Base URL 不能包含空白字符"),
  apiKey: z.string({ message: "请输入 API Key" }).min(1, "API Key 不能为空"),
  models: z.array(z.string().trim().min(1, "模型 ID 不能为空")).default([]),
  defaultModel: z.string().trim().min(1, "默认模型 ID 不能为空").nullable().default(null),
  enabled: z.boolean().default(true),
  reasoning: reasoningCapabilitiesSchema.optional(),
});

/** 更新提供商时允许的字段（apiKey 可省略以保留原值）。 */
export const providerUpdateSchema = providerInputSchema.partial({ apiKey: true });

export type ProviderInput = z.infer<typeof providerInputSchema>;
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

/** 各提供商的默认 Base URL。 */
export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  stepfun: "https://api.stepfun.com/step_plan/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  "openai-compatible": "http://127.0.0.1:11434/v1",
};

/**
 * 已知模型前缀的上下文窗口参考值（Token 数）。
 *
 * 官方模型列表接口普遍不返回上下文窗口，这里只能按模型家族给出
 * 常用的公开参考值；UI 需标注「约」。未命中的模型返回 null，前端显示「—」。
 */
const CONTEXT_WINDOW_PREFIXES: Array<[string, number]> = [
  ["claude", 200_000],
  ["gpt-5", 400_000],
  ["gpt-4.1", 1_000_000],
  ["gpt-4o", 128_000],
  ["gpt-4", 128_000],
  ["o3", 200_000],
  ["o4", 200_000],
  ["o1", 200_000],
  ["gemini", 1_000_000],
  ["deepseek", 131_072],
  ["qwen", 131_072],
  ["kimi", 256_000],
  ["glm", 128_000],
  ["step", 128_000],
  ["doubao", 256_000],
  ["minimax", 1_000_000],
];

/**
 * 按模型 ID 前缀解析上下文窗口参考值；未识别的模型返回 null。
 *
 * 匹配规则：先剥掉 `provider/model` 形式的命名空间前缀，再用
 * startsWith 精确匹配家族前缀，避免子串误命中（例如把
 * `my-gpt-4-proxy` 误判为 GPT-4 家族）。
 */
export function resolveContextWindow(modelId: string | null | undefined): number | null {
  if (!modelId) return null;
  const bare = (modelId.split("/").pop() ?? modelId).toLowerCase();
  for (const [prefix, window] of CONTEXT_WINDOW_PREFIXES) {
    if (bare.startsWith(prefix)) return window;
  }
  return null;
}
