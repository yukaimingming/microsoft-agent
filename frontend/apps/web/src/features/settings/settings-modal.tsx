/**
 * 系统与 AI 供应商设置面板。
 *
 * 采用双栏侧边导航布局（对齐参考设计图）：
 * - 左侧导航栏：搜索框 + 「通用」「AI」「电脑」三大模块
 * - 通用（General）：外观主题设置，支持「系统默认」「浅色」「深色」三种模式
 * - AI（Providers）：各大 AI 供应商对接列表 + 「更多 AI 提供方」卡片网格 + 点击进入详细对接配置表单
 * - 电脑（Computer）：Computer Use（电脑桌面自动化操作）启用开关，启用后方可调用电脑操作
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  REASONING_EFFORTS,
  isTwoTierModel,
  type OAuthProviderKind,
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
import type {
  BalanceOutcome,
  ModelListOutcome,
  OAuthAccountOutcome,
  OAuthStartOutcome,
  OAuthStatusOutcome,
  ProviderDraft,
  TestOutcome,
} from "./use-provider-settings.js";
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
  KeyRoundIcon,
  LogInIcon,
  LogOutIcon,
  WalletIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";

const TYPE_LABEL: Record<ProviderType, string> = {
  stepfun: "StepFun（OpenAI 兼容）",
  openai: "OpenAI 官方协议",
  anthropic: "Anthropic 原生协议",
  "openai-compatible": "OpenAI 兼容协议（自定义厂商）",
};

const CONFIGURABLE_PROTOCOL_TYPES: ProviderType[] = ["openai", "stepfun", "openai-compatible"];

/**
 * 支持订阅登录（OAuth）的厂商卡片目录。
 *
 * 与后端 OAuthProviders 注册表对应：loopback = 本地回环授权码（点按钮直接开浏览器），
 * device = RFC 8628 设备码（展示授权码 + 打开厂商验证页）。note 为该厂商的
 * 调用方式/限制标注（如专有协议不兼容当前调用链），必须如实展示，绝不假装支持。
 */
interface OAuthProviderCard {
  kind: OAuthProviderKind;
  title: string;
  desc: string;
  flow: "loopback" | "device";
  /** 该厂商的调用方式/限制标注（琥珀色警示框展示；缺省表示无特殊限制）。 */
  note?: string;
  /** 新建厂商时的预设接入参数（订阅厂商的官方推理端点）。 */
  preset?: { baseUrl: string; models: string[] };
}

const OAUTH_PROVIDERS: OAuthProviderCard[] = [
  {
    kind: "openai",
    title: "OpenAI ChatGPT 订阅",
    flow: "loopback",
    desc: "使用 ChatGPT Plus / Pro / Team 账号浏览器授权，令牌保存在本地服务端，无需 API Key",
    preset: { baseUrl: "https://api.openai.com/v1", models: ["gpt-4.1", "gpt-4o"] },
  },
  {
    kind: "anthropic",
    title: "Anthropic Claude 订阅",
    flow: "loopback",
    desc: "使用 Claude Pro / Max 账号浏览器授权（与 Claude Code 相同的 OAuth 流程）",
    note: "原生 Anthropic 协议（非 OpenAI 兼容），当前推理调用链不直接消费该令牌，需配合兼容网关使用",
    preset: { baseUrl: "https://api.anthropic.com/v1", models: ["claude-sonnet-4-20250514"] },
  },
  {
    kind: "grok",
    title: "xAI Grok 订阅",
    flow: "loopback",
    desc: "使用 SuperGrok / X Premium+ 订阅账号浏览器授权（与官方 Grok Build CLI 相同的 OAuth 流程）",
    note: "需要 SuperGrok 或 X Premium+ 订阅；推理走 Grok CLI 专用 OpenAI 兼容代理（cli-chat-proxy.grok.com），api.x.ai 仅支持 API Key",
    preset: { baseUrl: "https://cli-chat-proxy.grok.com/v1", models: ["grok-4", "grok-code-fast-1"] },
  },
  {
    kind: "google",
    title: "Google Gemini 订阅",
    flow: "loopback",
    desc: "使用 Google 账号浏览器授权（与 Gemini CLI 相同的 OAuth 流程，免费档约 1000 请求/天）",
    note: "推理走 Code Assist 专有协议（cloudcode-pa.googleapis.com，非 OpenAI 兼容），当前调用链不直接消费该令牌，需配合外部协议代理使用；Antigravity 为独立逆向协议，未接入",
    preset: { baseUrl: "https://cloudcode-pa.googleapis.com", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  },
  {
    kind: "github-copilot",
    title: "GitHub Copilot 订阅",
    flow: "device",
    desc: "在 github.com/login/device 输入设备码完成 GitHub 授权；Copilot 短时令牌由系统用 GitHub 令牌自动续期",
    note: "设备码流程（无需本地回调端口）；需要 Copilot 订阅，免费账号可用模型有限",
    preset: { baseUrl: "https://api.githubcopilot.com", models: ["gpt-4.1", "gpt-4o"] },
  },
  {
    kind: "qwen",
    title: "Qwen 通义订阅",
    flow: "device",
    desc: "在 chat.qwen.ai 输入设备码完成授权（与 Qwen Code CLI 相同流程）",
    note: "需要 Qwen Plus / Pro 订阅（免费账号可登录但不解锁调用）；推理走 OpenAI 兼容端点",
    preset: { baseUrl: "https://api.qwen.ai/compatible-mode/v1", models: ["qwen3.8-max"] },
  },
  {
    kind: "kimi",
    title: "Kimi Code 会员",
    flow: "device",
    desc: "在 auth.kimi.com 输入设备码完成授权（与 Kimi CLI 相同流程）",
    note: "需要 Kimi Code 会员（Andante / Moderato / Allegretto 等）；access token 约 15 分钟自动续期",
    preset: { baseUrl: "https://api.kimi.com/coding/v1", models: ["kimi-for-coding", "k3.1-pro"] },
  },
];

/** 币种符号（余额展示用）。 */
const CURRENCY_SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$" };

/** 金额展示：带币种符号；空值显示占位符。 */
function moneyText(value?: string | null, currency?: string | null): string {
  if (value == null || value === "") return "—";
  return `${CURRENCY_SYMBOLS[currency ?? ""] ?? ""}${value}`;
}

function formatTokenExpiry(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { hour12: false });
}

/** 前端预判厂商是否可能支持余额查询（最终以后端判定为准）。 */
function supportsBalance(provider: { baseUrl: string; label: string }): boolean {
  return /(deepseek|moonshot|kimi|siliconflow|硅基)/i.test(`${provider.baseUrl} ${provider.label}`);
}

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
  if (k.includes("github") || k.includes("copilot")) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={cn("size-5 text-foreground", className)}>
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12Z" />
      </svg>
    );
  }
  return <SparklesIcon className={cn("size-4.5 text-emerald-500", className)} />;
}

/** 列表行内的余额小徽标（仅查询成功且有余额数据时显示）。 */
function BalanceChip({
  outcome,
  loading,
  onRefresh,
}: {
  outcome?: BalanceOutcome;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!outcome || !outcome.ok || !outcome.balance) return null;
  const symbol = CURRENCY_SYMBOLS[outcome.currency ?? ""] ?? "";
  return (
    <span
      data-testid="balance-chip"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.2 text-[10.5px] font-medium text-emerald-400"
    >
      <WalletIcon className="size-3" />
      <span>
        {symbol}
        {outcome.balance}
      </span>
      <button
        type="button"
        title="刷新余额"
        onClick={(e) => {
          e.stopPropagation();
          if (!loading) onRefresh();
        }}
        className="ml-0.5 rounded-full p-0.5 transition-colors hover:bg-emerald-500/20"
      >
        <RefreshCwIcon className={cn("size-2.5", loading && "animate-spin")} />
      </button>
    </span>
  );
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
  /** 发起订阅登录（OAuth）：后端生成 PKCE 与本地回环回调服务，返回授权页地址 */
  onStartOAuth?: (kind: OAuthProviderKind, providerId?: string) => Promise<OAuthStartOutcome>;
  /** 轮询订阅登录状态 */
  onPollOAuth?: (state: string) => Promise<OAuthStatusOutcome>;
  /** 刷新订阅登录令牌 */
  onOAuthRefresh?: (id: string) => Promise<OAuthAccountOutcome>;
  /** 退出订阅登录 */
  onOAuthLogout?: (id: string) => Promise<OAuthAccountOutcome>;
  /** 查询厂商余额 */
  onFetchBalance?: (id: string) => Promise<BalanceOutcome>;
  /** 重新拉取厂商列表（订阅登录直接落库后同步快照） */
  onRefreshProviders?: () => Promise<void>;
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
    authMode: provider.authMode ?? "api-key",
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

  // ===== 订阅登录（OAuth）=====
  const [oauthPhase, setOauthPhase] = useState<"idle" | "starting" | "pending" | "success" | "error">("idle");
  const [oauthSession, setOauthSession] = useState<{
    state: string;
    kind: OAuthProviderKind;
    flow: "loopback" | "device";
    /** 设备码流程：等待授权时展示的授权码与验证页。 */
    userCode?: string;
    verificationUri?: string;
    verificationUriComplete?: string;
  } | null>(null);
  const [oauthAccount, setOauthAccount] = useState<{
    kind: OAuthProviderKind;
    accountEmail?: string | null;
    planName?: string | null;
    tokenExpiresAt?: string | null;
  } | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthFallbackUrl, setOauthFallbackUrl] = useState<string | null>(null);
  const [oauthBusyKind, setOauthBusyKind] = useState<"refresh" | "logout" | null>(null);

  // ===== 余额查询（缓存：providerId → 结果） =====
  const [balances, setBalances] = useState<Record<string, BalanceOutcome>>({});
  const [balanceLoading, setBalanceLoading] = useState<Record<string, boolean>>({});

  const lastAutoFetchRef = useRef<{ id: string; baseUrl: string } | null>(null);
  /** 余额查询中标记（ref：避免闭包读到过期 state）。 */
  const balanceInFlightRef = useRef<Set<string>>(new Set());
  const isEditing = draft.id !== undefined;

  const resetOAuthState = () => {
    setOauthPhase("idle");
    setOauthSession(null);
    setOauthAccount(null);
    setOauthError(null);
    setOauthFallbackUrl(null);
  };

  const resetMessages = () => {
    setError(null);
    setNotice(null);
    setModelError(null);
    setTestResult(null);
    resetOAuthState();
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
      authMode: "api-key",
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

  // ===== 订阅登录（OAuth）=====

  /**
   * 点击「打开浏览器登录」：
   * - 回环授权码流程（OpenAI / Anthropic / Grok / Google）：先同步开窗避免弹窗拦截，
   *   再导航到授权页并开始轮询；
   * - 设备码流程（Copilot / Qwen / Kimi）：打开厂商验证页，授权码展示在面板上由用户输入，
   *   后端自动轮询令牌端点。
   * 新建厂商时按卡片预设填充该订阅厂商的官方推理端点与模型列表。
   */
  const handleStartOAuth = async (op: OAuthProviderCard) => {
    if (!props.onStartOAuth) return;
    setOauthPhase("starting");
    setOauthError(null);
    setOauthAccount(null);
    setOauthFallbackUrl(null);
    const win = window.open("about:blank", "_blank");
    const result = await props.onStartOAuth(op.kind, draft.id);
    if (!result.ok || !result.state) {
      if (win && !win.closed) win.close();
      setOauthPhase("error");
      setOauthError(result.message ?? "发起订阅登录失败");
      return;
    }
    if (result.flow === "device") {
      // 设备码流程：验证页打开在预开窗口；弹窗被拦截时展示兜底链接
      const deviceUrl = result.verificationUriComplete || result.verificationUri;
      if (win && !win.closed && deviceUrl) {
        win.location.href = deviceUrl;
      } else if (deviceUrl) {
        setOauthFallbackUrl(deviceUrl);
      } else if (win && !win.closed) {
        win.close();
      }
      setOauthSession({
        state: result.state,
        kind: op.kind,
        flow: "device",
        userCode: result.userCode,
        verificationUri: result.verificationUri,
        verificationUriComplete: result.verificationUriComplete,
      });
    } else {
      if (win && !win.closed && result.authorizeUrl) {
        win.location.href = result.authorizeUrl;
      } else if (result.authorizeUrl) {
        // 弹窗被浏览器拦截：展示兜底链接由用户手动打开
        setOauthFallbackUrl(result.authorizeUrl);
      }
      setOauthSession({ state: result.state, kind: op.kind, flow: "loopback" });
    }
    // 新建厂商流程：应用该订阅厂商的官方推理端点与默认模型（已有模型列表则不覆盖）
    if (!draft.id && op.preset) {
      setDraft((prev) => ({
        ...prev,
        type: prev.type === "anthropic" ? "openai-compatible" : prev.type,
        baseUrl: op.preset!.baseUrl,
        models: prev.models.length > 0 ? prev.models : [...op.preset!.models],
        defaultModel: prev.defaultModel ?? op.preset!.models[0] ?? null,
      }));
    }
    setOauthPhase("pending");
  };

  // 轮询登录结果：2s 一次，直到成功/失败/超时
  useEffect(() => {
    if (oauthPhase !== "pending" || !oauthSession || !props.onPollOAuth) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        const result = await props.onPollOAuth!(oauthSession.state);
        if (cancelled) return;
        if (result.status === "success") {
          setOauthAccount({
            kind: oauthSession.kind,
            accountEmail: result.accountEmail,
            planName: result.planName,
            tokenExpiresAt: result.tokenExpiresAt,
          });
          setOauthPhase("success");
          if (result.providerId || draft.id) {
            // 已直接落到已保存厂商：同步服务端快照
            await props.onRefreshProviders?.();
          } else {
            // 新厂商流程：记住登录会话，保存时消费令牌
            const loginId = oauthSession.state;
            setDraft((prev) => ({ ...prev, authMode: "oauth", oauthLoginId: loginId }));
          }
        } else if (result.status === "error") {
          setOauthPhase("error");
          setOauthError(result.message ?? "订阅登录失败，请重试");
        } else if (result.status === "expired" || result.status === "missing") {
          setOauthPhase("error");
          setOauthError(result.message ?? "登录会话已超时，请重新发起登录");
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // draft.id 只用于区分新厂商/编辑流程，轮询期间不随草稿变化重启
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthPhase, oauthSession]);

  const handleOAuthRefresh = async () => {
    if (!draft.id || !props.onOAuthRefresh) return;
    setOauthBusyKind("refresh");
    const result = await props.onOAuthRefresh(draft.id);
    setOauthBusyKind(null);
    if (!result.ok) {
      setOauthError(result.message ?? "刷新令牌失败");
      return;
    }
    setNotice("订阅令牌已刷新");
  };

  const handleOAuthLogout = async () => {
    if (!draft.id || !props.onOAuthLogout) return;
    setOauthBusyKind("logout");
    const result = await props.onOAuthLogout(draft.id);
    setOauthBusyKind(null);
    if (!result.ok) {
      setOauthError(result.message ?? "退出登录失败");
      return;
    }
    resetOAuthState();
    setDraft((prev) => ({ ...prev, authMode: "api-key", oauthLoginId: undefined }));
    setNotice("已退出订阅登录并清除本地令牌");
  };

  // ===== 余额查询 =====

  const loadBalance = useCallback(
    async (id: string) => {
      if (!props.onFetchBalance || balanceInFlightRef.current.has(id)) return;
      balanceInFlightRef.current.add(id);
      setBalanceLoading((prev) => ({ ...prev, [id]: true }));
      try {
        const outcome = await props.onFetchBalance(id);
        setBalances((prev) => ({ ...prev, [id]: outcome }));
      } finally {
        balanceInFlightRef.current.delete(id);
        setBalanceLoading((prev) => ({ ...prev, [id]: false }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onFetchBalance],
  );

  // 进入详情视图（或切换厂商）时自动查询一次余额
  useEffect(() => {
    if (!draft.id) return;
    if (balances[draft.id] || balanceLoading[draft.id]) return;
    void loadBalance(draft.id);
    // 仅在进入详情/切换厂商时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id]);

  // AI 列表视图下自动查询疑似支持余额的已配置厂商（DeepSeek/Kimi/SiliconFlow 等）
  useEffect(() => {
    if (activeTab !== "ai" || editingView) return;
    for (const p of providers) {
      if (!p.hasApiKey) continue;
      if (balances[p.id] || balanceLoading[p.id]) continue;
      if (supportsBalance(p)) void loadBalance(p.id);
    }
    // 依赖 providers：保存/刷新后自动补查新厂商
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, activeTab, editingView]);

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

  /** 详情区余额卡片的数据与加载态。 */
  const activeBalance = draft.id ? balances[draft.id] : undefined;
  const activeBalanceLoading = draft.id ? Boolean(balanceLoading[draft.id]) : false;

  /**
   * 订阅登录账号信息：优先用本次登录会话的结果，
   * 其次回退到已保存厂商快照上的账号字段（编辑已登录厂商时）。
   */
  const editingOauthProvider = draft.id ? providers.find((p) => p.id === draft.id) ?? null : null;
  const boundOAuthAccount = oauthAccount ?? (editingOauthProvider?.accountEmail
    ? {
        kind: (editingOauthProvider.oauthProvider ?? "openai") as OAuthProviderKind,
        accountEmail: editingOauthProvider.accountEmail,
        planName: editingOauthProvider.planName,
        tokenExpiresAt: editingOauthProvider.tokenExpiresAt,
      }
    : null);

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
                          <div className="flex items-center gap-2">
                            <div className="truncate text-[12px] text-muted-foreground">
                              {statusLabel}
                            </div>
                            <BalanceChip
                              outcome={balances[provider.id]}
                              loading={Boolean(balanceLoading[provider.id])}
                              onRefresh={() => void loadBalance(provider.id)}
                            />
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
                          <div className="flex items-center gap-2">
                            <div className="truncate text-[12px] text-muted-foreground">
                              {statusText}
                            </div>
                            {configured && (
                              <BalanceChip
                                outcome={balances[configured.id]}
                                loading={Boolean(balanceLoading[configured.id])}
                                onRefresh={() => void loadBalance(configured.id)}
                              />
                            )}
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

              {/* 接入方式：API Key / 订阅登录 */}
              <div className="rounded-xl border border-border bg-background/40 p-3.5 space-y-2.5 settings-auth-mode-box">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-foreground/90">接入方式</span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      data-testid="auth-mode-api-key"
                      onClick={() => setDraft({ ...draft, authMode: "api-key" })}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg border px-3 py-1 text-[11.5px] transition-colors",
                        draft.authMode === "api-key"
                          ? "border-ring bg-accent text-accent-foreground font-medium"
                          : "border-border bg-secondary/50 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <KeyRoundIcon className="size-3.5" />
                      <span>API Key</span>
                    </button>
                    <button
                      type="button"
                      data-testid="auth-mode-oauth"
                      onClick={() => setDraft({ ...draft, authMode: "oauth" })}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg border px-3 py-1 text-[11.5px] transition-colors",
                        draft.authMode === "oauth"
                          ? "border-ring bg-accent text-accent-foreground font-medium"
                          : "border-border bg-secondary/50 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <LogInIcon className="size-3.5" />
                      <span>订阅登录</span>
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {draft.authMode === "oauth"
                    ? "通过浏览器 OAuth / 设备码授权获取订阅令牌（OpenAI / Claude / Grok / Google / GitHub Copilot / Qwen / Kimi），令牌保存在本地服务端，兼容厂商的下游调用链零改动。"
                    : "使用厂商控制台签发的 API Key 接入。"}
                </p>
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

              {draft.authMode === "oauth" ? (
                /* 订阅登录（OAuth）厂商卡片 */
                <div
                  className="rounded-xl border border-border bg-background/40 p-3.5 space-y-3 settings-oauth-box"
                  data-testid="oauth-login-box"
                >
                  <div className="text-[12px] font-medium text-foreground/90">
                    支持订阅登录的厂商（{OAUTH_PROVIDERS.length}）
                  </div>

                  {/* 设备码流程指引：展示授权码与验证页入口（后端自动轮询令牌端点） */}
                  {oauthSession?.flow === "device" && oauthSession.userCode && (
                    <div
                      className="rounded-xl border border-sky-500/40 bg-sky-500/10 p-3 space-y-1.5"
                      data-testid="oauth-device-panel"
                    >
                      <div className="flex items-center gap-1.5 text-[12px] font-medium text-sky-400">
                        <LogInIcon className="size-3.5" />
                        <span>设备码授权（{OAUTH_PROVIDERS.find((op) => op.kind === oauthSession.kind)?.title}）</span>
                      </div>
                      <div className="text-[11.5px] text-muted-foreground">
                        1. 打开授权页（上方按钮已自动打开；也可访问{" "}
                        <span className="font-mono">{oauthSession.verificationUri ?? "验证页"}</span>
                        ）
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                        <span>2. 在页面输入设备码：</span>
                        <code
                          className="rounded-md border border-sky-500/40 bg-background/60 px-2 py-0.5 font-mono text-[15px] font-semibold tracking-widest text-sky-300"
                          data-testid="oauth-device-user-code"
                        >
                          {oauthSession.userCode}
                        </code>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard?.writeText(oauthSession.userCode ?? "");
                            setNotice("设备码已复制");
                          }}
                          className="rounded-md border border-input bg-transparent px-1.5 py-0.5 text-[10.5px] text-foreground hover:bg-accent transition-colors"
                        >
                          复制
                        </button>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        3. 授权完成后自动检测（后端每几秒轮询一次令牌端点，无需手动刷新）
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    {OAUTH_PROVIDERS.map((op) => {
                      const isThisStarting = oauthPhase === "starting" && oauthSession?.kind === op.kind;
                      const isThisPending = oauthPhase === "pending" && oauthSession?.kind === op.kind;
                      const boundToThis = boundOAuthAccount?.kind === op.kind ? boundOAuthAccount : null;
                      return (
                        <div
                          key={op.kind}
                          data-testid={`oauth-card-${op.kind}`}
                          className="flex flex-col justify-between gap-3 rounded-xl border border-border/70 bg-secondary/15 p-3.5"
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-secondary/60">
                              <VendorLogo vendorKey={op.kind} />
                            </div>
                            <div className="min-w-0">
                              <div className="text-[13px] font-semibold text-foreground">{op.title}</div>
                              <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{op.desc}</div>
                            </div>
                          </div>
                          <div className="space-y-2">
                            {op.note && (
                              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[10.5px] leading-relaxed text-amber-400">
                                {op.note}
                              </div>
                            )}
                            {boundToThis && (
                              <div
                                className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-[11.5px] space-y-0.5"
                                data-testid="oauth-account-card"
                              >
                                <div className="flex items-center gap-1.5 font-medium text-emerald-500">
                                  <CheckIcon className="size-3.5" />
                                  <span>{oauthAccount ? "订阅登录成功" : "已登录"}</span>
                                </div>
                                <div className="text-foreground/90">账号：{boundToThis.accountEmail ?? "未知"}</div>
                                <div className="text-muted-foreground">套餐：{boundToThis.planName ?? "—"}</div>
                                <div className="text-muted-foreground">
                                  令牌过期：{formatTokenExpiry(boundToThis.tokenExpiresAt)}
                                </div>
                                {!draft.id && <div className="text-amber-400">点击下方「保存新厂商」完成绑定</div>}
                              </div>
                            )}
                            {oauthError && oauthSession?.kind === op.kind && (
                              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2 text-[11px] text-rose-400">
                                {oauthError}
                              </div>
                            )}
                            <button
                              type="button"
                              data-testid={`oauth-login-${op.kind}`}
                              disabled={oauthPhase === "starting" || oauthPhase === "pending"}
                              onClick={() => void handleStartOAuth(op)}
                              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-input bg-transparent px-3 py-1.5 text-[12px] text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                            >
                              {isThisStarting ? (
                                <>
                                  <RefreshCwIcon className="size-3.5 animate-spin" />
                                  <span>{op.flow === "device" ? "正在申请设备码…" : "正在打开浏览器…"}</span>
                                </>
                              ) : isThisPending ? (
                                <>
                                  <RefreshCwIcon className="size-3.5 animate-spin" />
                                  <span>
                                    {op.flow === "device"
                                      ? "等待你在授权页输入设备码…（自动检测）"
                                      : "等待浏览器授权完成…（5 分钟内有效）"}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <ExternalLinkIcon className="size-3.5" />
                                  <span>{op.flow === "device" ? "获取设备码并打开授权页" : "打开浏览器登录"}</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {oauthFallbackUrl && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11.5px] text-amber-400">
                      浏览器弹窗被拦截？{" "}
                      <a href={oauthFallbackUrl} target="_blank" rel="noreferrer" className="font-medium underline">
                        点击此链接打开授权页
                      </a>
                    </div>
                  )}

                  {/* 已保存厂商的订阅登录管理操作 */}
                  {boundOAuthAccount && draft.id && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid="oauth-refresh-btn"
                        disabled={oauthBusyKind !== null}
                        onClick={() => void handleOAuthRefresh()}
                        className="flex items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[11.5px] text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                      >
                        <RefreshCwIcon className={cn("size-3", oauthBusyKind === "refresh" && "animate-spin")} />
                        <span>{oauthBusyKind === "refresh" ? "刷新中…" : "刷新令牌"}</span>
                      </button>
                      <button
                        type="button"
                        data-testid="oauth-logout-btn"
                        disabled={oauthBusyKind !== null}
                        onClick={() => void handleOAuthLogout()}
                        className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-transparent px-2.5 py-1 text-[11.5px] text-rose-400 hover:bg-rose-500/10 disabled:opacity-50 transition-colors"
                      >
                        <LogOutIcon className="size-3" />
                        <span>{oauthBusyKind === "logout" ? "退出中…" : "退出登录"}</span>
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                /* API Key 输入（保持原有交互不变） */
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
              )}

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

              {/* 余额查询（已保存厂商；DeepSeek / Moonshot Kimi / SiliconFlow 等） */}
              {isEditing && draft.id && (
                <div
                  className="rounded-xl border border-border bg-background/40 p-3.5 space-y-2.5 settings-balance-box"
                  data-testid="balance-card"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-foreground/90">余额查询</span>
                    <button
                      type="button"
                      data-testid="balance-refresh-btn"
                      disabled={activeBalanceLoading}
                      onClick={() => draft.id && void loadBalance(draft.id)}
                      className="flex items-center gap-1.5 rounded-lg border border-input bg-transparent px-2.5 py-1 text-[11.5px] text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                    >
                      <RefreshCwIcon className={cn("size-3", activeBalanceLoading && "animate-spin")} />
                      <span>{activeBalanceLoading ? "查询中…" : "刷新余额"}</span>
                    </button>
                  </div>
                  {activeBalance?.ok ? (
                    <div data-testid="balance-content">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-[24px] font-semibold leading-none text-foreground">
                          {moneyText(activeBalance.balance, activeBalance.currency)}
                        </span>
                        <span className="text-[12px] text-muted-foreground">
                          {activeBalance.currency ?? ""}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
                        {activeBalance.granted != null && (
                          <span>赠送额度：{moneyText(activeBalance.granted, activeBalance.currency)}</span>
                        )}
                        {activeBalance.toppedUp != null && (
                          <span>充值余额：{moneyText(activeBalance.toppedUp, activeBalance.currency)}</span>
                        )}
                        {activeBalance.used != null && <span>已使用：{moneyText(activeBalance.used, activeBalance.currency)}</span>}
                        {activeBalance.vendor && (
                          <span className="uppercase tracking-wide">{activeBalance.vendor}</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-[11.5px] text-muted-foreground">
                      {activeBalance
                        ? activeBalance.message ?? "该厂商暂不支持余额查询。"
                        : activeBalanceLoading
                          ? "正在查询余额…"
                          : "点击「刷新余额」查询当前厂商余额（当前支持 DeepSeek / Moonshot Kimi / SiliconFlow）。"}
                    </p>
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

        {/* AI 厂商表单视图：固定底部操作栏（启用/测试连接/保存），不随表单内容滚动。
            作为 main（flex-col）的 shrink-0 子元素钉在弹窗底部，滚动区 flex-1 自动避让。 */}
        {activeTab === "ai" && editingView && (
          <div
            className="shrink-0 border-t border-border bg-card px-7 pb-5 pt-3"
            data-testid="settings-ai-form-action-bar"
          >
            {testResult && (
              <div
                className={cn(
                  "mb-2.5 rounded-xl border p-2.5 text-[12px]",
                  testResult.ok
                    ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-500"
                    : "border-rose-500/60 bg-rose-500/10 text-rose-400",
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
            <div className="flex flex-wrap items-center justify-between gap-3">
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
          </div>
        )}
      </main>
    </div>
  );
}
