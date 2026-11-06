/**
 * 系统与 AI 供应商设置面板。
 *
 * 采用双栏侧边导航布局（对齐参考设计图）：
 * - 左侧导航栏：搜索框 + 「通用」「AI」「电脑」三大模块
 * - 通用（General）：外观主题设置，支持「系统默认」「浅色」「深色」三种模式
 * - AI（Providers）：各大 AI 供应商对接列表 + 「更多 AI 提供方」卡片网格 + 点击进入详细对接配置表单
 * - 电脑（Computer）：Computer Use（电脑桌面自动化操作）启用开关，启用后方可调用电脑操作
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  REASONING_EFFORTS,
  isTwoTierModel,
  type ProviderType,
  type PublicProvider,
} from "@deepagent/shared";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "../../components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import type { ModelListOutcome, ProviderDraft, TestOutcome } from "./use-provider-settings.js";
import type { Theme, ThemeMode } from "./use-theme.js";
import {
  PlusIcon,
  Trash2Icon,
  CheckIcon,
  RefreshCwIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  SettingsIcon,
  SparklesIcon,
  SearchIcon,
  ChevronDownIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  XIcon,
  ShieldCheckIcon,
  MousePointerClickIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";

const TYPE_LABEL: Record<ProviderType, string> = {
  stepfun: "StepFun（OpenAI 兼容）",
  openai: "OpenAI 官方协议",
  anthropic: "Anthropic 原生协议",
  "openai-compatible": "OpenAI 兼容协议（自定义厂商）",
};

const CONFIGURABLE_PROTOCOL_TYPES: ProviderType[] = ["openai", "stepfun", "openai-compatible"];

export type SettingsTab = "general" | "ai" | "computer";

/** 预设主流 AI 供应商目录（支持一键填充对接参数） */
interface PresetVendor {
  key: string;
  name: string;
  vendor: string;
  subtitle: string;
  type: ProviderType;
  baseUrl: string;
  defaultModels: string[];
  featured: boolean;
  matchKeywords: string[];
}

const PRESET_VENDORS: PresetVendor[] = [
  {
    key: "grok",
    name: "Grok",
    vendor: "xAI",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    defaultModels: ["grok-3", "grok-3-mini"],
    featured: true,
    matchKeywords: ["grok", "x.ai", "xai"],
  },
  {
    key: "kimi",
    name: "Kimi",
    vendor: "Moonshot AI",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModels: ["kimi-k2-0711-preview", "moonshot-v1-128k"],
    featured: true,
    matchKeywords: ["kimi", "moonshot", "月之暗面"],
  },
  {
    key: "claude",
    name: "Claude",
    vendor: "Anthropic",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModels: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest"],
    featured: true,
    matchKeywords: ["claude", "anthropic"],
  },
  {
    key: "codex",
    name: "Codex (OpenAI)",
    vendor: "OpenAI",
    subtitle: "需要设置",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModels: ["gpt-4.1", "o4-mini", "gpt-4o"],
    featured: true,
    matchKeywords: ["openai", "codex", "gpt"],
  },
  {
    key: "gemini",
    name: "Google Gemini",
    vendor: "Google",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
    featured: true,
    matchKeywords: ["gemini", "google", "generativelanguage"],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    vendor: "深度求索",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModels: ["deepseek-chat", "deepseek-reasoner"],
    featured: true,
    matchKeywords: ["deepseek", "深度求索"],
  },
  // 更多 AI 提供方（底部双列卡片网格）
  {
    key: "qwen",
    name: "Qwen (通义千问)",
    vendor: "Alibaba Cloud",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModels: ["qwen-max-latest", "qwen-plus-latest", "qwq-plus"],
    featured: false,
    matchKeywords: ["qwen", "dashscope", "通义", "阿里"],
  },
  {
    key: "siliconflow",
    name: "SiliconFlow",
    vendor: "硅基流动",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModels: ["deepseek-ai/DeepSeek-V3", "deepseek-ai/DeepSeek-R1"],
    featured: false,
    matchKeywords: ["siliconflow", "硅基流动"],
  },
  {
    key: "stepfun",
    name: "StepFun",
    vendor: "阶跃星辰",
    subtitle: "需要设置",
    type: "stepfun",
    baseUrl: "https://api.stepfun.com/v1",
    defaultModels: ["step-2-16k", "step-3.5-flash-2603"],
    featured: false,
    matchKeywords: ["stepfun", "阶跃"],
  },
  {
    key: "doubao",
    name: "Doubao (火山方舟)",
    vendor: "ByteDance",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModels: ["doubao-1-5-pro-32k-250115"],
    featured: false,
    matchKeywords: ["doubao", "volces", "豆包", "火山"],
  },
  {
    key: "zhipu",
    name: "GLM (智谱清言)",
    vendor: "Zhipu AI",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModels: ["glm-4-plus", "glm-z1-air"],
    featured: false,
    matchKeywords: ["zhipu", "bigmodel", "glm", "智谱"],
  },
  {
    key: "ollama",
    name: "Ollama (本地模型)",
    vendor: "Local LLM",
    subtitle: "需要设置",
    type: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultModels: ["qwen2.5-coder:14b", "deepseek-r1:14b"],
    featured: false,
    matchKeywords: ["ollama", "11434", "本地"],
  },
];

/** 渲染各品牌辨识度高的专属矢量图标 */
function VendorLogo({ vendorKey, className }: { vendorKey: string; className?: string }) {
  const k = vendorKey.toLowerCase();
  if (k.includes("grok") || k.includes("xai")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cn("size-5 text-foreground", className)}>
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="M6.5 17.5L17.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (k.includes("kimi") || k.includes("moonshot")) {
    return (
      <div className={cn("flex items-center justify-center font-bold text-[14px] tracking-tight text-foreground", className)}>
        <span>K</span>
        <span className="ml-0.5 size-1.5 rounded-full bg-sky-500 -translate-y-1.5" />
      </div>
    );
  }
  if (k.includes("claude") || k.includes("anthropic")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cn("size-5 text-[#d97757]", className)}>
        <path
          d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4M8.5 3.7l7 16.6M15.5 3.7l-7 16.6M3.7 8.5l16.6 7M3.7 15.5l16.6-7"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (k.includes("codex") || k.includes("openai") || k.includes("gpt")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cn("size-5 text-foreground", className)}>
        <path
          d="M12 4.5a4.5 4.5 0 0 1 4.3 3.2 4.5 4.5 0 0 1 2.9 5.8 4.5 4.5 0 0 1-3.7 5.3A4.5 4.5 0 0 1 9 20a4.5 4.5 0 0 1-4.3-3.2 4.5 4.5 0 0 1-2.9-5.8A4.5 4.5 0 0 1 5.5 5.7 4.5 4.5 0 0 1 12 4.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <circle cx="12" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  if (k.includes("gemini") || k.includes("google")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cn("size-5 text-indigo-400", className)}>
        <path
          d="M12 3C12 8 8 12 3 12c5 0 9 4 9 9 0-5 4-9 9-9-5 0-9-4-9-9Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (k.includes("deepseek")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cn("size-5 text-blue-500", className)}>
        <path
          d="M4 13.5c0-4.5 3.8-7.5 8.5-7.5 3.6 0 6.5 2 7.5 5-2-.6-3.8-.2-5 1.2-1.2 1.4-1.8 3.8-4.5 4.8-3.5 1.2-6.5-.5-6.5-3.5Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <circle cx="14.5" cy="9.5" r="1" fill="currentColor" />
      </svg>
    );
  }
  if (k.includes("qwen")) {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cn("size-5 text-violet-500", className)}>
        <polygon points="12,3 20,7.5 20,16.5 12,21 4,16.5 4,7.5" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    );
  }
  return <SparklesIcon className={cn("size-4.5 text-emerald-500", className)} />;
}

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
  /** 当前实际生效主题（dark / light） */
  theme?: Theme;
  /** 直接切换深浅色 */
  onThemeChange?: (theme: Theme) => void;
  /** 主题模式（system / dark / light） */
  themeMode?: ThemeMode;
  /** 切换主题模式 */
  onThemeModeChange?: (mode: ThemeMode) => void;
  /** 是否启用 Computer Use（电脑桌面自动化操作） */
  computerUseEnabled?: boolean;
  /** 切换 Computer Use 启用状态 */
  onComputerUseEnabledChange?: (enabled: boolean) => void;
  /** 初始打开的选项卡 */
  initialTab?: SettingsTab;
}

export function SettingsModal(props: SettingsModalProps) {
  const { open, onClose } = props;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="settings-modal-dialog"
        className="settings-panel-dialog top-[4vh] w-[94vw] sm:max-w-[900px] h-[730px] max-h-[90vh] translate-y-0 gap-0 overflow-hidden rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-2xl"
      >
        <DialogTitle className="sr-only">设置</DialogTitle>
        {open ? <SettingsBody {...props} /> : null}
      </DialogContent>
    </Dialog>
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

function matchProviderToPreset(provider: PublicProvider, preset: PresetVendor): boolean {
  const labelLower = provider.label.toLowerCase();
  const urlLower = provider.baseUrl.toLowerCase();
  return preset.matchKeywords.some((kw) => labelLower.includes(kw) || urlLower.includes(kw));
}

function SettingsBody(props: SettingsModalProps) {
  const {
    providers,
    onClose,
    theme = "dark",
    onThemeChange,
    themeMode = theme,
    onThemeModeChange,
    computerUseEnabled = false,
    onComputerUseEnabledChange,
  } = props;

  const [activeTab, setActiveTab] = useState<SettingsTab>(props.initialTab ?? "ai");
  const [searchQuery, setSearchQuery] = useState("");
  const [moreExpanded, setMoreExpanded] = useState(true);

  // 是否处于某个供应商的编辑/新建详情视图
  const [editingView, setEditingView] = useState<boolean>(false);

  const [draft, setDraft] = useState<ProviderDraft>(() => {
    if (props.activeProviderId) {
      const found = providers.find((p) => p.id === props.activeProviderId);
      if (found) return draftFromProvider(found);
    }
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

  const lastAutoFetchRef = useRef<{ id: string; baseUrl: string } | null>(null);
  const isEditing = draft.id !== undefined;

  const resetMessages = () => {
    setError(null);
    setNotice(null);
    setModelError(null);
    setTestResult(null);
  };

  /** 点击「添加自定义厂商」 */
  const openCreateCustom = (type: ProviderType = "openai-compatible", defaultLabel = "自定义模型厂商") => {
    resetMessages();
    setDraft(props.draftFor(type, defaultLabel));
    setEditingView(true);
  };

  /** 点击某个预设供应商的「设置」按钮 */
  const openPresetSetup = (preset: PresetVendor) => {
    const existing = providers.find((p) => matchProviderToPreset(p, preset));
    if (existing) {
      openEditProvider(existing.id);
      return;
    }
    resetMessages();
    setDraft({
      type: preset.type,
      label: preset.name,
      baseUrl: preset.baseUrl,
      apiKey: "",
      models: [...preset.defaultModels],
      defaultModel: preset.defaultModels[0] ?? null,
      enabled: true,
      reasoningEfforts: ["low", "medium", "high"],
      reasoningUnsupported: false,
    });
    setEditingView(true);
  };

  /** 点击已配置供应商的「管理」按钮 */
  const openEditProvider = (id: string) => {
    const found = providers.find((p) => p.id === id);
    if (!found) return;
    resetMessages();
    setDraft(draftFromProvider(found));
    props.onSelectProvider(id);
    setEditingView(true);
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
      setNotice(isEditing ? "厂商配置已成功保存！输入框模型列表已同步。" : "新厂商配置已成功保存！输入框模型列表已同步。");
      setDraft({ ...draft, apiKey: "" });
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
    const merged = Array.from(new Set([...draft.models, ...result.models]));
    const nextDraft = {
      ...draft,
      models: merged,
      defaultModel: draft.defaultModel ?? result.models[0] ?? null,
    };
    setDraft(nextDraft);
    if (draft.id) {
      await props.onSave(nextDraft);
    }
    setNotice(`已成功获取 ${result.models.length} 个模型并自动保存！输入框模型列表已同步。`);
  };

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
      setEditingView(false);
    } else {
      setError("删除失败");
    }
  };

  const twoTierHint = useMemo(() => {
    if (draft.type !== "stepfun") return null;
    if (!draft.defaultModel || !isTwoTierModel(draft.defaultModel)) return null;
    return "提示：模型 step-3.5-flash-2603 仅支持 low 和 high 两档，medium 已被自动禁用。";
  }, [draft]);

  const handleSelectThemeMode = (mode: ThemeMode) => {
    if (onThemeModeChange) {
      onThemeModeChange(mode);
    } else if (mode === "light" || mode === "dark") {
      onThemeChange?.(mode);
    }
  };

  // 构建主列表项（优先展示已配置自定义厂商 + 核心预设厂商）
  const q = searchQuery.trim().toLowerCase();

  const featuredPresets = PRESET_VENDORS.filter((v) => v.featured);
  const morePresets = PRESET_VENDORS.filter((v) => !v.featured);

  // 未匹配任何预设的自定义已配置厂商（例如 Atria 官方预设或用户自建厂商）
  const customConfiguredProviders = providers.filter(
    (p) => !PRESET_VENDORS.some((preset) => matchProviderToPreset(p, preset)),
  );

  const filteredCustomProviders = customConfiguredProviders.filter(
    (p) => !q || p.label.toLowerCase().includes(q) || p.baseUrl.toLowerCase().includes(q),
  );

  const filteredFeaturedPresets = featuredPresets.filter(
    (v) =>
      !q ||
      v.name.toLowerCase().includes(q) ||
      v.vendor.toLowerCase().includes(q) ||
      v.matchKeywords.some((k) => k.includes(q)),
  );

  const filteredMorePresets = morePresets.filter(
    (v) =>
      !q ||
      v.name.toLowerCase().includes(q) ||
      v.vendor.toLowerCase().includes(q) ||
      v.matchKeywords.some((k) => k.includes(q)),
  );

  const navItems: Array<{ id: SettingsTab; label: string; icon: typeof SettingsIcon }> = [
    { id: "general", label: "通用", icon: SettingsIcon },
    { id: "ai", label: "AI", icon: SparklesIcon },
    { id: "computer", label: "电脑", icon: MonitorIcon },
  ];

  const tabTitle: Record<SettingsTab, string> = {
    general: "通用",
    ai: "AI",
    computer: "电脑",
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-card text-foreground settings-layout-root">
      {/* ================= 左侧导航栏 ================= */}
      <aside className="settings-sidebar flex w-[210px] shrink-0 flex-col border-r border-border/60 bg-secondary/25 p-3.5 select-none">
        {/* 顶部搜索框 */}
        <div className="relative mb-3 flex items-center">
          <SearchIcon className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索"
            data-testid="settings-search-input"
            className="settings-search-input w-full rounded-xl border border-transparent bg-secondary/80 pl-8 pr-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-border focus:outline-none transition-colors"
          />
        </div>

        {/* 导航菜单项 */}
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`settings-nav-${item.id}`}
                onClick={() => {
                  setActiveTab(item.id);
                  if (item.id !== "ai") {
                    setEditingView(false);
                  }
                }}
                className={cn(
                  "settings-nav-item flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13.5px] transition-colors",
                  isActive
                    ? "settings-nav-item-active bg-accent text-accent-foreground font-medium shadow-2xs"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* ================= 右侧内容主区 ================= */}
      <main className="settings-content-pane relative flex min-w-0 flex-1 flex-col overflow-hidden bg-card">
        {/* 右上角关闭按钮与标题栏 */}
        <div className="flex items-center justify-between px-7 pt-5 pb-3 shrink-0">
          <div className="flex items-center gap-2.5">
            {activeTab === "ai" && editingView ? (
              <button
                type="button"
                data-testid="settings-back-to-ai-list-btn"
                onClick={() => {
                  setEditingView(false);
                  resetMessages();
                }}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-[13.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <ArrowLeftIcon className="size-4" />
                <span>返回 AI 列表</span>
              </button>
            ) : (
              <h2 className="text-[17px] font-semibold tracking-tight text-foreground">
                {tabTitle[activeTab]}
              </h2>
            )}
          </div>

          <div className="flex items-center gap-2">
            {activeTab === "ai" && !editingView && (
              <button
                type="button"
                data-testid="settings-add-custom-provider-btn"
                onClick={() => openCreateCustom("openai-compatible", "自定义模型厂商")}
                className="settings-pill-btn flex items-center gap-1.5 rounded-full border border-border bg-secondary/70 px-3.5 py-1 text-[12px] font-medium text-foreground hover:bg-accent transition-colors"
              >
                <PlusIcon className="size-3.5" />
                <span>添加自定义厂商</span>
              </button>
            )}
            <button
              type="button"
              data-testid="settings-close-btn"
              onClick={onClose}
              aria-label="关闭设置"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        {/* 主体可滚动内容 */}
        <div className="flex-1 overflow-y-auto px-7 pb-7 pt-1">
          {/* ==================== 1. 通用选项卡 ==================== */}
          {activeTab === "general" && (
            <div className="space-y-5" data-testid="settings-tab-general">
              {/* 外观主题设置卡片 */}
              <div className="settings-section-card rounded-2xl border border-border/70 bg-secondary/15 p-5 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-[14px] font-medium text-foreground">外观主题</div>
                    <div className="text-[12px] text-muted-foreground mt-0.5">
                      选择工作台界面主题，支持跟随系统默认或固定浅色 / 深色外观
                    </div>
                  </div>
                  <span className="rounded-full border border-border/80 bg-secondary/60 px-2.5 py-0.5 text-[11.5px] text-muted-foreground">
                    当前生效：{theme === "light" ? "浅色 (白)" : "深色 (黑)"}
                  </span>
                </div>

                {/* 三档主题选择卡片：系统默认 / 浅色 / 深色 */}
                <div className="grid grid-cols-3 gap-3 pt-1">
                  {/* 系统默认 */}
                  <button
                    type="button"
                    data-testid="theme-mode-system"
                    onClick={() => handleSelectThemeMode("system")}
                    className={cn(
                      "settings-theme-card group flex flex-col items-start gap-2.5 rounded-xl border p-3.5 text-left transition-all",
                      themeMode === "system"
                        ? "settings-theme-card-active border-primary bg-accent/70 ring-2 ring-primary/20"
                        : "border-border/70 bg-background/50 hover:bg-accent/40",
                    )}
                  >
                    <div className="flex w-full items-center justify-between">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-secondary text-foreground">
                        <MonitorIcon className="size-4" />
                      </div>
                      {themeMode === "system" && (
                        <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                          <CheckIcon className="size-3.5" />
                        </span>
                      )}
                    </div>
                    <div>
                      <div className="text-[13px] font-semibold text-foreground">系统默认</div>
                      <div className="text-[11.5px] text-muted-foreground mt-0.5">
                        自动跟随操作系统浅色或深色设置
                      </div>
                    </div>
                  </button>

                  {/* 浅色模式 */}
                  <button
                    type="button"
                    data-testid="theme-mode-light"
                    onClick={() => handleSelectThemeMode("light")}
                    className={cn(
                      "settings-theme-card group flex flex-col items-start gap-2.5 rounded-xl border p-3.5 text-left transition-all",
                      themeMode === "light"
                        ? "settings-theme-card-active border-primary bg-accent/70 ring-2 ring-primary/20"
                        : "border-border/70 bg-background/50 hover:bg-accent/40",
                    )}
                  >
                    <div className="flex w-full items-center justify-between">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
                        <SunIcon className="size-4" />
                      </div>
                      {themeMode === "light" && (
                        <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                          <CheckIcon className="size-3.5" />
                        </span>
                      )}
                    </div>
                    <div>
                      <div className="text-[13px] font-semibold text-foreground">浅色 (白)</div>
                      <div className="text-[11.5px] text-muted-foreground mt-0.5">
                        纯净明亮白底，适合日间办公环境
                      </div>
                    </div>
                  </button>

                  {/* 深色模式 */}
                  <button
                    type="button"
                    data-testid="theme-mode-dark"
                    onClick={() => handleSelectThemeMode("dark")}
                    className={cn(
                      "settings-theme-card group flex flex-col items-start gap-2.5 rounded-xl border p-3.5 text-left transition-all",
                      themeMode === "dark"
                        ? "settings-theme-card-active border-primary bg-accent/70 ring-2 ring-primary/20"
                        : "border-border/70 bg-background/50 hover:bg-accent/40",
                    )}
                  >
                    <div className="flex w-full items-center justify-between">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                        <MoonIcon className="size-4" />
                      </div>
                      {themeMode === "dark" && (
                        <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                          <CheckIcon className="size-3.5" />
                        </span>
                      )}
                    </div>
                    <div>
                      <div className="text-[13px] font-semibold text-foreground">深色 (黑)</div>
                      <div className="text-[11.5px] text-muted-foreground mt-0.5">
                        纯黑沉浸背景，降低夜间视觉疲劳
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ==================== 2. AI 供应商列表与配置选项卡 ==================== */}
          {activeTab === "ai" && !editingView && (
            <div className="space-y-4" data-testid="settings-tab-ai-list">
              {/* 主供应商列表卡片（对齐参考设计图） */}
              <div className="settings-section-card divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/70 bg-secondary/10">
                {/* 已配置的自定义厂商（如 Atria 等非内置预设项） */}
                {filteredCustomProviders.map((provider) => {
                  const isActive = props.activeProviderId === provider.id;
                  const statusLabel = provider.hasApiKey
                    ? `就绪 · ${provider.defaultModel ?? provider.models[0] ?? `已配置 ${provider.models.length} 个模型`}`
                    : "需要设置 API Key";
                  return (
                    <div
                      key={provider.id}
                      className="settings-provider-row flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-accent/30"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className="flex size-8 shrink-0 items-center justify-center">
                          <VendorLogo vendorKey={provider.label} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[14px] font-medium text-foreground">
                              {provider.label}
                            </span>
                            {isActive && (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-0.2 text-[10.5px] font-medium text-emerald-400">
                                当前使用
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[12px] text-muted-foreground">
                            {statusLabel}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => openEditProvider(provider.id)}
                        className="settings-action-pill shrink-0 rounded-full bg-secondary/80 px-4 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-accent transition-colors"
                      >
                        管理
                      </button>
                    </div>
                  );
                })}

                {/* 主流 AI 供应商列表（Grok / Kimi / Claude / Codex / Google Gemini / DeepSeek） */}
                {filteredFeaturedPresets.map((preset) => {
                  const configured = providers.find((p) => matchProviderToPreset(p, preset));
                  const isReady = Boolean(configured && configured.hasApiKey);
                  const isActive = Boolean(configured && props.activeProviderId === configured.id);
                  const statusText = configured
                    ? isReady
                      ? `就绪 · ${configured.defaultModel ?? configured.models[0] ?? "已对接"}`
                      : "需要填写密钥"
                    : preset.subtitle;

                  return (
                    <div
                      key={preset.key}
                      data-testid={`ai-provider-row-${preset.key}`}
                      className="settings-provider-row flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-accent/30"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className="flex size-8 shrink-0 items-center justify-center">
                          <VendorLogo vendorKey={preset.key} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[14px] font-medium text-foreground">
                              {configured ? configured.label : preset.name}
                            </span>
                            {isActive && (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-0.2 text-[10.5px] font-medium text-emerald-400">
                                当前使用
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[12px] text-muted-foreground">
                            {statusText}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        data-testid={`ai-provider-action-${preset.key}`}
                        onClick={() => openPresetSetup(preset)}
                        className="settings-action-pill shrink-0 rounded-full bg-secondary/80 px-4 py-1.5 text-[12.5px] font-medium text-foreground hover:bg-accent transition-colors"
                      >
                        {configured ? "管理" : "设置"}
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* 更多 AI 提供方折叠横条（完全还原参考设计图） */}
              <button
                type="button"
                data-testid="settings-more-providers-toggle"
                onClick={() => setMoreExpanded((v) => !v)}
                className="settings-more-bar flex w-full items-center justify-between rounded-xl border border-border/70 bg-secondary/15 px-4 py-3 text-[13px] font-medium text-foreground hover:bg-accent/40 transition-colors"
              >
                <span>更多 AI 提供方 ({filteredMorePresets.length})</span>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <div className="flex items-center gap-1 opacity-75">
                    <SparklesIcon className="size-3.5" />
                    <MonitorIcon className="size-3.5" />
                  </div>
                  <ChevronDownIcon
                    className={cn(
                      "size-4 transition-transform duration-150",
                      moreExpanded && "rotate-180",
                    )}
                  />
                </div>
              </button>

              {/* 底部双列模型提供方卡片网格 */}
              {moreExpanded && (
                <div className="space-y-2.5 pt-1">
                  <div className="flex items-center justify-between px-1 text-[12px] text-muted-foreground">
                    <span>需要设置</span>
                    <span>{filteredMorePresets.length} 个模型提供方</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {filteredMorePresets.map((preset) => {
                      const configured = providers.find((p) => matchProviderToPreset(p, preset));
                      const isReady = Boolean(configured && configured.hasApiKey);
                      return (
                        <div
                          key={preset.key}
                          data-testid={`ai-more-card-${preset.key}`}
                          onClick={() => openPresetSetup(preset)}
                          className="settings-more-card group flex flex-col justify-between gap-3.5 rounded-2xl border border-border/70 bg-secondary/10 p-4 cursor-pointer hover:border-border hover:bg-accent/30 transition-all"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="settings-more-card-icon flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-secondary/60">
                                <VendorLogo vendorKey={preset.key} />
                              </div>
                              <div className="min-w-0">
                                <div className="truncate text-[13.5px] font-semibold text-foreground">
                                  {configured ? configured.label : preset.name}
                                </div>
                                <div className="truncate text-[11.5px] text-muted-foreground">
                                  {preset.vendor}
                                </div>
                              </div>
                            </div>
                            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                          </div>

                          <div className="flex items-center justify-between pt-0.5">
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary/80 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                              <span
                                className={cn(
                                  "size-1.5 rounded-full",
                                  isReady ? "bg-emerald-400" : "bg-amber-600",
                                )}
                              />
                              {isReady ? "已就绪" : "需要设置"}
                            </span>

                            <span className="inline-flex items-center gap-0.5 text-[12px] font-medium text-blue-500 group-hover:underline">
                              <span>{configured ? "管理" : "设置"}</span>
                              <ArrowUpRightIcon className="size-3.5" />
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ==================== 2.1 AI 供应商详细对接表单视图 ==================== */}
          {activeTab === "ai" && editingView && (
            <div className="space-y-4" data-testid="settings-tab-ai-form">
              <div className="flex items-center justify-between pb-2.5 border-b border-border">
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-xl border border-border/60 bg-secondary/50">
                    <VendorLogo vendorKey={draft.label || draft.baseUrl} />
                  </div>
                  <div>
                    <h3 className="text-[14.5px] font-semibold text-foreground">
                      {draft.label || "配置 AI 供应商"}
                    </h3>
                    <p className="text-[11.5px] text-muted-foreground">
                      {isEditing ? `编辑已有供应商配置（ID: ${draft.id}）` : "填写供应商 API 地址与密钥完成对接"}
                    </p>
                  </div>
                </div>
                {isEditing && (
                  <button
                    type="button"
                    onClick={() => draft.id && void handleRemove(draft.id)}
                    className="flex items-center gap-1 text-[12px] text-rose-400 hover:text-rose-300 transition-colors px-2 py-1 rounded-md hover:bg-rose-500/10"
                    title="删除此提供商"
                  >
                    <Trash2Icon className="size-3.5" />
                    <span>删除</span>
                  </button>
                )}
              </div>

              {notice && (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-950/60 p-2.5 text-[12px] text-emerald-300 shadow-xs">
                  <CheckIcon className="size-4 shrink-0 text-emerald-400" />
                  <span className="font-medium">{notice}</span>
                </div>
              )}
              {error && (
                <div className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-950/60 p-2.5 text-[12px] text-rose-300 shadow-xs">
                  <span className="font-medium">{error}</span>
                </div>
              )}

              {/* 厂商名称与协议类型 */}
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-muted-foreground">厂商显示名称 (Label)</span>
                  <input
                    type="text"
                    value={draft.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    placeholder="如：DeepSeek / Kimi / OpenAI"
                    className="settings-input w-full rounded-lg border border-input bg-secondary/50 px-3 py-1.5 text-[12.5px] text-foreground outline-none focus-visible:border-ring"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-[11.5px] text-muted-foreground">API 协议</span>
                  <Select
                    value={draft.type}
                    onValueChange={(value) => {
                      const type = value as ProviderType;
                      setDraft({
                        ...draft,
                        type,
                        baseUrl: draft.baseUrl || props.draftFor(type, draft.label).baseUrl,
                      });
                    }}
                  >
                    <SelectTrigger className="h-[33px] w-full rounded-lg border-input bg-secondary/50 px-2.5 text-[12.5px] text-foreground shadow-none hover:border-ring/60">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-border bg-card text-foreground">
                      {CONFIGURABLE_PROTOCOL_TYPES.map((type) => (
                        <SelectItem key={type} value={type} className="text-[12.5px] focus:bg-accent focus:text-accent-foreground">
                          {TYPE_LABEL[type]}
                        </SelectItem>
                      ))}
                      {draft.type === "anthropic" && (
                        <SelectItem value="anthropic" className="text-[12.5px] focus:bg-accent focus:text-accent-foreground">
                          {TYPE_LABEL.anthropic}（已有配置）
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </label>
              </div>

              {/* API Base URL */}
              <label className="block">
                <span className="mb-1 block text-[11.5px] text-muted-foreground">API Base URL</span>
                <input
                  type="url"
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  className="settings-input w-full rounded-lg border border-input bg-secondary/50 px-3 py-1.5 font-mono text-[12px] text-foreground outline-none focus-visible:border-ring"
                />
              </label>

              {/* API Key */}
              <label className="block">
                <span className="mb-1 block text-[11.5px] text-muted-foreground">
                  API Key {isEditing ? "（留空表示保留当前已配置密钥）" : ""}
                </span>
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  placeholder={isEditing ? "••••••••（已加密安全保存）" : "输入 sk- 开头的 API Key..."}
                  autoComplete="off"
                  className="settings-input w-full rounded-lg border border-input bg-secondary/50 px-3 py-1.5 font-mono text-[12px] text-foreground outline-none focus-visible:border-ring"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  安全保障：API Key 仅保存在本地服务端，前端只保留掩码，绝不进入浏览器存储或对外泄露。
                </span>
              </label>

              {/* 模型列表管理 */}
              <div className="rounded-xl border border-border bg-background/40 p-3.5 space-y-2.5 settings-models-box">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-foreground/90 settings-models-label">
                    可用模型列表 ({draft.models.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleFetchModels()}
                    disabled={fetchingModels}
                    className="flex items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[11.5px] text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50 settings-fetch-models-btn"
                  >
                    <RefreshCwIcon className={`size-3 ${fetchingModels ? "animate-spin" : ""}`} />
                    <span>{fetchingModels ? "正在查询..." : "获取远程模型列表"}</span>
                  </button>
                </div>

                {draft.models.length > 0 ? (
                  <div className="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-border/60 bg-background/60 p-2 settings-model-list-scroll">
                    {draft.models.map((model) => {
                      const isDefault = draft.defaultModel === model;
                      return (
                        <div
                          key={model}
                          className={cn(
                            "flex items-center justify-between gap-2 px-2.5 py-1 rounded-md text-[12px] transition-colors settings-model-item",
                            isDefault ? "bg-accent text-accent-foreground is-default" : "text-foreground/90 hover:bg-accent/60",
                          )}
                        >
                          <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                            <input
                              type="radio"
                              name="default-model"
                              checked={isDefault}
                              onChange={() => setDraft({ ...draft, defaultModel: model })}
                              className="accent-primary"
                            />
                            <span className="font-mono truncate">{model}</span>
                            {isDefault && (
                              <span className="text-[10.5px] bg-primary/15 text-primary px-1.5 py-0.2 rounded font-medium shrink-0 settings-default-badge">
                                默认模型
                              </span>
                            )}
                          </label>

                          <button
                            type="button"
                            onClick={() => handleRemoveSingleModel(model)}
                            className="p-0.5 text-muted-foreground hover:text-rose-400 rounded transition-colors"
                            title="移除此模型"
                          >
                            <Trash2Icon className="size-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-[12px] text-muted-foreground settings-model-empty">
                    当前暂未添加任何模型。可点击上方「获取远程模型列表」或在下方手动添加。
                  </p>
                )}

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
                    placeholder="输入模型 ID，如 deepseek-chat, gpt-4.1 等"
                    className="flex-1 rounded-lg border border-input bg-secondary/50 px-2.5 py-1 font-mono text-[12px] text-foreground outline-none settings-input"
                  />
                  <button
                    type="button"
                    onClick={() => void handleAddModel()}
                    disabled={!manualModel.trim()}
                    className="rounded-lg border border-input bg-transparent px-3 py-1 text-[12px] text-foreground hover:bg-accent disabled:opacity-40 transition-colors settings-add-model-btn"
                  >
                    添加
                  </button>
                </div>

                {modelError && (
                  <div className="rounded-lg border border-rose-900/60 bg-rose-950/40 p-2 text-[11.5px] text-rose-300">
                    <p className="font-medium">{modelError.message}</p>
                    {modelError.hint && <p className="text-muted-foreground mt-0.5">{modelError.hint}</p>}
                  </div>
                )}
              </div>

              {/* 推理强度设置 */}
              <div className="rounded-xl border border-border bg-background/40 p-3.5 space-y-2">
                <span className="block text-[11.5px] font-medium text-muted-foreground">可用推理强度档位</span>
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
                            if (updated.length === 0) {
                              setError("至少需要保留一个推理强度档位。");
                              return;
                            }
                            setError(null);
                            setDraft({ ...draft, reasoningEfforts: updated });
                          }}
                          className={cn(
                            "rounded-lg border px-2.5 py-0.5 text-[11.5px] transition-colors",
                            enabled
                              ? "border-ring bg-accent text-accent-foreground font-medium"
                              : "border-border bg-secondary/50 text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {opt === "low" ? "低 (low)" : opt === "medium" ? "中 (medium)" : "高 (high)"}
                        </button>
                      );
                    })}
                  </div>

                  <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground cursor-pointer">
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

              {/* 底部启用与保存/测试操作栏 */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <label className="flex items-center gap-2 text-[12.5px] text-foreground/90 cursor-pointer">
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
                    className="rounded-lg border border-input bg-transparent px-3 py-1.5 text-[12px] text-foreground hover:bg-accent disabled:opacity-40 transition-colors settings-test-btn"
                  >
                    {testing ? "测试中…" : "测试连接"}
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving}
                    className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-1.5 text-[12px] font-medium disabled:opacity-50 transition-colors settings-save-btn"
                  >
                    <CheckIcon className="size-3.5 stroke-[2.5]" />
                    <span>{saving ? "保存中…" : isEditing ? "保存修改" : "保存新厂商"}</span>
                  </button>
                </div>
              </div>

              {testResult && (
                <div
                  className={cn(
                    "rounded-xl border p-2.5 text-[12px]",
                    testResult.ok
                      ? "border-emerald-900 bg-emerald-950/50 text-emerald-300"
                      : "border-rose-900 bg-rose-950/50 text-rose-300",
                  )}
                >
                  {testResult.ok ? (
                    <div>
                      <p className="font-medium">
                        连接测试成功！耗时: {testResult.latencyMs}ms，模型: {testResult.modelId}
                      </p>
                      {testResult.reply && (
                        <p className="text-foreground/90 mt-1 font-mono text-[11px] truncate">
                          响应: {testResult.reply}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="font-medium">测试失败: {testResult.message}</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ==================== 3. 电脑 (Computer Use) 选项卡 ==================== */}
          {activeTab === "computer" && (
            <div className="space-y-4" data-testid="settings-tab-computer">
              {/* Computer Use 核心开关卡片 */}
              <div className="settings-section-card rounded-2xl border border-border/70 bg-secondary/15 p-5">
                <div className="flex items-start justify-between gap-5">
                  <div className="flex items-start gap-3.5">
                    <div
                      className={cn(
                        "flex size-10 shrink-0 items-center justify-center rounded-xl border transition-colors",
                        computerUseEnabled
                          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                          : "border-border/70 bg-secondary/60 text-muted-foreground",
                      )}
                    >
                      <MonitorIcon className="size-5" />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14.5px] font-semibold text-foreground">
                          Computer Use（电脑桌面自动化操作）
                        </span>
                        <span
                          data-testid="computer-use-status-badge"
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-medium",
                            computerUseEnabled
                              ? "bg-emerald-500/15 text-emerald-400"
                              : "bg-secondary text-muted-foreground",
                          )}
                        >
                          {computerUseEnabled ? "已启用" : "未启用"}
                        </span>
                      </div>
                      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                        启用后，智能体可按需委派内置 <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11.5px]">computer-use</code> 子代理调用本地桌面自动化工具（观察窗口、获取 UI 快照、点击控件、键盘输入与启动桌面应用）。关闭时严禁调用任何电脑桌面操作。
                      </p>
                    </div>
                  </div>

                  {/* 现代胶囊拨动开关 */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={computerUseEnabled}
                    data-testid="computer-use-switch"
                    onClick={() => onComputerUseEnabledChange?.(!computerUseEnabled)}
                    className={cn(
                      "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none",
                      computerUseEnabled ? "bg-emerald-500" : "bg-zinc-700",
                    )}
                    title={computerUseEnabled ? "点击关闭 Computer Use" : "点击启用 Computer Use"}
                  >
                    <span
                      className={cn(
                        "pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200",
                        computerUseEnabled ? "translate-x-5" : "translate-x-0",
                      )}
                    />
                  </button>
                </div>
              </div>

              {/* 能力范围与安全说明卡片 */}
              <div className="settings-section-card rounded-2xl border border-border/70 bg-secondary/10 p-5 space-y-3.5">
                <div className="text-[13px] font-semibold text-foreground">受控电脑操作能力说明</div>
                <div className="grid grid-cols-1 gap-2.5 text-[12px]">
                  <div className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-background/40 p-3">
                    <MousePointerClickIcon className="size-4 shrink-0 text-sky-400 mt-0.5" />
                    <div>
                      <div className="font-medium text-foreground">桌面 UI 快照与元素交互</div>
                      <div className="text-muted-foreground mt-0.5">
                        支持 <code className="font-mono text-[11px]">desktop_snapshot</code>、<code className="font-mono text-[11px]">desktop_click</code>、<code className="font-mono text-[11px]">desktop_type</code>、<code className="font-mono text-[11px]">desktop_set_value</code> 等精确窗口控件交互。
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-background/40 p-3">
                    <TerminalSquareIcon className="size-4 shrink-0 text-amber-400 mt-0.5" />
                    <div>
                      <div className="font-medium text-foreground">桌面应用启动与窗口控制</div>
                      <div className="text-muted-foreground mt-0.5">
                        支持 <code className="font-mono text-[11px]">desktop_launch</code>、<code className="font-mono text-[11px]">desktop_list_windows</code>、<code className="font-mono text-[11px]">desktop_focus_window</code> 管理本地桌面应用。
                      </div>
                    </div>
                  </div>

                  <div className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-background/40 p-3">
                    <ShieldCheckIcon className="size-4 shrink-0 text-emerald-400 mt-0.5" />
                    <div>
                      <div className="font-medium text-foreground">安全边界保障</div>
                      <div className="text-muted-foreground mt-0.5">
                        仅在上方开关处于「已启用」状态时才向主 Agent 注入 <code className="font-mono text-[11px]">computer-use</code> 子智能体与 MCP 工具；关闭后立即解除挂载。
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
