/**
 * 聊天输入区。
 *
 * 严格对齐 AI SDK Elements 官网规范 (https://elements.ai-sdk.dev/components/prompt-input)：
 * 1. 采用官方 PromptInput / PromptInputBody / PromptInputFooter / PromptInputTools / PromptInputSubmit 架构。
 * 2. 初始绝无白色边框：采用深邃无高亮白边的暗色系边框（border-zinc-800/80 bg-zinc-950/70）。
 * 3. 发送按钮采用官网示例：PromptInputSubmit（流式生成时自动变为停止方块，就绪时为 CornerDownLeft 回车发送图标）。
 * 4. 思考等级与推理强度升级为标准下拉选择（Dropdown / Select）样式，严格遵守模型能力约束（如 step-3.5-flash-2603 仅限 low / high）。
 */

import { useState, useRef, useEffect } from "react";
import {
  ChevronDownIcon,
  CheckIcon,
  SettingsIcon,
  BrainIcon,
  FolderIcon,
  PlusIcon,
  MessageSquareIcon,
  HandIcon,
  ShieldCheckIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
  TerminalSquareIcon,
  GlobeIcon,
} from "lucide-react";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputSubmit,
  type PromptInputMessage,
  usePromptInputAttachments,
} from "../../components/ai-elements/prompt-input.js";
import {
  REASONING_EFFORTS,
  type Activity,
  type PermissionMode,
  type ReasoningEffort,
  type RunTokenUsage,
} from "@deepagent/shared";
import type { ChatMessage } from "./client-reducer.js";
import { StatsLine, ContextMeter } from "./session-stats.js";
import { cn } from "../../lib/utils.js";
import { extractFolderName } from "./use-sessions.js";
import { ChatAttachmentGallery, ImagePreviewDialog, type ChatAttachment } from "./chat-attachments.js";
import { TodoCard } from "./todo-card.js";

interface ChatInputProps {
  /** 当前会话消息列表，用于计算精准统计与 Token 消耗 */
  messages?: ChatMessage[];
  /** 当前会话活动列表，用于计算工具耗时与步骤 */
  activities?: Activity[];
  onSend: (content: string, attachments: ChatAttachment[]) => void;
  onStop: () => void;
  isRunning: boolean;
  effort: ReasoningEffort;
  onEffortChange: (effort: ReasoningEffort) => void;
  supportedEfforts: readonly ReasoningEffort[];
  reasoningUnsupported: boolean;
  fallbackApplied: boolean;
  /** 用户原始请求的推理档位（fallbackApplied 时用于显示降级说明）。 */
  requestedEffort?: ReasoningEffort;
  modelStatus: string;
  modelStatusKind: "ok" | "warn" | "error";
  disabled?: boolean;
  /** 可供下拉切换的模型列表 */
  availableModels?: string[];
  /** 当前选中的模型 ID */
  currentModel?: string | null;
  /** 切换模型回调 */
  onSelectModel?: (model: string) => void;
  /** 打开模型设置模态框 */
  onOpenSettings?: () => void;
  /** 当前工作区根目录（若为空或 null 则为直接聊天模式） */
  workspaceRoot?: string | null;
  /** 已添加的工作区列表 */
  customWorkspaces?: string[];
  /** 选择工作区或切换至直接聊天模式（传 null） */
  onSelectWorkspace?: (path: string | null) => void;
  /** 打开系统文件夹选择器弹窗 */
  onOpenFolderPicker?: () => void;
  /** 最近一次运行的 Token 用量（无数据时显示占位提示）。 */
  usage?: RunTokenUsage | null;
  /** 当前会话最新待办计划，显示在输入框上方。 */
  todoActivity?: Activity | null;
  /** 当前会话最近一份待办计划。 */
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
}

const PERMISSION_OPTIONS: Array<{
  mode: PermissionMode;
  label: string;
  description: string;
  Icon: typeof HandIcon;
}> = [
  {
    mode: "ask",
    label: "请求批准",
    description: "写入、修改、删除文件或运行命令时逐项确认",
    Icon: HandIcon,
  },
  {
    mode: "auto",
    label: "帮我批准",
    description: "自动处理写入和修改；删除文件或运行命令时确认",
    Icon: ShieldCheckIcon,
  },
  {
    mode: "full",
    label: "完全访问权限",
    description: "跳过逐项审批；访问范围取决于服务端开放的工具",
    Icon: ShieldAlertIcon,
  },
];

const ACCEPTED_ATTACHMENT_TYPES =
  "image/*,application/pdf,text/plain,text/markdown,text/csv,application/json,application/xml,text/html,application/x-yaml,text/yaml";
const MAX_ATTACHMENT_COUNT = 4;
const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 12 * 1024 * 1024;

function PromptInputAttachmentsDisplay({
  onPreview,
}: {
  onPreview: (file: ChatAttachment) => void;
}) {
  const attachments = usePromptInputAttachments();
  return (
    <ChatAttachmentGallery
      files={attachments.files}
      onPreview={onPreview}
      onRemove={attachments.remove}
    />
  );
}

function PromptInputSubmitWithAttachments({
  hasText,
  isRunning,
  onStop,
}: {
  hasText: boolean;
  isRunning: boolean;
  onStop: () => void;
}) {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputSubmit
      disabled={!hasText && attachments.files.length === 0 && !isRunning}
      status={isRunning ? "streaming" : undefined}
      onStop={onStop}
      className="size-8 rounded-lg bg-zinc-100 text-black hover:bg-white disabled:opacity-30 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors shadow-none"
    />
  );
}

export function ChatInput({
  onSend,
  onStop,
  isRunning,
  effort,
  onEffortChange,
  supportedEfforts,
  reasoningUnsupported,
  fallbackApplied,
  requestedEffort,
  modelStatus,
  disabled = false,
  availableModels = [],
  currentModel,
  onSelectModel,
  onOpenSettings,
  workspaceRoot,
  customWorkspaces = [],
  onSelectWorkspace,
  messages = [],
  activities = [],
  onOpenFolderPicker,
  usage,
  todoActivity,
  permissionMode,
  onPermissionModeChange,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<ChatAttachment | null>(null);

  // 工作区下拉选择状态
  const [isWorkspaceDropdownOpen, setIsWorkspaceDropdownOpen] = useState(false);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);
  const todoCardRef = useRef<HTMLDivElement>(null);

  // 模型下拉菜单状态
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // 思考等级下拉菜单状态
  const [isEffortDropdownOpen, setIsEffortDropdownOpen] = useState(false);
  const effortDropdownRef = useRef<HTMLDivElement>(null);
  const [isPermissionDropdownOpen, setIsPermissionDropdownOpen] = useState(false);
  const permissionDropdownRef = useRef<HTMLDivElement>(null);
  const [showFullAccessConfirmation, setShowFullAccessConfirmation] = useState(false);

  const selectPermissionMode = (mode: PermissionMode) => {
    setIsPermissionDropdownOpen(false);
    if (mode === "full" && permissionMode !== "full") {
      setShowFullAccessConfirmation(true);
      return;
    }
    onPermissionModeChange(mode);
  };

  // 点击外部自动关闭下拉框
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const clickedTodoCard = todoCardRef.current?.contains(target) === true;
      if (
        workspaceDropdownRef.current &&
        !workspaceDropdownRef.current.contains(target) &&
        !clickedTodoCard
      ) {
        setIsWorkspaceDropdownOpen(false);
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(target)) {
        setIsModelDropdownOpen(false);
      }
      if (effortDropdownRef.current && !effortDropdownRef.current.contains(target)) {
        setIsEffortDropdownOpen(false);
      }
      if (permissionDropdownRef.current && !permissionDropdownRef.current.contains(target)) {
        setIsPermissionDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const hasText = text.trim().length > 0;

  const handleSubmit = (message: PromptInputMessage) => {
    const content = (message.text || text).trim();
    const attachments = message.files;
    if ((content.length > 0 || attachments.length > 0) && !isRunning && !disabled) {
      const totalBytes = attachments.reduce((total, file) => {
        const payload = file.url.match(/^data:[^;,]+;base64,([\s\S]+)$/)?.[1] ?? "";
        return total + Math.floor((payload.length * 3) / 4);
      }, 0);
      if (attachments.some((file) => !file.url.startsWith("data:"))) {
        setAttachmentError("附件读取失败，请移除后重新添加。");
        return;
      }
      if (totalBytes > MAX_TOTAL_ATTACHMENT_SIZE) {
        setAttachmentError("附件总大小不能超过 12 MB，请移除部分文件后重试。");
        return;
      }
      onSend(content || "请查看附件中的内容。", attachments);
      setAttachmentError(null);
      setText("");
    }
  };

  const handleAttachmentError = (error: { code: "max_files" | "max_file_size" | "accept" }) => {
    const messages = {
      accept: "暂只支持图片、PDF 和常见文本文件（TXT、Markdown、CSV、JSON、XML、HTML、YAML）。",
      max_file_size: "单个附件不能超过 5 MB。",
      max_files: "一次最多添加 4 个附件。",
    };
    setAttachmentError(messages[error.code]);
  };

  const effortLabel = effort === "high" ? "高" : effort === "medium" ? "中" : "低";

  const isDirectChat = !workspaceRoot || workspaceRoot.trim() === "";
  const currentWorkspaceName = isDirectChat ? "直接聊天模式" : extractFolderName(workspaceRoot);
  const currentWorkspacePath = isDirectChat ? "" : workspaceRoot;

  return (
    <div className="shrink-0 bg-black px-4 py-4">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-2 flex min-w-0 items-end gap-2">
          {/* 工作区选择器保持在左侧；待办状态在其右侧同行展示。 */}
          <div className="relative flex w-fit shrink-0 items-center" ref={workspaceDropdownRef}>
          <button
            type="button"
            data-testid="workspace-mode-selector"
            onClick={() => {
              setIsWorkspaceDropdownOpen((v) => !v);
              setIsModelDropdownOpen(false);
              setIsEffortDropdownOpen(false);
            }}
            className="group inline-flex items-center gap-1.5 rounded-xl bg-transparent hover:bg-zinc-900/80 px-2.5 py-1 text-[13px] font-medium text-zinc-100 transition-colors select-none max-w-[280px] border-0 outline-none"
            title={isDirectChat ? "当前工作区：直接聊天（未绑定目录，点击可切换工作区）" : `当前绑定工作区：${currentWorkspacePath}（点击可切换工作区）`}
          >
            {isDirectChat ? (
              <MessageSquareIcon className="size-4 text-zinc-300 shrink-0" />
            ) : (
              <FolderIcon className="size-4 text-zinc-300 shrink-0" />
            )}
            <span className="text-zinc-400 font-normal mr-0.5 text-[12px]">工作区:</span>
            <span className="truncate">
              {isDirectChat ? "直接聊天" : currentWorkspaceName}
            </span>
            <ChevronDownIcon
              className={cn(
                "size-3.5 text-zinc-400 shrink-0 transition-transform duration-200 ml-0.5",
                isWorkspaceDropdownOpen && "rotate-180 text-zinc-200",
              )}
            />
          </button>

          {/* 下拉菜单面板（大圆角、深灰底、无多余线条、移动悬浮高亮） */}
          {isWorkspaceDropdownOpen && (
            <div className="workspace-dropdown-panel absolute left-0 bottom-full mb-2 z-50 w-64 rounded-2xl bg-[#242427] p-1.5 shadow-2xl border-0 animate-in fade-in zoom-in-95 duration-100">
              {/* 选项 1：直接聊天模式 */}
              <button
                type="button"
                onClick={() => {
                  onSelectWorkspace?.(null);
                  setIsWorkspaceDropdownOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors select-none",
                  isDirectChat
                    ? "bg-[#2f2f35] text-white font-medium"
                    : "text-zinc-200 hover:bg-[#2f2f35] hover:text-white",
                )}
              >
                <MessageSquareIcon className="size-4 text-zinc-300 shrink-0" />
                <span className="truncate">直接聊天</span>
                {isDirectChat && <CheckIcon className="size-4 text-white shrink-0 ml-auto" />}
              </button>

              {/* 选项 2..N：工作区列表（无多余分割线，干净紧凑排列） */}
              <div className="max-h-[220px] overflow-y-auto space-y-0.5 my-0.5 scrollbar-thin scrollbar-thumb-zinc-700">
                {customWorkspaces && customWorkspaces.length > 0
                  ? customWorkspaces.map((wsPath) => {
                      const isSelected =
                        !isDirectChat &&
                        (currentWorkspacePath === wsPath ||
                          currentWorkspacePath.toLowerCase() === wsPath.toLowerCase());
                      const name = extractFolderName(wsPath);
                      return (
                        <button
                          key={wsPath}
                          type="button"
                          onClick={() => {
                            onSelectWorkspace?.(wsPath);
                            setIsWorkspaceDropdownOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors select-none",
                            isSelected
                              ? "bg-[#2f2f35] text-white font-medium"
                              : "text-zinc-200 hover:bg-[#2f2f35] hover:text-white",
                          )}
                        >
                          <FolderIcon className="size-4 text-zinc-300 shrink-0" />
                          <span className="truncate">{name}</span>
                          {isSelected && <CheckIcon className="size-4 text-white shrink-0 ml-auto" />}
                        </button>
                      );
                    })
                  : null}
              </div>

              {/* 选项：添加工作区...（使用加号图标，无额外分割线） */}
              <button
                type="button"
                onClick={() => {
                  setIsWorkspaceDropdownOpen(false);
                  onOpenFolderPicker?.();
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] text-zinc-200 hover:bg-[#2f2f35] hover:text-white transition-colors select-none"
              >
                <PlusIcon className="size-4 text-zinc-300 shrink-0" />
                <span className="truncate">添加工作区...</span>
              </button>
            </div>
          )}
          </div>
        </div>

        {todoActivity ? (
          <div ref={todoCardRef} className="mb-2 min-w-0">
            <TodoCard activity={todoActivity} />
          </div>
        ) : null}

        {/* DeepSeek Harness 主页面底栏统计条 (StatsLine) */}
        <StatsLine
          messages={messages}
          activities={activities}
          providedUsage={usage}
        />

        <PromptInputProvider>
          {/* 纯暗黑极简边框：无任何刺眼白色外框，深邃内敛 */}
          <PromptInput
            onSubmit={handleSubmit}
            accept={ACCEPTED_ATTACHMENT_TYPES}
            multiple
            globalDrop
            maxFiles={MAX_ATTACHMENT_COUNT}
            maxFileSize={MAX_ATTACHMENT_SIZE}
            onError={handleAttachmentError}
            className="rounded-2xl border border-zinc-800/80 bg-zinc-950/70 shadow-none focus-within:border-zinc-600 focus-within:ring-0 transition-colors overflow-visible outline-none"
          >
            <PromptInputHeader className="px-3 pt-3">
              <PromptInputAttachmentsDisplay onPreview={setPreviewAttachment} />
            </PromptInputHeader>
            <PromptInputBody>
              <PromptInputTextarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="输入任务描述...（Enter 发送，Shift+Enter 换行）"
                className="min-h-[50px] max-h-[220px] px-3.5 py-2.5 text-[13.5px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none border-0 shadow-none focus-visible:ring-0"
              />
            </PromptInputBody>

            {/* 底部工具条与提交按钮 */}
            <PromptInputFooter className="flex items-center justify-between px-3 pb-2.5 pt-1.5 border-t border-zinc-800/40 overflow-visible">
              <PromptInputTools className="flex items-center gap-2.5 text-[12px]">
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger
                    aria-label="添加图片或文件"
                    title="添加图片或文件"
                    className="size-8 rounded-lg text-zinc-300 hover:bg-zinc-800/70"
                  />
                  <PromptInputActionMenuContent className="border-zinc-700 bg-zinc-900 text-zinc-100">
                    <PromptInputActionAddAttachments label="添加图片或文件" />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                {/* 运行权限选择：只影响后续发起的运行。 */}
                <div className="relative" ref={permissionDropdownRef}>
                  <button
                    type="button"
                    data-testid="permission-mode-selector"
                    aria-label={`权限模式：${PERMISSION_OPTIONS.find((option) => option.mode === permissionMode)?.label ?? "请求批准"}`}
                    onClick={() => {
                      setIsPermissionDropdownOpen((open) => !open);
                      setIsModelDropdownOpen(false);
                      setIsEffortDropdownOpen(false);
                    }}
                    className={cn(
                      "composer-selector flex items-center gap-1.5 rounded-md px-2 py-1 text-zinc-300 transition-colors",
                      permissionMode === "full"
                        ? "border border-amber-500/70 bg-amber-500/15 text-amber-300 font-medium shadow-[0_0_8px_rgba(245,158,11,0.2)] hover:bg-amber-500/20"
                        : "bg-transparent hover:bg-zinc-800/70 hover:text-white",
                    )}
                    title={
                      permissionMode === "full"
                        ? "⚠️ 危险模式：已开启完全访问权限（Agent免审批直接执行Shell命令与修改文件）"
                        : "选择本次及后续运行的工具审批方式"
                    }
                  >
                    {(() => {
                      const option = PERMISSION_OPTIONS.find((item) => item.mode === permissionMode) ?? PERMISSION_OPTIONS[0]!;
                      return <option.Icon className={cn("size-3.5 shrink-0", permissionMode === "full" ? "text-amber-400" : "text-zinc-400")} />;
                    })()}
                    <span className={cn("text-[11.5px] font-medium", permissionMode === "full" && "text-amber-300")}>
                      {PERMISSION_OPTIONS.find((option) => option.mode === permissionMode)?.label ?? "请求批准"}
                    </span>
                    <ChevronDownIcon className={cn("size-3 text-zinc-500 transition-transform", isPermissionDropdownOpen && "rotate-180")} />
                  </button>

                  {isPermissionDropdownOpen && (
                    <div className="workspace-dropdown-panel composer-menu absolute bottom-full left-0 z-50 mb-2 w-[min(21rem,calc(100vw-2rem))] rounded-xl border border-zinc-700/70 bg-[#242427] p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                      {PERMISSION_OPTIONS.map(({ mode, label, description, Icon }) => {
                        const isSelected = permissionMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            data-testid={`permission-mode-${mode}`}
                            aria-pressed={isSelected}
                            onClick={() => {
                              selectPermissionMode(mode);
                            }}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                              isSelected ? "bg-[#2f2f35]" : "hover:bg-[#2f2f35]",
                            )}
                          >
                            <Icon className={cn("size-5 shrink-0", mode === "full" ? "text-orange-400" : "text-zinc-300")} />
                            <span className="min-w-0 flex-1">
                              <span className={cn("block text-[13px] font-medium", mode === "full" && "text-orange-400")}>
                                {label}
                              </span>
                              <span className="block text-[11.5px] leading-snug text-zinc-400">
                                {description}
                              </span>
                            </span>
                            {isSelected && <CheckIcon className={cn("size-4 shrink-0", mode === "full" ? "text-orange-400" : "text-zinc-200")} />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 1. 模型选择下拉菜单 */}
                <div className="relative" ref={modelDropdownRef}>
                  <button
                    type="button"
                    onClick={() => {
                      setIsModelDropdownOpen((v) => !v);
                      setIsEffortDropdownOpen(false);
                      setIsPermissionDropdownOpen(false);
                    }}
                    className="composer-selector flex items-center gap-1.5 rounded-md bg-transparent px-2.5 py-1 text-zinc-300 transition-colors hover:bg-zinc-800/70 hover:text-white"
                    title="点击下拉切换当前模型"
                  >
                    <span className="size-1.5 rounded-full bg-emerald-400 shrink-0" />
                    <span className="font-mono truncate max-w-[170px] text-[11.5px]">
                      {currentModel || modelStatus}
                    </span>
                    <ChevronDownIcon className={cn("size-3 text-zinc-500 shrink-0 ml-0.5 transition-transform", isModelDropdownOpen && "rotate-180")} />
                  </button>

                  {/* 弹出式模型下拉列表 */}
                  {isModelDropdownOpen && (
                    <div className="workspace-dropdown-panel composer-menu absolute bottom-full mb-2 left-0 z-50 w-64 rounded-xl border border-zinc-800 bg-[#242427] p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                      <div className="px-2 py-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wider flex items-center justify-between">
                        <span>选择模型</span>
                        {availableModels.length > 0 && <span>({availableModels.length})</span>}
                      </div>

                      <div className="max-h-48 overflow-y-auto space-y-0.5 my-1">
                        {availableModels.length === 0 ? (
                          <div className="px-2 py-2 text-[11.5px] text-zinc-500 text-center">
                            暂无可用模型，请在设置中配置
                          </div>
                        ) : (
                          availableModels.map((m) => {
                            const isSelected = currentModel === m;
                            return (
                              <button
                                key={m}
                                type="button"
                                onClick={() => {
                                  onSelectModel?.(m);
                                  setIsModelDropdownOpen(false);
                                }}
                                className={`flex w-full items-center justify-between px-2 py-1.5 rounded-md text-[12px] font-mono text-left transition-colors ${
                                  isSelected
                                    ? "bg-[#2f2f35] text-white font-medium"
                                    : "text-zinc-400 hover:bg-[#2f2f35] hover:text-zinc-200"
                                }`}
                              >
                                <span className="truncate">{m}</span>
                                {isSelected && <CheckIcon className="size-3 text-emerald-400 shrink-0" />}
                              </button>
                            );
                          })
                        )}
                      </div>

                      {onOpenSettings && (
                        <div className="pt-1 border-t border-zinc-800/80">
                          <button
                            type="button"
                            onClick={() => {
                              setIsModelDropdownOpen(false);
                              onOpenSettings();
                            }}
                            className="flex w-full items-center gap-1.5 px-2 py-1 text-[11.5px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 rounded transition-colors"
                          >
                            <SettingsIcon className="size-3 text-zinc-500" />
                            <span>管理模型与提供商...</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 1.5 DeepSeek Harness 原生 ContextMeter：环形占用率仪表圈与上下文构成/用量面板 */}
                <ContextMeter
                  messages={messages}
                  activities={activities}
                  providedUsage={usage}
                />

                {/* 2. 思考等级下拉选择样式 */}
                <div className="relative" ref={effortDropdownRef}>
                  <button
                    type="button"
                    disabled={reasoningUnsupported}
                    onClick={() => {
                      setIsEffortDropdownOpen((v) => !v);
                      setIsModelDropdownOpen(false);
                      setIsPermissionDropdownOpen(false);
                    }}
                    className={cn(
                      "composer-selector flex items-center gap-1.5 rounded-md bg-transparent px-2 py-1 transition-colors hover:bg-zinc-800/70",
                      reasoningUnsupported ? "opacity-40 cursor-not-allowed text-zinc-600" : "text-zinc-300 hover:text-white"
                    )}
                    title={
                      reasoningUnsupported
                        ? "当前模型不支持调节思考等级"
                        : fallbackApplied
                          ? `已自动降级：当前模型不支持「${requestedEffort === "high" ? "高" : requestedEffort === "medium" ? "中" : "低"}」档位，实际使用「${effortLabel}」`
                          : "点击切换思考等级"
                    }
                  >
                    <BrainIcon className="size-3 text-zinc-400 shrink-0" />
                    <span className="text-[11.5px] font-medium">
                      思考: {reasoningUnsupported ? "无" : effortLabel}
                    </span>
                    {fallbackApplied && (
                      <span
                        className="size-1.5 rounded-full bg-amber-400 shrink-0"
                        aria-label="推理强度已降级"
                      />
                    )}
                    <ChevronDownIcon className={cn("size-3 text-zinc-500 shrink-0 ml-0.5 transition-transform", isEffortDropdownOpen && "rotate-180")} />
                  </button>

                  {/* 弹出式思考等级下拉列表 */}
                  {isEffortDropdownOpen && (
                    <div className="workspace-dropdown-panel composer-menu absolute bottom-full mb-2 left-0 z-50 w-44 rounded-xl border border-zinc-800 bg-[#242427] p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                      <div className="px-2 py-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                        思考等级 / 推理强度
                      </div>

                      {fallbackApplied && (
                        <div className="mx-1 mb-1 rounded-md bg-amber-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-300/90">
                          已自动降级：当前模型不支持
                          「{requestedEffort === "high" ? "高" : requestedEffort === "medium" ? "中" : "低"}」
                          档位，本次运行实际使用「{effortLabel}」。
                        </div>
                      )}

                      <div className="space-y-0.5 my-1">
                        {REASONING_EFFORTS.map((option) => {
                          const supported = supportedEfforts.includes(option);
                          const isSelected = effort === option;
                          const title = option === "high" ? "高 (high)" : option === "medium" ? "中 (medium)" : "低 (low)";
                          const desc = option === "high" ? "深度多步思考" : option === "medium" ? "均衡推理与速度" : "快速响应思考";

                          if (!supported) {
                            return (
                              <div
                                key={option}
                                className="flex items-center justify-between px-2 py-1.5 rounded-md text-[11.5px] text-zinc-600 cursor-not-allowed select-none"
                                title="当前模型不支持此档位（如 step-3.5-flash-2603 仅限低与高）"
                              >
                                <span>{title}</span>
                                <span className="text-[10px] text-zinc-600">不支持</span>
                              </div>
                            );
                          }

                          return (
                            <button
                              key={option}
                              type="button"
                              onClick={() => {
                                onEffortChange(option);
                                setIsEffortDropdownOpen(false);
                              }}
                              className={`flex w-full items-center justify-between px-2 py-1.5 rounded-md text-[12px] text-left transition-colors ${
                                isSelected
                                  ? "bg-[#2f2f35] text-white font-medium"
                                  : "text-zinc-400 hover:bg-[#2f2f35] hover:text-zinc-200"
                              }`}
                            >
                              <div className="flex flex-col">
                                <span>{title}</span>
                                <span className="text-[10.5px] text-zinc-500 font-normal">{desc}</span>
                              </div>
                              {isSelected && <CheckIcon className="size-3 text-emerald-400 shrink-0 ml-1" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </PromptInputTools>

              {/* 右侧：官网标准的 PromptInputSubmit 提交/停止按钮 */}
              <PromptInputSubmitWithAttachments
                hasText={hasText}
                isRunning={isRunning}
                onStop={onStop}
              />
            </PromptInputFooter>
          </PromptInput>
          {attachmentError && (
            <p role="alert" className="px-3 pt-2 text-xs text-red-300">
              {attachmentError}
            </p>
          )}
        </PromptInputProvider>
      </div>

      <ImagePreviewDialog
        file={previewAttachment}
        onOpenChange={(open) => {
          if (!open) setPreviewAttachment(null);
        }}
      />

      {showFullAccessConfirmation && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowFullAccessConfirmation(false);
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="full-access-title"
            aria-describedby="full-access-description"
            className="w-full max-w-[680px] max-h-[calc(100vh-2rem)] overflow-y-auto rounded-[22px] border border-border bg-card p-7 text-card-foreground shadow-2xl sm:p-8"
          >
            <div className="flex items-center gap-3">
              <TriangleAlertIcon className="size-7 shrink-0 text-amber-400" />
              <h2 id="full-access-title" className="text-2xl font-semibold tracking-tight">要开启完全访问权限吗？</h2>
            </div>
            <p id="full-access-description" className="mt-5 text-base leading-relaxed text-muted-foreground">
              开启后，Agent 将跳过逐项审批，并可使用当前服务端已启用的工具。请确认你信任当前模型和工作区内容。
            </p>

            <div className="mt-4 divide-y divide-border rounded-2xl bg-secondary px-4">
              <div className="flex items-center gap-4 py-4">
                <FolderIcon className="size-7 shrink-0 text-sky-400" />
                <div>
                  <div className="text-base font-semibold">文件和文件夹</div>
                  <div className="text-sm leading-relaxed text-muted-foreground">可能读取、创建、修改或删除已授权工作区内的文件</div>
                </div>
              </div>
              <div className="flex items-center gap-4 py-4">
                <TerminalSquareIcon className="size-7 shrink-0 text-muted-foreground" />
                <div>
                  <div className="text-base font-semibold">终端命令</div>
                  <div className="text-sm leading-relaxed text-muted-foreground">如果服务端启用了命令工具，Agent 可直接运行命令</div>
                </div>
              </div>
              <div className="flex items-center gap-4 py-4">
                <GlobeIcon className="size-7 shrink-0 text-cyan-400" />
                <div>
                  <div className="text-base font-semibold">互联网和已连接的应用</div>
                  <div className="text-sm leading-relaxed text-muted-foreground">如果相关工具已启用，Agent 可访问网络或调用应用</div>
                </div>
              </div>
            </div>

            <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
              这可能带来敏感数据丢失或泄露、提示注入等风险。你可以随时切回其他权限模式。
            </p>
            <div className="mt-5 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowFullAccessConfirmation(false)}
                className="rounded-full bg-secondary px-6 py-3 text-base font-medium text-secondary-foreground transition-colors hover:bg-accent"
              >
                取消
              </button>
              <button
                type="button"
                data-testid="confirm-full-access"
                onClick={() => {
                  onPermissionModeChange("full");
                  setShowFullAccessConfirmation(false);
                }}
                className="inline-flex items-center gap-2 rounded-full bg-destructive/10 px-6 py-3 text-base font-medium text-destructive transition-colors hover:bg-destructive/20"
              >
                <TriangleAlertIcon className="size-4" />
                确认
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
