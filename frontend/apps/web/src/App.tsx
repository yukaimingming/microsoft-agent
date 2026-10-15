/**
 * DeepAgent 工作台主界面。
 *
 * 严格按照用户需求：
 * 1. 聊天界面样式完全对齐官网 AI Elements 例子
 * 2. 界面统一纯黑背景（bg-black），无杂乱底色
 * 3. 左侧边栏完全参考用户截图（每个文件夹下对应聊天记录，支持点击/自定义添加文件夹）
 * 4. 思考等级嵌入输入框内部底部排版
 * 5. 去掉右上角模型设置杂项
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Activity,
  availableEffortsForModel,
  resolveEffortForModel,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type PermissionMode,
  type ReasoningEffort,
} from "@deepagent/shared";
import { useAgentClient } from "./features/chat/use-agent-client.js";
import { ChatMessages } from "./features/chat/chat-messages.js";
import type { ClientState } from "./features/chat/client-reducer.js";
import { ChatInput } from "./features/chat/chat-input.js";
import type { ChatAttachment } from "./features/chat/chat-attachments.js";
import { WorkspaceSidebar } from "./features/chat/workspace-sidebar.js";
import { ApprovalCard } from "./features/chat/approval-card.js";
import { SettingsModal } from "./features/settings/settings-modal.js";
import { useProviderSettings } from "./features/settings/use-provider-settings.js";
import { useTheme } from "./features/settings/use-theme.js";
import { useSessions, normalizePath, type SessionSummary } from "./features/chat/use-sessions.js";
import { FolderPickerModal } from "./features/chat/folder-picker-modal.js";
import { PanelLeftIcon, AlertCircleIcon, PanelRightIcon, SunIcon, MoonIcon } from "lucide-react";
import { ReviewSidebar } from "./features/review/review-sidebar.js";

/** AG-UI 服务端地址：走代理或直接连接。 */
const AGENT_URL = "/agent";



export function App() {
  const settings = useProviderSettings();
  const { theme, setTheme } = useTheme();
  const {
    state,
    isRunning,
    runningThreadIds,
    allStates,
    send,
    stop,
    submitDecisions,
    newThread,
    setActiveThread,
    hasThread,
    disposeThread,
    loadState,
    setDecision,
    rollbackBeforeMessage,
    clearThread,
  } = useAgentClient(AGENT_URL);

  const latestTodoActivity = useMemo<Activity | null>(() => {
    const todos = state.activities.filter((activity) => activity.kind === "todo");
    return todos.reduce<Activity | null>(
      (latest, activity) => !latest || activity.startedAt >= latest.startedAt ? activity : latest,
      null,
    );
  }, [state.activities]);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // 侧边栏折叠/展开
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("agentscope_sidebar_open");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });

  const toggleSidebar = () => {
    setIsSidebarOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("agentscope_sidebar_open", String(next));
      } catch {
        // 忽略
      }
      return next;
    });
  };

  // 右侧代码审查侧边栏折叠/展开（支持记忆状态）
  const [isReviewOpen, setIsReviewOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("agentscope_review_open");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });

  const toggleReview = () => {
    setIsReviewOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("agentscope_review_open", String(next));
      } catch {
        // 忽略
      }
      return next;
    });
  };

  /** 当前工作区目录。若为 null 则表示单纯不在工作区的直接聊天模式。 */
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem("agentscope_current_workspace_v1");
      if (saved !== null) {
        return saved === "DIRECT_CHAT" ? null : saved;
      }
    } catch {
      // 忽略
    }
    return null;
  });

  // 持久化当前选中的工作区模式
  useEffect(() => {
    try {
      if (workspaceRoot === null || workspaceRoot.trim() === "") {
        localStorage.setItem("agentscope_current_workspace_v1", "DIRECT_CHAT");
      } else {
        localStorage.setItem("agentscope_current_workspace_v1", workspaceRoot);
      }
    } catch {
      // 忽略
    }
  }, [workspaceRoot]);

  // 会话管理器
  const sessionsManager = useSessions(state.threadId, workspaceRoot ?? "");
  const {
    sessions,
    groupedSessions,
    removeSession,
    renameSession,
    clearSessionState,
    saveSessionState,
    customWorkspaces,
    addWorkspace,
    removeWorkspace,
    cacheRemoteSessionState,
    restoreRemoteIndex,
  } = sessionsManager;
  const [workbenchReady, setWorkbenchReady] = useState(false);

  // 文件夹选择器弹窗状态
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);

  // 会话列表的权威副本：自动保存时用来取每个会话自己的 workspaceRoot，
  // 放进 ref 是为了避免「保存 → sessions 变化 → 再次保存」的循环。
  const sessionsRef = useRef(sessionsManager.sessions);
  useEffect(() => {
    sessionsRef.current = sessionsManager.sessions;
  }, [sessionsManager.sessions]);

  // 服务端以工作目录为边界保存工作台数据，因此改用另一个前端端口后仍可恢复。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/workbench");
        if (!response.ok) return;
        const payload = (await response.json()) as {
          workbench: {
            sessions: SessionSummary[];
            customWorkspaces: string[];
            activeSessionId: string;
            currentWorkspace: string | null;
          } | null;
        };
        if (cancelled) return;
        const savedIndex = payload.workbench;
        if (savedIndex?.sessions.length) {
          restoreRemoteIndex(savedIndex);
          setWorkspaceRoot(savedIndex.currentWorkspace);
          const activeId = savedIndex.sessions.some((session) => session.id === savedIndex.activeSessionId)
            ? savedIndex.activeSessionId
            : savedIndex.sessions[0]!.id;
          const stateResponse = await fetch(`/api/workbench/sessions/${encodeURIComponent(activeId)}`);
          if (cancelled) return;
          if (stateResponse.ok) {
            const savedState = (await stateResponse.json() as { state?: ClientState }).state;
            if (savedState) {
              cacheRemoteSessionState(activeId, savedState);
              loadState(savedState);
            } else {
              newThread(activeId);
            }
          } else {
            newThread(activeId);
          }
        } else {
          // 旧版数据按端口保存在浏览器里；首次迁移到本机服务端。
          for (const session of sessionsManager.sessions) {
            const saved = sessionsManager.loadSessionState(session.id);
            if (saved) {
              await fetch(`/api/workbench/sessions/${encodeURIComponent(session.id)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(saved),
              });
            }
          }
        }
      } catch {
        // 后端暂不可用时仍可使用当前浏览器中已有的本地会话。
      } finally {
        if (!cancelled) setWorkbenchReady(true);
      }
    })();
    return () => { cancelled = true; };
  // 初始化只运行一次，避免页面状态变化时重放启动恢复流程。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workbenchReady) return;
    void fetch("/api/workbench", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        sessions: sessionsManager.sessions,
        customWorkspaces: sessionsManager.customWorkspaces,
        activeSessionId: state.threadId,
        currentWorkspace: workspaceRoot,
      }),
    }).catch(() => undefined);
  }, [workbenchReady, sessionsManager.sessions, sessionsManager.customWorkspaces, state.threadId, workspaceRoot]);

  /**
   * 自动保存：对所有会话（含正在后台执行的会话）做防抖持久化。
   * 这样即使某个会话在后台跑完、用户没有切回去看，内容也不会丢。
   */
  useEffect(() => {
    const entries = Object.entries(allStates);
    if (entries.length === 0) return;
    const timer = setTimeout(() => {
      for (const [threadId, threadState] of entries) {
        if (threadState.messages.length === 0 && threadState.activities.length === 0) continue;
        const sessionWorkspace =
          sessionsRef.current.find((session) => session.id === threadId)?.workspaceRoot ??
          (workspaceRoot ?? "");
        saveSessionState(threadId, threadState, sessionWorkspace);
        void fetch(`/api/workbench/sessions/${encodeURIComponent(threadId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(threadState),
        }).catch(() => undefined);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [allStates, workspaceRoot, saveSessionState, workbenchReady]);

  const currentModelId = settings.currentModelId;

  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    try {
      const saved = localStorage.getItem("agentscope_permission_mode");
      return PERMISSION_MODES.find((mode) => mode === saved) ?? DEFAULT_PERMISSION_MODE;
    } catch {
      return DEFAULT_PERMISSION_MODE;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("agentscope_permission_mode", permissionMode);
    } catch {
      // 浏览器禁用本地存储时，权限模式仍在当前页面会话内生效。
    }
  }, [permissionMode]);

  const effortResolution = useMemo(() => {
    if (!currentModelId) {
      return { effort: settings.effort, fallbackApplied: false, supported: availableEffortsForModel("") };
    }
    return resolveEffortForModel(currentModelId, settings.effort);
  }, [currentModelId, settings.effort]);

  const reasoningUnsupported = settings.activeProvider?.reasoning?.unsupported === true;

  // 注意：这里刻意不把降级后的档位回写到 settings.effort——
  // 静默回写会让「已降级」提示永远无法出现（AGENTS.md 第 8 节要求
  // 对不支持模型的降级必须显示说明）。settings.effort 保留用户的
  // 原始请求，运行实际使用 effortResolution.effort。

  const allAvailableModels = useMemo(() => {
    if (settings.activeProvider?.models && settings.activeProvider.models.length > 0) {
      return settings.activeProvider.models;
    }
    const set = new Set<string>();
    for (const p of settings.providers) {
      if (p.enabled) {
        for (const m of p.models) set.add(m);
      }
    }
    return Array.from(set);
  }, [settings.activeProvider, settings.providers]);

  const canSend =
    settings.activeProvider !== null && settings.activeProvider.hasApiKey && currentModelId !== null;

  const modelStatus = !settings.activeProvider
    ? "未配置提供商"
    : !settings.activeProvider.hasApiKey
      ? "未填 API Key"
      : currentModelId === null
        ? "未选择模型"
        : `${currentModelId}`;

  const modelStatusKind: "ok" | "warn" | "error" = canSend ? "ok" : "error";

  // 发送消息
  const handleSend = useCallback(
    (content: string, attachments: ChatAttachment[] = []): void => {
      void send(content, {
        providerId: settings.activeProviderId ?? undefined,
        modelId: currentModelId ?? undefined,
        effort: effortResolution.effort,
        workspaceRoot: workspaceRoot ?? undefined,
        permissionMode,
      }, attachments);
    },
    [send, settings.activeProviderId, currentModelId, effortResolution.effort, workspaceRoot, permissionMode],
  );

  // 新建会话
  const handleNewSession = useCallback(
    (targetWorkspace?: string | null) => {
      const ws = targetWorkspace !== undefined ? targetWorkspace : workspaceRoot;
      setWorkspaceRoot(ws ?? null);
      // 如果当前已经是空会话，直接复用当前对话，不重复向列表追加多余的「新对话」
      if (state.messages.length === 0 && state.activities.length === 0) {
        sessionsManager.setActiveSessionId(state.threadId);
        return;
      }
      // 保存当前会话
      if (state.messages.length > 0 || state.activities.length > 0) {
        saveSessionState(state.threadId, state, workspaceRoot ?? "");
      }
      const newSessionId = cryptoRandomId();
      // 只切换当前视图：旧会话若正在执行，会在后台继续跑完，互不影响。
      newThread(newSessionId);
      sessionsManager.createSession(newSessionId, ws ?? "");
    },
    [workspaceRoot, state, sessionsManager, saveSessionState, newThread],
  );

  // 文件夹选择器完成选择
  const handleFolderPicked = useCallback(
    async (pickedPath: string) => {
      const trimmed = pickedPath.trim();
      if (!trimmed) return;
      try {
        await fetch("http://127.0.0.1:8787/api/workspace/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: trimmed }),
        });
      } catch {
        // 忽略
      }
      addWorkspace(trimmed);
      setWorkspaceRoot(trimmed);
      handleNewSession(trimmed);
      setIsFolderPickerOpen(false);
    },
    [addWorkspace, handleNewSession],
  );

  // 移除工作区文件夹
  const handleRemoveWorkspace = useCallback(
    (folderPath: string) => {
      removeWorkspace(folderPath);
      // 若当前选中的正好是被移除的工作区，平滑切换到其他工作区或直接聊天模式
      setWorkspaceRoot((cur) => {
        if (!cur) return null;
        if (cur === folderPath || normalizePath(cur) === normalizePath(folderPath)) {
          const remaining = customWorkspaces.filter(
            (w) => w !== folderPath && normalizePath(w) !== normalizePath(folderPath),
          );
          return remaining[0] ?? null;
        }
        return cur;
      });
    },
    [removeWorkspace, customWorkspaces],
  );

  // 切换会话
  const handleSelectSession = async (id: string) => {
    if (id === state.threadId && state.messages.length > 0) return;
    const sessionWorkspace = sessionsRef.current.find((s) => s.id === id)?.workspaceRoot;
    setWorkspaceRoot(sessionWorkspace ? sessionWorkspace : null);

    // 切换前先保存当前已有内容的对话
    if (state.messages.length > 0 || state.activities.length > 0) {
      saveSessionState(state.threadId, state, workspaceRoot ?? "");
    }

    // 目标会话若已在内存中（且内存中已包含消息，或者是正在后台执行的会话），直接切过去看实时状态，
    // 绝不能用磁盘快照覆盖它；但若内存中只是一个未载入消息的空占位，则必须继续读取并恢复持久化内容！
    const inMemoryState = allStates[id];
    const isRunning = runningThreadIds.includes(id);
    if (hasThread(id) && (isRunning || (inMemoryState && (inMemoryState.messages.length > 0 || inMemoryState.activities.length > 0)))) {
      setActiveThread(id);
      sessionsManager.setActiveSessionId(id);
      return;
    }

    let saved = sessionsManager.loadSessionState(id);
    if (!saved) {
      try {
        const response = await fetch(`/api/workbench/sessions/${encodeURIComponent(id)}`);
        if (response.ok) {
          saved = ((await response.json()) as { state?: ClientState }).state ?? null;
          if (saved) cacheRemoteSessionState(id, saved);
        }
      } catch {
        // 继续按空会话打开；已存在的本地会话不受影响。
      }
    }
    if (saved) {
      loadState(saved);
    } else {
      setActiveThread(id);
    }
    sessionsManager.setActiveSessionId(id);
  };

  // 人工审批操作
  const handleDecide = (activityId: string, decision: "approve" | "reject"): void => {
    const interruptId = activityId.split(":")[1];
    if (interruptId) {
      setDecision(interruptId, {
        type: decision,
        message: decision === "reject" ? "用户拒绝了该操作。" : undefined,
      });
      // 用户在卡片上点击批准/拒绝后，自动触发恢复执行，避免卡在底栏等待
      setTimeout(() => {
        void submitDecisions({
          providerId: settings.activeProviderId ?? undefined,
          modelId: currentModelId ?? undefined,
          effort: effortResolution.effort,
          workspaceRoot: workspaceRoot ?? undefined,
          permissionMode,
        });
      }, 60);
    }
  };

  const handleSubmitDecisions = (): void => {
    void submitDecisions({
      providerId: settings.activeProviderId ?? undefined,
      modelId: currentModelId ?? undefined,
      effort: effortResolution.effort,
      workspaceRoot: workspaceRoot ?? undefined,
      permissionMode,
    });
  };

  const handleRetry = (messageId: string): void => {
    const index = state.messages.findIndex((message) => message.id === messageId);
    if (index <= 0) return;
    const userMessage = [...state.messages.slice(0, index)]
      .reverse()
      .find((message) => message.role === "user");
    if (!userMessage) return;
    // 必须连同用户消息一起回退（与编辑重发一致）：若保留原消息再发送，
    // handleSend 会再追加一条相同内容的用户消息，导致提示词重复显示。
    rollbackBeforeMessage(userMessage.id);
    handleSend(userMessage.content, userMessage.attachments);
  };

  const handleEditMessage = useCallback(
    (messageId: string, newContent: string, attachments: ChatAttachment[] = []): void => {
      rollbackBeforeMessage(messageId);
      handleSend(newContent, attachments);
    },
    [rollbackBeforeMessage, handleSend],
  );

  useEffect(() => {
    (window as unknown as { __deepagentTestHooks?: unknown }).__deepagentTestHooks = {
      getState: () => state,
      loadState,
      handleSend,
      handleEditMessage,
      handleNewSession,
      handleSubmitDecisions,
      sessionsManager,
    };
    // handleSubmitDecisions 依赖 settings/effortResolution 等渲染期值，
    // 每次渲染都是新引用；这里刻意只按状态键重挂载，避免钩子频繁重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, loadState, handleSend, handleEditMessage, handleNewSession, sessionsManager]);

  const pendingInterrupts = state.run.interrupts;
  const hasDecisions =
    pendingInterrupts.length > 0 &&
    pendingInterrupts.every((interrupt) => Boolean(state.pendingDecisions[interrupt.id]));

  const currentSession = sessions.find((s) => s.id === state.threadId);
  const currentTitle = currentSession?.title || "新对话";

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-black text-zinc-100 antialiased">
      {/* 左侧边栏（完全参考用户截图设计） */}
      <WorkspaceSidebar
        isOpen={isSidebarOpen}
        onToggle={toggleSidebar}
        selected={workspaceRoot}
        onSelect={(path) => setWorkspaceRoot(path)}
        onNewSession={handleNewSession}
        sessions={sessions}
        groupedSessions={groupedSessions}
        activeSessionId={state.threadId}
        runningSessionIds={runningThreadIds}
        onSelectSession={handleSelectSession}
        onRenameSession={renameSession}
        onClearSession={(id) => {
          clearThread(id);
          clearSessionState(id);
          void fetch(`/api/workbench/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
        }}
        onRemoveSession={(id) => {
          removeSession(id);
          void fetch(`/api/workbench/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
          // 释放该会话的运行时（会中止其后台运行并切换到其它可用会话）。
          disposeThread(id);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onAddWorkspace={addWorkspace}
        onRemoveWorkspace={handleRemoveWorkspace}
        onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
        theme={theme}
        onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      />

      {/* 右侧主聊天区 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-black">
        {/* 顶部 Header：极致极简，去掉右上角设置等杂项 */}
        <header className="flex h-12 shrink-0 items-center justify-between px-4 border-b border-zinc-800/40 bg-black">
          <div className="flex items-center gap-2.5 min-w-0">
            {!isSidebarOpen && (
              <button
                type="button"
                onClick={toggleSidebar}
                title="展开侧边栏"
                aria-label="展开侧边栏"
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <PanelLeftIcon className="size-4" />
              </button>
            )}

            <h1 className="truncate text-[13px] font-medium text-zinc-300" title={currentTitle}>
              {currentTitle}
            </h1>
          </div>

          {/* 右上角保持干净，展示微小运行中提示、黑白主题切换与代码审查(Review)边栏开关 */}
          <div className="flex items-center gap-1.5">
            {runningThreadIds.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 mr-1">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>
                  {isRunning
                    ? state.run.progressNote || "运行中"
                    : `${runningThreadIds.length} 个会话在后台运行`}
                </span>
              </div>
            )}

            {/* 一键切换黑白主题按钮（☀️ 浅色 / 🌙 深色） */}
            <button
              type="button"
              data-testid="header-toggle-theme-btn"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title={theme === "dark" ? "切换为浅色主题 (Light)" : "切换为深色主题 (Dark)"}
              aria-label="切换黑白主题"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              {theme === "dark" ? (
                <SunIcon className="size-4 text-amber-400" />
              ) : (
                <MoonIcon className="size-4 text-indigo-400" />
              )}
            </button>

            <button
              type="button"
              onClick={toggleReview}
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
          </div>
        </header>

        {/* 聊天消息区 */}
        <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-black">
          <ChatMessages
            messages={state.messages}
            activities={state.activities}
            error={state.run.error}
            isRunning={isRunning}
            runSnapshot={state.run}
            onRetry={handleRetry}
            onEditMessage={handleEditMessage}
            onQuickPrompt={handleSend}
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
                        onDecide={handleDecide}
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
                    onClick={handleSubmitDecisions}
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

          {/* 底部输入框（支持输入框上方对齐的工作区下拉选择、模型下拉选择与思考等级） */}
          <ChatInput
            todoActivity={latestTodoActivity}
            onSend={handleSend}
            onStop={() => void stop()}
            isRunning={isRunning}
            effort={effortResolution.effort}
            onEffortChange={(value: ReasoningEffort) => settings.setEffort(value)}
            supportedEfforts={effortResolution.supported}
            reasoningUnsupported={reasoningUnsupported}
            fallbackApplied={effortResolution.fallbackApplied}
            requestedEffort={settings.effort}
            modelStatus={modelStatus}
            modelStatusKind={modelStatusKind}
            disabled={!canSend}
            availableModels={allAvailableModels}
            currentModel={currentModelId}
            onSelectModel={(model: string) => settings.setActiveModelId(model)}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            onOpenSettings={() => setSettingsOpen(true)}
            workspaceRoot={workspaceRoot}
            messages={state.messages}
            activities={state.activities}
            usage={state.run.usage ?? null}
            customWorkspaces={customWorkspaces}
            onSelectWorkspace={(path) => {
              setWorkspaceRoot(path);
              if (state.messages.length === 0 && state.activities.length === 0) {
                saveSessionState(state.threadId, state, path ?? "");
              }
            }}
            onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
          />
        </section>
      </div>

      {/* 右侧可收缩的代码审查（Review）边栏 */}
      <ReviewSidebar
        isOpen={isReviewOpen}
        onToggle={toggleReview}
        workspaceRoot={workspaceRoot}
      />

      {/* 文件夹选择弹窗 */}
      <FolderPickerModal
        open={isFolderPickerOpen}
        onClose={() => setIsFolderPickerOpen(false)}
        onSelect={handleFolderPicked}
        initialPath={workspaceRoot || undefined}
      />

      {/* 模型设置弹窗 */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providers={settings.providers}
        loading={settings.loading}
        onSave={settings.save}
        onRemove={settings.remove}
        onFetchModels={settings.fetchModelList}
        onTest={settings.testConnection}
        onAddModel={settings.addModel}
        draftFor={settings.draftFor}
        activeProviderId={settings.activeProviderId}
        onSelectProvider={settings.setActiveProviderId}
        theme={theme}
        onThemeChange={setTheme}
      />
    </div>
  );
}

function cryptoRandomId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export { Fragment };
