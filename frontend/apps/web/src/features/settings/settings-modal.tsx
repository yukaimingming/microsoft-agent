/**
 * 模型与提供商设置弹窗。
 *
 * 严格按照用户需求重构：
 * 1. 颜色与主界面完全统一（纯黑底色 bg-[#09090b]、深灰边框 border-zinc-800、白色高亮 text-zinc-100）。
 * 2. 支持自定义添加任意模型厂商（不固定死，用户可自由输入厂商名称、Base URL、API Key 与兼容协议）。
 * 3. 获取模型后支持“一键全部添加/导入”到可用模型列表中，并支持自由切换默认模型与删除不需要的模型。
 * 4. 密钥掩码保存，安全合规，绝不外泄。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  REASONING_EFFORTS,
  isTwoTierModel,
  type ProviderType,
  type PublicProvider,
} from "@deepagent/shared";
import { Modal } from "../../components/modal.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import type { ModelListOutcome, ProviderDraft, TestOutcome } from "./use-provider-settings.js";
import {
  PlusIcon,
  Trash2Icon,
  CheckIcon,
  RefreshCwIcon,
  SunIcon,
  MoonIcon,
  ChevronUpIcon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";

const TYPE_LABEL: Record<ProviderType, string> = {
  stepfun: "StepFun（OpenAI 兼容）",
  openai: "OpenAI 官方协议",
  anthropic: "Anthropic 原生协议",
  "openai-compatible": "OpenAI 兼容协议（自定义厂商）",
};

/** 新增配置仅提供 OpenAI 协议及兼容实现；保留已有 Anthropic 配置。 */
const CONFIGURABLE_PROTOCOL_TYPES: ProviderType[] = ["openai", "stepfun", "openai-compatible"];

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  providers: PublicProvider[];
  loading: boolean;
  onSave: (draft: ProviderDraft) => Promise<{ ok: boolean; error?: string }>;
  onRemove: (id: string) => Promise<boolean>;
  onFetchModels: (id: string) => Promise<ModelListOutcome>;
  onTest: (id: string, modelId?: string) => Promise<TestOutcome>;
  onAddModel: (id: string, modelId: string) => Promise<{ ok: boolean; error?: string }>;
  draftFor: (type: ProviderType, label: string) => ProviderDraft;
  activeProviderId: string | null;
  onSelectProvider: (id: string | null) => void;
  /** 当前外观主题 */
  theme?: "dark" | "light";
  /** 切换外观主题 */
  onThemeChange?: (theme: "dark" | "light") => void;
}

export function SettingsModal(props: SettingsModalProps) {
  const { open, onClose } = props;

  return (
    <Modal open={open} onClose={onClose} title="设置" width="lg">
      {open ? (
        <SettingsForm
          key={props.activeProviderId ?? "__new__"}
          providers={props.providers}
          activeProviderId={props.activeProviderId}
          onSelectProvider={props.onSelectProvider}
          onSave={props.onSave}
          onRemove={props.onRemove}
          onFetchModels={props.onFetchModels}
          onTest={props.onTest}
          onAddModel={props.onAddModel}
          draftFor={props.draftFor}
          theme={props.theme}
          onThemeChange={props.onThemeChange}
        />
      ) : null}
    </Modal>
  );
}

function draftFromProvider(provider: PublicProvider): ProviderDraft {
  return {
    id: provider.id,
    type: provider.type,
    label: provider.label,
    baseUrl: provider.baseUrl,
    apiKey: "",
    models: [...provider.models],
    defaultModel: provider.defaultModel,
    enabled: provider.enabled,
    reasoningEfforts: provider.reasoning?.efforts ?? ["low", "medium", "high"],
    reasoningUnsupported: provider.reasoning?.unsupported ?? false,
  };
}

/** 设置表单本体 */
function SettingsForm(props: Omit<SettingsModalProps, "open" | "onClose" | "loading">) {
  const { providers, theme = "dark", onThemeChange } = props;

  // 外观上拉菜单状态
  const [isThemeOpen, setIsThemeOpen] = useState(false);
  const themeDropdownRef = useRef<HTMLDivElement>(null);
  /** 上次自动获取模型列表的厂商 + Base URL，用于检测变更并防抖自动拉取。 */
  const lastAutoFetchRef = useRef<{ id: string; baseUrl: string } | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (themeDropdownRef.current && !themeDropdownRef.current.contains(e.target as Node)) {
        setIsThemeOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const [draft, setDraft] = useState<ProviderDraft>(() => {
    if (props.activeProviderId) {
      const found = providers.find((p) => p.id === props.activeProviderId);
      if (found) return draftFromProvider(found);
    }
    // 默认展示一个自定义 OpenAI 兼容草稿
    return props.draftFor("openai-compatible", "自定义模型厂商");
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modelError, setModelError] = useState<ModelListOutcome | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [manualModel, setManualModel] = useState("");

  const isEditing = draft.id !== undefined;

  // 开始创建新厂商（无论是预设还是自定义）
  const startCreate = (type: ProviderType = "openai-compatible", defaultLabel = "自定义模型厂商") => {
    setError(null);
    setNotice(null);
    setModelError(null);
    setTestResult(null);
    setDraft(props.draftFor(type, defaultLabel));
    props.onSelectProvider(null);
  };

  const selectProvider = (id: string) => {
    const found = providers.find((p) => p.id === id);
    if (found) {
      setDraft(draftFromProvider(found));
      props.onSelectProvider(id);
      setError(null);
      setNotice(null);
      setModelError(null);
      setTestResult(null);
    }
  };

  const handleSave = async () => {
    if (!draft.label.trim()) {
      setError("请输入厂商显示名称");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const result = await props.onSave(draft);
    setSaving(false);
    if (result.ok) {
      setNotice(isEditing ? "配置已成功更新" : "新厂商配置已成功保存");
      setDraft({ ...draft, apiKey: "" });
      // Key/配置变更后自动刷新一次模型列表（AGENTS.md 9.2：填写 Base URL
      // 和 Key 后在可安全获取时自动刷新）。失败不阻断保存流程。
      if (draft.id) {
        void handleFetchModels();
      }
    } else {
      setError(result.error ?? "保存失败");
    }
  };

  const handleFetchModels = async () => {
    if (!draft?.id) {
      setModelError({
        ok: false,
        models: [],
        errorKind: "unsaved",
        message: "请先保存当前厂商配置，再获取远程模型列表。",
        hint: "保存后本地后端会安全调用该提供商的接口获取模型列表。",
      });
      return;
    }
    setFetchingModels(true);
    setModelError(null);
    const result = await props.onFetchModels(draft.id);
    setFetchingModels(false);
    if (!result.ok) {
      setModelError(result);
      return;
    }
    // 自动将获取到的所有模型批量添加到列表
    const merged = Array.from(new Set([...draft.models, ...result.models]));
    setDraft({
      ...draft,
      models: merged,
      defaultModel: draft.defaultModel ?? result.models[0] ?? null,
    });
    setNotice(`成功获取到 ${result.models.length} 个模型并全部导入列表`);
  };

  // Base URL 变更后防抖自动获取模型列表：仅对已保存厂商生效（服务端用
  // 已存密钥调用其 /models 接口）；首次渲染只记录基线，不触发请求。
  useEffect(() => {
    const providerId = draft?.id;
    if (!providerId) return;
    const baseUrl = draft.baseUrl.trim();
    if (!/^https?:\/\//i.test(baseUrl)) return;
    const last = lastAutoFetchRef.current;
    if (!last) {
      lastAutoFetchRef.current = { id: providerId, baseUrl };
      return;
    }
    if (last.id === providerId && last.baseUrl === baseUrl) return;
    const timer = setTimeout(() => {
      lastAutoFetchRef.current = { id: providerId, baseUrl };
      void handleFetchModels();
    }, 1200);
    return () => clearTimeout(timer);
    // handleFetchModels 闭包里的 draft 随渲染更新，这里只依赖触发条件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, draft?.baseUrl]);

  const handleAddModel = async () => {
    const trimmed = manualModel.trim();
    if (!trimmed) return;
    if (draft.models.includes(trimmed)) {
      setModelError({
        ok: false,
        models: [],
        errorKind: "duplicate",
        message: "该模型 ID 已在列表中。",
      });
      return;
    }
    setDraft({
      ...draft,
      models: [...draft.models, trimmed],
      defaultModel: draft.defaultModel ?? trimmed,
    });
    setManualModel("");
    if (draft.id) {
      await props.onAddModel(draft.id, trimmed);
    }
  };

  const handleRemoveSingleModel = (modelToRemove: string) => {
    const remaining = draft.models.filter((m) => m !== modelToRemove);
    setDraft({
      ...draft,
      models: remaining,
      defaultModel: draft.defaultModel === modelToRemove ? remaining[0] ?? null : draft.defaultModel,
    });
  };

  const handleTest = async () => {
    if (!draft?.id) {
      setTestResult({ ok: false, message: "请先保存配置，再测试连接。" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const result = await props.onTest(draft.id, draft.defaultModel ?? draft.models[0]);
    setTesting(false);
    setTestResult(result);
  };

  const handleRemove = async (id: string) => {
    if (!confirm("确定要删除此模型提供商吗？")) return;
    const ok = await props.onRemove(id);
    if (ok) {
      setNotice("配置已删除");
      setDraft(props.draftFor("openai-compatible", "自定义模型厂商"));
      props.onSelectProvider(null);
    } else {
      setError("删除失败");
    }
  };

  const twoTierHint = useMemo(() => {
    if (draft.type !== "stepfun") return null;
    if (!draft.defaultModel || !isTwoTierModel(draft.defaultModel)) return null;
    return "提示：模型 step-3.5-flash-2603 仅支持 low 和 high 两档，medium 已被自动禁用。";
  }, [draft]);

  return (
    <div className="grid grid-cols-[200px_1fr] gap-6 text-zinc-200">
      {/* ================= 左侧：厂商列表与新增按钮 ================= */}
      <div className="flex flex-col border-r border-zinc-800/80 pr-4 space-y-4">
        {/* 新增自定义厂商主按钮 */}
        <button
          type="button"
          onClick={() => startCreate("openai-compatible", "自定义模型厂商")}
          className="flex items-center justify-center gap-1.5 w-full py-2 px-3 rounded-lg bg-zinc-100 hover:bg-white text-black text-[12.5px] font-medium transition-colors shadow-xs"
        >
          <PlusIcon className="size-3.5 stroke-[2.5]" />
          <span>添加自定义厂商</span>
        </button>

        {/* 已配置的厂商列表 */}
        <div className="space-y-1">
          <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">已配置厂商</p>
          {providers.length === 0 ? (
            <p className="px-2 py-2 text-[12px] text-zinc-500">暂未配置厂商</p>
          ) : (
            providers.map((p) => {
              const isSelected = draft.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => selectProvider(p.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors border ${
                    isSelected
                      ? "bg-zinc-800 border-zinc-700 text-white font-medium"
                      : "bg-transparent border-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  }`}
                >
                  <span className="truncate">{p.label}</span>
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      p.enabled ? "bg-emerald-400" : "bg-zinc-600"
                    }`}
                    title={p.enabled ? "已启用" : "已停用"}
                  />
                </button>
              );
            })
          )}
        </div>

        {/* 预设快捷模板 */}
        <div className="pt-2 border-t border-zinc-800/60 space-y-1">
          <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">快速模板</p>
          {CONFIGURABLE_PROTOCOL_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => startCreate(type, TYPE_LABEL[type])}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
            >
              <PlusIcon className="size-3 text-zinc-500" />
              <span>{TYPE_LABEL[type]}</span>
            </button>
          ))}
        </div>

        {/* 外观上拉选择（向上弹出切换浅色/深色背景） */}
        <div className="pt-3 border-t border-zinc-800/60 relative mt-auto" ref={themeDropdownRef}>
          <label className="block mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            外观
          </label>
          <div className="relative">
            <button
              type="button"
              data-testid="appearance-dropup-btn"
              onClick={() => setIsThemeOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[12.5px] text-zinc-200 hover:border-zinc-700 transition-colors"
              title="切换外观背景颜色"
            >
              <div className="flex items-center gap-2">
                {theme === "light" ? (
                  <SunIcon className="size-3.5 text-amber-400" />
                ) : (
                  <MoonIcon className="size-3.5 text-blue-400" />
                )}
                <span>{theme === "light" ? "浅色" : "深色"}</span>
              </div>
              <ChevronUpIcon
                className={cn(
                  "size-3.5 text-zinc-500 transition-transform duration-150",
                  isThemeOpen && "rotate-180 text-zinc-200",
                )}
              />
            </button>

            {/* 上拉选择菜单（向上弹出） */}
            {isThemeOpen && (
              <div
                data-testid="appearance-dropup-menu"
                className="absolute bottom-full mb-1 left-0 z-50 w-full rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-2xl animate-in fade-in zoom-in-95 duration-100"
              >
                <button
                  type="button"
                  data-testid="theme-option-dark"
                  onClick={() => {
                    onThemeChange?.("dark");
                    setIsThemeOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-2 py-1.5 text-[12px] transition-colors",
                    theme === "dark"
                      ? "bg-zinc-800 text-white font-medium"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <MoonIcon className="size-3.5 text-blue-400" />
                    <span>深色</span>
                  </div>
                  {theme === "dark" && <CheckIcon className="size-3 text-emerald-400" />}
                </button>
                <button
                  type="button"
                  data-testid="theme-option-light"
                  onClick={() => {
                    onThemeChange?.("light");
                    setIsThemeOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between rounded px-2 py-1.5 text-[12px] transition-colors",
                    theme === "light"
                      ? "bg-zinc-800 text-white font-medium"
                      : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <SunIcon className="size-3.5 text-amber-400" />
                    <span>浅色</span>
                  </div>
                  {theme === "light" && <CheckIcon className="size-3 text-emerald-400" />}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ================= 右侧：厂商详细配置表单 ================= */}
      <div className="space-y-4 max-h-[500px] overflow-y-auto pr-1">
        {/* 顶部标题与当前编辑状态 */}
        <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80">
          <div>
            <h3 className="text-[14px] font-semibold text-zinc-100">{draft.label || "配置厂商"}</h3>
            <p className="text-[11.5px] text-zinc-500">
              {isEditing ? `编辑已有配置（ID: ${draft.id}）` : "正在添加新的模型提供商"}
            </p>
          </div>
          {isEditing && (
            <button
              type="button"
              onClick={() => draft.id && void handleRemove(draft.id)}
              className="flex items-center gap-1 text-[12px] text-rose-400 hover:text-rose-300 transition-colors p-1 rounded"
              title="删除此提供商"
            >
              <Trash2Icon className="size-3.5" />
              <span>删除</span>
            </button>
          )}
        </div>

        {/* 厂商名称与协议类型 */}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[11.5px] text-zinc-400">厂商显示名称 (Label)</span>
            <input
              type="text"
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="如：DeepSeek / SiliconFlow / 本地 Ollama"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900/90 px-3 py-1.5 text-[12.5px] text-zinc-100 outline-none focus:border-zinc-600"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11.5px] text-zinc-400">API 协议</span>
            <Select
              value={draft.type}
              onValueChange={(value) => {
                const type = value as ProviderType;
                setDraft({
                  ...draft,
                  type,
                  baseUrl: props.draftFor(type, draft.label).baseUrl,
                });
              }}
            >
              <SelectTrigger className="h-[31px] w-full rounded-md border-zinc-800 bg-zinc-900/90 px-2.5 text-[12.5px] text-zinc-100 shadow-none hover:border-zinc-700 focus-visible:border-zinc-600 focus-visible:ring-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
                {CONFIGURABLE_PROTOCOL_TYPES.map((type) => (
                  <SelectItem key={type} value={type} className="text-[12.5px] focus:bg-zinc-800 focus:text-white">
                    {TYPE_LABEL[type]}
                  </SelectItem>
                ))}
                {draft.type === "anthropic" && (
                  <SelectItem value="anthropic" className="text-[12.5px] focus:bg-zinc-800 focus:text-white">
                    {TYPE_LABEL.anthropic}（已有配置）
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </label>
        </div>

        {/* API Base URL */}
        <label className="block">
          <span className="mb-1 block text-[11.5px] text-zinc-400">API Base URL</span>
          <input
            type="url"
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            placeholder="https://api.example.com/v1"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900/90 px-3 py-1.5 font-mono text-[12px] text-zinc-100 outline-none focus:border-zinc-600"
          />
        </label>

        {/* API Key */}
        <label className="block">
          <span className="mb-1 block text-[11.5px] text-zinc-400">
            API Key {isEditing ? "（留空表示保留当前已配置密钥）" : ""}
          </span>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder={isEditing ? "••••••••（已加密安全保存）" : "输入 sk- 开头的 API Key..."}
            autoComplete="off"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900/90 px-3 py-1.5 font-mono text-[12px] text-zinc-100 outline-none focus:border-zinc-600"
          />
          <span className="mt-1 block text-[11px] text-zinc-500">
            安全保障：API Key 仅保存在本地服务端，前端只保留掩码，绝不进入浏览器存储或对外泄露。
          </span>
        </label>

        {/* ================= 模型列表管理与一键全量导入 ================= */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-2.5 settings-models-box">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-medium text-zinc-300 settings-models-label">
              可用模型列表 ({draft.models.length})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleFetchModels()}
                disabled={fetchingModels}
                className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/80 px-2.5 py-1 text-[11.5px] text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-50 settings-fetch-models-btn"
              >
                <RefreshCwIcon className={`size-3 ${fetchingModels ? "animate-spin" : ""}`} />
                <span>{fetchingModels ? "正在查询..." : "获取远程模型列表"}</span>
              </button>
            </div>
          </div>

          {/* 模型列表呈现 */}
          {draft.models.length > 0 ? (
            <div className="max-h-36 overflow-y-auto space-y-1 rounded border border-zinc-800/80 bg-black/60 p-2 settings-model-list-scroll">
              {draft.models.map((model) => {
                const isDefault = draft.defaultModel === model;
                return (
                  <div
                    key={model}
                    className={`flex items-center justify-between gap-2 px-2.5 py-1 rounded text-[12px] transition-colors settings-model-item ${
                      isDefault ? "bg-zinc-800 text-white is-default" : "text-zinc-300 hover:bg-zinc-900"
                    }`}
                  >
                    <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                      <input
                        type="radio"
                        name="default-model"
                        checked={isDefault}
                        onChange={() => setDraft({ ...draft, defaultModel: model })}
                        className="accent-white"
                      />
                      <span className="font-mono truncate">{model}</span>
                      {isDefault && (
                        <span className="text-[10.5px] bg-zinc-700 px-1.5 py-0.2 rounded text-zinc-200 shrink-0 settings-default-badge">
                          默认模型
                        </span>
                      )}
                    </label>

                    <button
                      type="button"
                      onClick={() => handleRemoveSingleModel(model)}
                      className="p-0.5 text-zinc-500 hover:text-rose-400 rounded transition-colors"
                      title="移除此模型"
                    >
                      <Trash2Icon className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded border border-zinc-800/80 bg-black/40 px-3 py-2 text-[12px] text-zinc-500 settings-model-empty">
              当前暂未添加任何模型。可点击上方「获取远程模型列表」或在下方手动添加。
            </p>
          )}

          {/* 手动追加模型 */}
          <div className="flex gap-2">
            <input
              type="text"
              value={manualModel}
              onChange={(e) => setManualModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleAddModel();
                }
              }}
              placeholder="输入模型 ID，如 deepseek-chat, gpt-4o 等"
              className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[12px] text-zinc-200 outline-none focus:border-zinc-600 settings-input"
            />
            <button
              type="button"
              onClick={() => void handleAddModel()}
              disabled={!manualModel.trim()}
              className="rounded bg-zinc-800 px-3 py-1 text-[12px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 transition-colors settings-add-model-btn"
            >
              添加
            </button>
          </div>

          {/* 获取模型出错提示 */}
          {modelError && (
            <div className="rounded border border-rose-900/60 bg-rose-950/40 p-2 text-[11.5px] text-rose-300">
              <p className="font-medium">{modelError.message}</p>
              {modelError.hint && <p className="text-zinc-400 mt-0.5">{modelError.hint}</p>}
            </div>
          )}
        </div>

        {/* 推理强度设置 */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-2">
          <span className="block text-[11.5px] font-medium text-zinc-400">可用推理强度档位</span>
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {REASONING_EFFORTS.map((opt) => {
                const enabled = draft.reasoningEfforts.includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      const updated = enabled
                        ? draft.reasoningEfforts.filter((item) => item !== opt)
                        : [...draft.reasoningEfforts, opt];
                      // 至少保留一个档位：全部取消会导致服务端 schema 校验失败，
                      // 用户会看到「保存不了」却没有明确原因。
                      if (updated.length === 0) {
                        setError("至少需要保留一个推理强度档位。");
                        return;
                      }
                      setError(null);
                      setDraft({ ...draft, reasoningEfforts: updated });
                    }}
                    className={`rounded border px-2.5 py-0.5 text-[11.5px] transition-colors ${
                      enabled
                        ? "border-zinc-500 bg-zinc-800 text-white font-medium"
                        : "border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {opt === "low" ? "低 (low)" : opt === "medium" ? "中 (medium)" : "高 (high)"}
                  </button>
                );
              })}
            </div>

            <label className="flex items-center gap-1.5 text-[11.5px] text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.reasoningUnsupported}
                onChange={(e) => setDraft({ ...draft, reasoningUnsupported: e.target.checked })}
                className="accent-zinc-400"
              />
              该厂商不支持推理强度
            </label>
          </div>
          {twoTierHint && <p className="text-[11px] text-amber-400">{twoTierHint}</p>}
        </div>

        {/* 底部启用状态与保存/测试按钮 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800/80 pt-3">
          <label className="flex items-center gap-2 text-[12.5px] text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              className="accent-emerald-400"
            />
            <span>启用此提供商</span>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing || !isEditing}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 transition-colors settings-test-btn"
            >
              {testing ? "测试中…" : "测试连接"}
            </button>

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-100 hover:bg-white px-4 py-1.5 text-[12px] font-medium text-black disabled:opacity-50 transition-colors settings-save-btn"
            >
              <CheckIcon className="size-3.5 stroke-[2.5]" />
              <span>{saving ? "保存中…" : isEditing ? "保存修改" : "保存新厂商"}</span>
            </button>
          </div>
        </div>

        {/* 反馈提示 */}
        {error && (
          <div className="rounded border border-rose-900 bg-rose-950/50 p-2 text-[12px] text-rose-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded border border-emerald-900 bg-emerald-950/50 p-2 text-[12px] text-emerald-300">
            {notice}
          </div>
        )}
        {testResult && (
          <div
            className={`rounded border p-2 text-[12px] ${
              testResult.ok
                ? "border-emerald-900 bg-emerald-950/50 text-emerald-300"
                : "border-rose-900 bg-rose-950/50 text-rose-300"
            }`}
          >
            {testResult.ok ? (
              <div>
                <p className="font-medium">
                  连接测试成功！耗时: {testResult.latencyMs}ms，模型: {testResult.modelId}
                </p>
                {testResult.reply && <p className="text-zinc-300 mt-1 font-mono text-[11px] truncate">响应: {testResult.reply}</p>}
              </div>
            ) : (
              <p className="font-medium">测试失败: {testResult.message}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
