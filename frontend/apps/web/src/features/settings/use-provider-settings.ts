/**
 * 提供商设置的客户端状态管理。
 *
 * 所有密钥操作都走服务端：前端只保存掩码摘要，从不持有明文密钥，
 * 也不写入 localStorage。
 */

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_BASE_URLS,
  type ProviderType,
  type PublicProvider,
  type ReasoningCapabilities,
  type ReasoningEffort,
} from "@deepagent/shared";

/** 模型列表获取结果（含失败分类）。 */
export interface ModelListOutcome {
  ok: boolean;
  models: string[];
  errorKind?: string;
  message?: string;
  hint?: string;
}

/** 连接测试结果。 */
export interface TestOutcome {
  ok: boolean;
  modelId?: string;
  latencyMs?: number;
  reply?: string;
  message?: string;
  effortApplied?: ReasoningEffort;
  effortField?: string | null;
  fallbackApplied?: boolean;
  supportedEfforts?: ReasoningEffort[];
  reasoningUnsupported?: boolean;
}

/** 新建/编辑表单的草稿。 */
export interface ProviderDraft {
  id?: string;
  type: ProviderType;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string | null;
  enabled: boolean;
  reasoningEfforts: ReasoningEffort[];
  reasoningUnsupported: boolean;
}

function draftFor(type: ProviderType, label: string): ProviderDraft {
  return {
    type,
    label,
    baseUrl: DEFAULT_BASE_URLS[type],
    apiKey: "",
    models: [],
    defaultModel: null,
    enabled: true,
    reasoningEfforts: ["low", "medium", "high"],
    reasoningUnsupported: false,
  };
}

export function useProviderSettings() {
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [effort, setEffort] = useState<ReasoningEffort>("medium");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/providers");
      if (!response.ok) throw new Error(`获取配置失败（HTTP ${response.status}）`);
      const body = (await response.json()) as { providers: PublicProvider[] };
      setProviders(body.providers);
      // 默认选中当前项（若仍存在）或第一个启用的提供商。
      setActiveProviderId((current) => {
        if (current && body.providers.some((provider) => provider.id === current)) return current;
        return body.providers.find((provider) => provider.enabled)?.id ?? null;
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载时从服务端拉一次配置：这是订阅外部系统，属于 effect 的正确用途。
  // setState 发生在 fetch 返回后的异步回调里，不是 effect body 的同步调用。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /** 当前选中的提供商。 */
  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? null;

  /** 当前选中的模型；未选时用提供商的默认模型。 */
  const currentModelId =
    activeModelId ?? activeProvider?.defaultModel ?? activeProvider?.models[0] ?? null;

  /**
   * 选择提供商：同时清空模型选择，让该提供商的默认模型生效。
   * 这里刻意不用 useEffect 同步（会触发级联渲染），而是在用户操作时一次做完。
   */
  const selectProvider = useCallback((id: string | null) => {
    setActiveProviderId(id);
    setActiveModelId(null);
  }, []);

  const save = useCallback(
    async (draft: ProviderDraft): Promise<{ ok: boolean; error?: string }> => {
      // 服务端要求 efforts 至少一项；用户把所有档位都取消勾选时回退到三档，
      // 否则保存会被 schema 校验直接拒绝（表现为「点了保存没反应」）。
      const efforts =
        draft.reasoningEfforts.length > 0
          ? draft.reasoningEfforts
          : (["low", "medium", "high"] as ReasoningEffort[]);
      const reasoning: ReasoningCapabilities = {
        efforts,
        ...(draft.reasoningUnsupported ? { unsupported: true } : {}),
      };
      const payload = {
        type: draft.type,
        label: draft.label.trim(),
        baseUrl: draft.baseUrl.trim(),
        models: draft.models,
        defaultModel: draft.defaultModel,
        enabled: draft.enabled,
        reasoning,
        // 新建时必须带密钥；编辑时留空表示保留原值。
        ...(draft.apiKey.trim().length > 0 ? { apiKey: draft.apiKey.trim() } : {}),
      };
      if (!draft.id && payload.apiKey === undefined) {
        return { ok: false, error: "请输入 API Key" };
      }
      try {
        const response = await fetch(
          draft.id ? `/api/providers/${encodeURIComponent(draft.id)}` : "/api/providers",
          {
            method: draft.id ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const body = (await response.json()) as { provider?: PublicProvider; issues?: Array<{ message: string }>; error?: string };
        if (!response.ok) {
          const issues = body.issues?.map((issue) => issue.message).join("；");
          return { ok: false, error: issues ?? body.error ?? "保存失败" };
        }
        await refresh();
        if (body.provider) setActiveProviderId(body.provider.id);
        return { ok: true };
      } catch (caught) {
        return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!response.ok) return false;
        await refresh();
        return true;
      } catch {
        return false;
      }
    },
    [refresh],
  );

  /** 通过服务端获取模型列表（不在浏览器里直连提供商）。 */
  const fetchModelList = useCallback(async (id: string): Promise<ModelListOutcome> => {
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(id)}/models`, {
        method: "POST",
      });
      const body = (await response.json()) as ModelListOutcome;
      if (body.ok) await refresh();
      return body;
    } catch (caught) {
      return {
        ok: false,
        models: [],
        errorKind: "network",
        message: "无法连接到本地服务端。",
        hint: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }, [refresh]);

  /** 测试指定模型的连接。 */
  const testConnection = useCallback(async (id: string, modelId?: string): Promise<TestOutcome> => {
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(id)}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modelId ? { modelId } : {}),
      });
      return (await response.json()) as TestOutcome;
    } catch (caught) {
      return { ok: false, message: caught instanceof Error ? caught.message : String(caught) };
    }
  }, []);

  /** 手动添加模型 ID（用于无法自动列出模型的提供商）。 */
  const addModel = useCallback(
    async (id: string, modelId: string): Promise<{ ok: boolean; error?: string }> => {
      const target = providers.find((provider) => provider.id === id);
      if (!target) return { ok: false, error: "提供商不存在" };
      const trimmed = modelId.trim();
      if (trimmed.length === 0) return { ok: false, error: "模型 ID 不能为空" };
      if (target.models.includes(trimmed)) return { ok: false, error: "该模型已存在" };
      try {
        const response = await fetch(`/api/providers/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: target.type,
            label: target.label,
            baseUrl: target.baseUrl,
            models: [...target.models, trimmed],
            defaultModel: target.defaultModel ?? trimmed,
            enabled: target.enabled,
            ...(target.reasoning ? { reasoning: target.reasoning } : {}),
          }),
        });
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          return { ok: false, error: body.error ?? "添加失败" };
        }
        await refresh();
        return { ok: true };
      } catch (caught) {
        return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
      }
    },
    [providers, refresh],
  );

  return {
    providers,
    loading,
    error,
    activeProvider,
    activeProviderId,
    setActiveProviderId: selectProvider,
    activeModelId,
    setActiveModelId,
    currentModelId,
    effort,
    setEffort,
    refresh,
    save,
    remove,
    fetchModelList,
    testConnection,
    addModel,
    draftFor,
  };
}
