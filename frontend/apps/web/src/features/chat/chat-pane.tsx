/**
 * 单屏聊天面板（移植自 langchain 项目 0bd92e5/b8799de 两个提交）。
 *
 * SplitChatView 的左右两个窗格各自渲染一个 ChatPane：
 * 每个 pane 拥有独立的 Header（标题 / 关闭 / 互换）、消息时间线、
 * 人工审批栏与底部输入框，可以独立切换、运行各自的会话。
 */
import { useMemo, useState } from "react";
import type { Activity, PermissionMode, PublicProvider, ReasoningEffort } from "@deepagent/shared";
import type { ClientState } from "./client-reducer.js";
import { ChatMessages } from "./chat-messages.js";
import { ChatInput } from "./chat-input.js";
import { ApprovalCard } from "./approval-card.js";
import type { ChatAttachment } from "./chat-attachments.js";
import {
  AlertCircleIcon,
  Columns2Icon,
  PanelLeftIcon,
  PanelRightIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

export interface ChatPaneProps {
  paneId: "left" | "right";
  isSplit: boolean;
  sessionId: string;
  sessionTitle: string;
  state: ClientState;
  isRunning: boolean;
  effort: ReasoningEffort;
  supportedEfforts: readonly ReasoningEffort[];
  reasoningUnsupported: boolean;
  fallbackApplied: boolean;
  requestedEffort: ReasoningEffort;
  onEffortChange: (effort: ReasoningEffort) => void;
  availableModels: string[];
  currentModelId?: string;
  onSelectModel: (model: string) => void;
  modelStatus?: string;
  modelStatusKind?: "ok" | "warn" | "error";
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  workspaceRoot: string | null;
  customWorkspaces: string[];
  onSelectWorkspace: (path: string | null) => void;
  onOpenFolderPicker: () => void;
  onOpenSettings: () => void;
  canSend: boolean;
  onSend: (content: string, attachments?: ChatAttachment[]) => void;
  onStop: () => void;
  onRetry: (messageId: string) => void;
  onEditMessage: (messageId: string, content: string, attachments?: ChatAttachment[]) => void;
  onDecide: (activityId: string, decision: "approve" | "reject") => void;
  onSubmitDecisions: () => void;
  onCloseSplit?: () => void;
  onSwapPanes?: () => void;
  isSidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  isReviewOpen?: boolean;
  onToggleReview?: () => void;
  onBlockedSend?: (reason: string) => void;
  providerWarning?: string | null;
  onDismissProviderWarning?: () => void;
  onOpenSettingsFromWarning?: () => void;
  onDropSession?: (droppedSessionId: string) => void;
  /** 是否已配置可用大模型提供商（Maf Agent 输入框拦截用） */
  isProviderConfigured?: boolean;
  /** 联网搜索开关（Maf Agent 输入框） */
  webSearch?: boolean;
  onWebSearchChange?: (value: boolean) => void;
  /** 已配置的模型厂商列表（Maf Agent 输入框按厂商分组选择） */
  providers?: PublicProvider[];
  activeProviderId?: string | null;
  onSelectProviderModel?: (providerId: string, modelId: string) => void;
}

export function ChatPane({
  paneId,
  isSplit,
  sessionTitle,
  state,
  isRunning,
  effort,
  supportedEfforts,
  reasoningUnsupported,
  fallbackApplied,
  requestedEffort,
  onEffortChange,
  availableModels,
  currentModelId,
  onSelectModel,
  modelStatus,
  modelStatusKind,
  permissionMode,
  onPermissionModeChange,
  workspaceRoot,
  customWorkspaces,
  onSelectWorkspace,
  onOpenFolderPicker,
  onOpenSettings,
  canSend,
  onSend,
  onStop,
  onRetry,
  onEditMessage,
  onDecide,
  onSubmitDecisions,
  onCloseSplit,
  onSwapPanes,
  isSidebarOpen,
  onToggleSidebar,
  isReviewOpen,
  onToggleReview,
  onBlockedSend,
  providerWarning,
  onDismissProviderWarning,
  onOpenSettingsFromWarning,
  onDropSession,
  isProviderConfigured,
  webSearch,
  onWebSearchChange,
  providers,
  activeProviderId,
  onSelectProviderModel,
}: ChatPaneProps) {
  const latestTodoActivity = useMemo<Activity | null>(() => {
    const todos = state.activities.filter((activity) => activity.kind === "todo");
    return todos.reduce<Activity | null>(
      (latest, activity) => !latest || activity.startedAt >= latest.startedAt ? activity : latest,
      null,
    );
  }, [state.activities]);

  const pendingInterrupts = state.run.interrupts;
  const hasDecisions =
    pendingInterrupts.length > 0 &&
    pendingInterrupts.every((interrupt) => Boolean(state.pendingDecisions[interrupt.id]));

  // 该窗格是否已有聊天内容：新对话还没有内容时 Review 开关不展示
  const hasPaneContent = state.messages.length > 0 || state.activities.length > 0;

  // 支持向本窗格直接拖拽放置会话
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div
      data-testid={`chat-pane-${paneId}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-deepagent-session")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setIsDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        const droppedId = e.dataTransfer.getData("application/x-deepagent-session");
        if (droppedId) {
          onDropSession?.(droppedId);
        }
      }}
      className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-black ${
        isSplit ? (paneId === "left" ? "border-r border-zinc-200/80 dark:border-zinc-800/80" : "") : ""
      }`}
    >
      {/* 窗格拖拽放置指示遮罩 */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-sky-500/10 backdrop-blur-[2px] dark:bg-sky-950/40 border-2 border-dashed border-sky-400/80">
          <div className="flex items-center gap-2 rounded-xl bg-white/95 dark:bg-zinc-900/90 px-4 py-2 text-sm font-medium text-sky-700 dark:text-sky-200 shadow-xl border border-sky-500/40 dark:border-sky-600/40">
            <Columns2Icon className="size-4 text-sky-500 dark:text-sky-400" />
            <span>放置以在此处打开对话</span>
          </div>
        </div>
      )}

      {/* 顶部 Header */}
      <header className="flex h-12 shrink-0 items-center justify-between px-4 border-b border-zinc-200/80 dark:border-zinc-800/40 bg-white dark:bg-black select-none">
        <div className="flex items-center gap-2.5 min-w-0">
          {paneId === "left" && !isSidebarOpen && onToggleSidebar && (
            <button
              type="button"
              onClick={onToggleSidebar}
              title="展开侧边栏"
              aria-label="展开侧边栏"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              <PanelLeftIcon className="size-4" />
            </button>
          )}

          <h2 className="truncate text-[13px] font-medium text-zinc-300" title={sessionTitle}>
            {sessionTitle}
          </h2>
        </div>

        {/* 右上角操作项 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning && (
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 max-w-44">
              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <span className="truncate">{state.run.progressNote || "运行中"}</span>
            </div>
          )}

          {isSplit && (
            <div className="flex items-center gap-1 ml-1">
              {paneId === "right" && onSwapPanes && (
                <button
                  type="button"
                  onClick={onSwapPanes}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
                  title="互换两栏位置"
                >
                  <Columns2Icon className="size-3.5" />
                </button>
              )}
              {onCloseSplit && (
                <button
                  type="button"
                  onClick={onCloseSplit}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
                  title="关闭此窗格"
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </div>
          )}

          {/* 代码审查(Review)边栏开关：仅主窗格展示，且新对话还没有聊天内容时不展示入口 */}
          {paneId === "left" && onToggleReview && hasPaneContent && (
            <button
              type="button"
              onClick={onToggleReview}
              title={isReviewOpen ? "收起代码审查侧边栏" : "展开代码审查侧边栏 (Review)"}
              aria-label="代码审查"
              className={`rounded p-1 transition-colors ${
                isReviewOpen
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
              }`}
            >
              <PanelRightIcon className="size-4" />
            </button>
          )}
        </div>
      </header>

      {/* 聊天内容与时间线 */}
      <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-white dark:bg-black">
        <ChatMessages
          messages={state.messages}
          activities={state.activities}
          error={state.run.error}
          isRunning={isRunning}
          runSnapshot={state.run}
          onRetry={onRetry}
          onEditMessage={onEditMessage}
          onQuickPrompt={(prompt) => onSend(prompt)}
        />

        {/* 人工审批通知栏 */}
        {pendingInterrupts.length > 0 ? (
          <div className="shrink-0 border-t border-border bg-card px-4 py-3">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
              <div className="max-h-[min(32vh,20rem)] space-y-2 overflow-y-auto">
                {pendingInterrupts.map((interrupt) => {
                  const activity = state.activities.find(
                    (item) => item.kind === "approval" && item.id === `approval:${interrupt.id}`,
                  );
                  if (!activity) return null;
                  const selectedDecision = state.pendingDecisions[interrupt.id]?.type;
                  const decision =
                    selectedDecision === "approve" || selectedDecision === "reject"
                      ? selectedDecision
                      : undefined;
                  return (
                    <ApprovalCard
                      key={interrupt.id}
                      activity={activity}
                      decision={decision}
                      onDecide={onDecide}
                    />
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-foreground text-[12.5px] font-medium">
                  <AlertCircleIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span>
                    需人工确认：{pendingInterrupts.length} 项操作
                    {hasDecisions ? "（已就绪）" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onSubmitDecisions}
                  disabled={!hasDecisions || isRunning}
                  title={
                    isRunning
                      ? "正在运行中"
                      : hasDecisions
                        ? "按已选择的决策恢复执行（未选择的将按批准处理）"
                        : "请先在审批卡片中点击「批准」或「拒绝」"
                  }
                  className="rounded-md bg-foreground text-background hover:bg-foreground/90 px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  继续执行
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* 未配置厂商或未填 Key 拦截警告提示 */}
        {providerWarning && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2 transition-all animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3.5 text-amber-200 shadow-xl backdrop-blur-md">
              <div className="flex items-start gap-2.5">
                <TriangleAlertIcon className="size-5 shrink-0 text-amber-400 mt-0.5" />
                <div className="space-y-1">
                  <div className="text-[13px] font-semibold text-amber-300 flex items-center gap-1.5">
                    <span>发送拦截警告</span>
                    <span className="text-[11px] font-normal px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                      未配置可用 API 厂商
                    </span>
                  </div>
                  <div className="text-[12.5px] text-amber-200/90 leading-relaxed">
                    {providerWarning}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={onOpenSettingsFromWarning}
                  className="rounded-lg bg-amber-500 hover:bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition-colors shadow-sm cursor-pointer"
                >
                  前往配置厂商
                </button>
                <button
                  type="button"
                  onClick={onDismissProviderWarning}
                  className="rounded-lg p-1.5 text-amber-400/80 hover:text-amber-200 hover:bg-amber-500/20 transition-colors cursor-pointer"
                  title="关闭提醒"
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 底部独立输入框 */}
        <ChatInput
          todoActivity={latestTodoActivity}
          onSend={onSend}
          onStop={onStop}
          isRunning={isRunning}
          effort={effort}
          onEffortChange={onEffortChange}
          supportedEfforts={supportedEfforts}
          reasoningUnsupported={reasoningUnsupported}
          fallbackApplied={fallbackApplied}
          requestedEffort={requestedEffort}
          modelStatus={modelStatus ?? ""}
          modelStatusKind={modelStatusKind ?? "error"}
          disabled={!canSend}
          onBlockedSend={onBlockedSend}
          isProviderConfigured={isProviderConfigured}
          webSearch={webSearch}
          onWebSearchChange={onWebSearchChange}
          availableModels={availableModels}
          currentModel={currentModelId}
          onSelectModel={onSelectModel}
          providers={providers}
          activeProviderId={activeProviderId}
          onSelectProviderModel={onSelectProviderModel}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          onOpenSettings={onOpenSettings}
          workspaceRoot={workspaceRoot}
          messages={state.messages}
          activities={state.activities}
          usage={state.run.usage ?? null}
          customWorkspaces={customWorkspaces}
          onSelectWorkspace={onSelectWorkspace}
          onOpenFolderPicker={onOpenFolderPicker}
        />
      </section>
    </div>
  );
}
