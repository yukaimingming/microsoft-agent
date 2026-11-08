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
  availableEffortsForModel,
  resolveEffortForModel,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type PermissionMode,
  type ReasoningEffort,
} from "@deepagent/shared";
import { useAgentClient } from "./features/chat/use-agent-client.js";
import type { ClientState } from "./features/chat/client-reducer.js";
import type { ChatAttachment } from "./features/chat/chat-attachments.js";
import { WorkspaceSidebar } from "./features/chat/workspace-sidebar.js";
import { SplitChatView } from "./features/chat/split-chat-view.js";
import { ChatPane } from "./features/chat/chat-pane.js";
import { SettingsModal } from "./features/settings/settings-modal.js";
import { useProviderSettings } from "./features/settings/use-provider-settings.js";
import { useTheme } from "./features/settings/use-theme.js";
import { useSessions, normalizePath, type SessionSummary } from "./features/chat/use-sessions.js";
import { FolderPickerModal } from "./features/chat/folder-picker-modal.js";
import { AlertTriangleIcon } from "lucide-react";
import { ReviewSidebar } from "./features/review/review-sidebar.js";
import { useGitReview } from "./features/review/use-git-review.js";
import { useWeChatClawbot } from "./features/wechat/use-wechat-clawbot.js";
import { WeChatClawbotModal } from "./features/wechat/wechat-clawbot-modal.js";

/** AG-UI 服务端地址：走代理或直接连接。 */
const AGENT_URL = "/agent";



export function App() {
  const settings = useProviderSettings();
  const { theme, setTheme, themeMode, setThemeMode } = useTheme();
  const {
    state,
    isRunning,
    runningThreadIds,
    allStates,
    send,
    sendToThread,
    stop,
    stopThread,
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

  const [settingsOpen, setSettingsOpen] = useState(false);
  // 个人微信 ClawBot 扫码连接弹窗状态
  const [wechatModalOpen, setWechatModalOpen] = useState(false);
  const wechat = useWeChatClawbot(wechatModalOpen);
  // 未配置API提供商拦截警告弹窗
  const [isMissingProviderAlertOpen, setIsMissingProviderAlertOpen] = useState(false);

  // 侧边栏折叠/展开
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("maf_sidebar_open");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });

  const toggleSidebar = () => {
    setIsSidebarOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("maf_sidebar_open", String(next));
      } catch {
        // 忽略
      }
      return next;
    });
  };

  /** 当前工作区目录。若为 null 则表示单纯不在工作区的直接聊天模式。 */
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem("maf_current_workspace_v1");
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
        localStorage.setItem("maf_current_workspace_v1", "DIRECT_CHAT");
      } else {
        localStorage.setItem("maf_current_workspace_v1", workspaceRoot);
      }
    } catch {
      // 忽略
    }
  }, [workspaceRoot]);

  // 获取工作区变更状态
  useGitReview(workspaceRoot);

  // 判断当前会话是否有聊天内容
  const hasChatContent = state.messages.length > 0 || state.activities.length > 0;

  // 右侧扩展收缩栏折叠/展开（新对话默认收缩隐藏，仅在用户手动点击展开或切换到此前手动开启过的会话时展开）
  const [isReviewOpen, setIsReviewOpen] = useState<boolean>(false);

  const toggleReview = () => {
    userManuallyToggledRef.current = true;
    setIsReviewOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("maf_review_open", String(next));
      } catch {
        // 忽略
      }
      return next;
    });
  };

  // 严格响应需求：新对话右侧边栏默认收缩（false），绝不因为工作区有历史 Git 变更而在新对话时自动弹出
  const prevThreadIdRef = useRef<string>(state.threadId);
  const userManuallyToggledRef = useRef<boolean>(false);

  useEffect(() => {
    const isThreadSwitched = prevThreadIdRef.current !== state.threadId;
    prevThreadIdRef.current = state.threadId;

    if (isThreadSwitched) {
      userManuallyToggledRef.current = false;
      // 切换到新对话或其它会话时，如果当前是空对话则强制默认收缩；已有对话也默认保持收缩，除非用户主动点开
      if (!hasChatContent) {
        setIsReviewOpen(false);
      }
      return;
    }

    // 当前为新对话（无聊天内容）且用户未手动点击展开时，始终保持右侧边栏收缩
    if (!hasChatContent && !userManuallyToggledRef.current) {
      setIsReviewOpen(false);
    }
  }, [state.threadId, hasChatContent]);

  // ===== Split View 分屏状态（移植自 agentscope-harness 项目）=====
  // 右侧分屏会话 ID 与左右比例，持久化到 localStorage，刷新后可恢复
  const [splitSessionId, setSplitSessionId] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem("maf_split_session_id");
      return saved && saved.trim() ? saved : null;
    } catch {
      return null;
    }
  });

  const [splitRatio, setSplitRatio] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("maf_split_ratio");
      if (saved) {
        const val = Number(saved);
        if (!Number.isNaN(val) && val >= 0.25 && val <= 0.75) return val;
      }
    } catch {
      // 忽略
    }
    return 0.5;
  });

  useEffect(() => {
    try {
      if (splitSessionId) {
        localStorage.setItem("maf_split_session_id", splitSessionId);
      } else {
        localStorage.removeItem("maf_split_session_id");
      }
    } catch {
      // 忽略
    }
  }, [splitSessionId]);

  useEffect(() => {
    try {
      localStorage.setItem("maf_split_ratio", String(splitRatio));
    } catch {
      // 忽略
    }
  }, [splitRatio]);

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
      const saved = localStorage.getItem("maf_permission_mode");
      return PERMISSION_MODES.find((mode) => mode === saved) ?? DEFAULT_PERMISSION_MODE;
    } catch {
      return DEFAULT_PERMISSION_MODE;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("maf_permission_mode", permissionMode);
    } catch {
      // 浏览器禁用本地存储时，权限模式仍在当前页面会话内生效。
    }
  }, [permissionMode]);

  // 计划模式开关：独立于权限模式的勾选（参考 ZCode 开源仓库实现），开启后本轮运行要求代理先输出实施计划。
  const [planEnabled, setPlanEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("maf_plan_enabled") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("maf_plan_enabled", planEnabled ? "1" : "0");
    } catch {
      // 浏览器禁用本地存储时，计划模式仍在当前页面会话内生效。
    }
  }, [planEnabled]);

  // 联网搜索开关：仅勾选时本轮运行挂载 web_search 工具，否则模型仅凭自身知识回答。
  const [webSearch, setWebSearch] = useState<boolean>(() => {
    try {
      return localStorage.getItem("maf_web_search") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("maf_web_search", webSearch ? "1" : "0");
    } catch {
      // 浏览器禁用本地存储时，联网搜索开关仍在当前页面会话内生效。
    }
  }, [webSearch]);

  // Computer Use（电脑桌面自动化操作）开关：仅启用时才允许挂载并调用 computer-use 子代理操作电脑。
  const [computerUseEnabled, setComputerUseEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("maf_computer_use_enabled");
      return saved === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("maf_computer_use_enabled", computerUseEnabled ? "1" : "0");
    } catch {
      // 浏览器禁用本地存储时，Computer Use 开关仍在当前页面会话内生效。
    }
  }, [computerUseEnabled]);

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

  // 发送消息（未配置有效模型提供商时拦截并弹窗警告）
  const handleSend = useCallback(
    (content: string, attachments: ChatAttachment[] = []): void => {
      if (!canSend) {
        setIsMissingProviderAlertOpen(true);
        return;
      }
      void send(content, {
        providerId: settings.activeProviderId ?? undefined,
        modelId: currentModelId ?? undefined,
        effort: effortResolution.effort,
        workspaceRoot: workspaceRoot ?? undefined,
        permissionMode,
        webSearch,
        planEnabled,
        computerUseEnabled,
      }, attachments);
    },
    [canSend, send, settings.activeProviderId, currentModelId, effortResolution.effort, workspaceRoot, permissionMode, webSearch, planEnabled, computerUseEnabled],
  );

  // 新建会话
  const handleNewSession = useCallback(
    (targetWorkspace?: string | null) => {
      const ws = targetWorkspace !== undefined ? targetWorkspace : workspaceRoot;
      setWorkspaceRoot(ws ?? null);
      // 新建对话一律取消分屏：旧分屏可能展示着历史会话，新建后只保留最新对话这一个全屏窗格，
      // 避免出现「新建了对话但旧分屏还在」的状态；需要分屏时从侧边栏重新拖拽发起。
      setSplitSessionId(null);
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
        await fetch("/api/workspace/select", {
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
    // 若点击的正好是右侧分屏的会话，关闭右侧分屏，主屏切换至该会话
    if (id === splitSessionId) {
      setSplitSessionId(null);
    }
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
        } else if (response.status === 404) {
          // 该会话在后端已被删除或不存在，从列表中清理，绝不打开空会话
          sessionsManager.removeSession(id);
          return;
        }
      } catch {
        // 继续按空会话打开；已存在的本地会话不受影响。
      }
    }
    if (saved) {
      loadState(saved);
      sessionsManager.setActiveSessionId(id);
    } else {
      // 找不到历史状态，清理该幽灵项
      sessionsManager.removeSession(id);
    }
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
          webSearch,
          planEnabled,
          computerUseEnabled,
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
      webSearch,
      planEnabled,
      computerUseEnabled,
    });
  };

  // ===== Split View 分屏（移植自 agentscope-harness 项目）=====

  // 打开分屏会话（从侧边栏拖拽会话到主视图右半侧或窗格内触发）
  const handleOpenSplitWithSession = useCallback(
    async (id: string) => {
      if (id === state.threadId) return; // 不与主屏相同会话分屏
      if (!hasThread(id)) {
        let saved = sessionsManager.loadSessionState(id);
        if (!saved) {
          try {
            const response = await fetch(`/api/workbench/sessions/${encodeURIComponent(id)}`);
            if (response.ok) {
              saved = ((await response.json()) as { state?: ClientState }).state ?? null;
              if (saved) cacheRemoteSessionState(id, saved);
            }
          } catch {
            // 忽略
          }
        }
        if (saved) {
          loadState(saved, false); // activate=false，保持左侧主屏不被打乱
        } else {
          newThread(id);
        }
      }
      setSplitSessionId(id);
    },
    [state.threadId, hasThread, sessionsManager, cacheRemoteSessionState, loadState, newThread],
  );

  // 若分屏展示的会话在列表中已被删除，则右屏自动回退为 null（派生状态，避免在 effect 中层联更新）
  const activeSplitSessionId = useMemo(() => {
    if (!splitSessionId) return null;
    if (sessions.length > 0 && !sessions.some((s) => s.id === splitSessionId)) {
      return null;
    }
    return splitSessionId;
  }, [splitSessionId, sessions]);

  // 关闭左侧窗格：右侧窗格的内容成为唯一的全屏窗格（关闭左边就显示右边）
  const handleCloseLeftPane = useCallback(() => {
    if (!activeSplitSessionId) return;
    const targetSessionId = activeSplitSessionId;
    setActiveThread(targetSessionId);
    sessionsManager.setActiveSessionId(targetSessionId);
    setSplitSessionId(null);
  }, [activeSplitSessionId, setActiveThread, sessionsManager]);

  // 关闭右侧窗格：左侧窗格成为唯一的全屏窗格（关闭右边就显示左边）
  const handleCloseRightPane = useCallback(() => {
    setSplitSessionId(null);
  }, []);

  // 左右分屏面板位置互换
  const handleSwapPanes = useCallback(() => {
    if (!splitSessionId) return;
    const oldLeft = state.threadId;
    const oldRight = splitSessionId;
    setActiveThread(oldRight);
    sessionsManager.setActiveSessionId(oldRight);
    setSplitSessionId(oldLeft);
  }, [splitSessionId, state.threadId, setActiveThread, sessionsManager]);

  // 右屏状态与标题
  const rightState = activeSplitSessionId ? allStates[activeSplitSessionId] : undefined;
  const isRightRunning = activeSplitSessionId ? runningThreadIds.includes(activeSplitSessionId) : false;
  const rightSession = activeSplitSessionId ? sessions.find((s) => s.id === activeSplitSessionId) : undefined;
  const rightTitle = rightSession?.title || "分屏会话";
  const rightWorkspace = rightSession?.workspaceRoot ?? workspaceRoot;

  // 右屏发送（带与左屏一致的未配置厂商拦截）
  const handleSendRight = useCallback(
    (content: string, attachments: ChatAttachment[] = []): void => {
      if (!activeSplitSessionId) return;
      if (!canSend) {
        setIsMissingProviderAlertOpen(true);
        return;
      }
      void sendToThread(
        activeSplitSessionId,
        content,
        {
          providerId: settings.activeProviderId ?? undefined,
          modelId: currentModelId ?? undefined,
          effort: effortResolution.effort,
          workspaceRoot: rightWorkspace ?? undefined,
          permissionMode,
          webSearch,
          planEnabled,
          computerUseEnabled,
        },
        attachments,
      );
    },
    [activeSplitSessionId, canSend, sendToThread, settings.activeProviderId, currentModelId, effortResolution.effort, rightWorkspace, permissionMode, webSearch, planEnabled, computerUseEnabled],
  );

  const handleStopRight = useCallback(() => {
    if (activeSplitSessionId) void stopThread(activeSplitSessionId);
  }, [activeSplitSessionId, stopThread]);

  const handleRetryRight = useCallback(
    (messageId: string): void => {
      if (!activeSplitSessionId) return;
      const tState = allStates[activeSplitSessionId];
      if (!tState) return;
      const index = tState.messages.findIndex((m) => m.id === messageId);
      if (index <= 0) return;
      const userMessage = [...tState.messages.slice(0, index)]
        .reverse()
        .find((m) => m.role === "user");
      if (!userMessage) return;
      // 必须连同用户消息一起回退（与左屏 handleRetry 一致），避免提示词重复显示
      rollbackBeforeMessage(userMessage.id, activeSplitSessionId);
      handleSendRight(userMessage.content, userMessage.attachments);
    },
    [activeSplitSessionId, allStates, rollbackBeforeMessage, handleSendRight],
  );

  const handleEditMessageRight = useCallback(
    (messageId: string, newContent: string, attachments: ChatAttachment[] = []): void => {
      if (!activeSplitSessionId) return;
      rollbackBeforeMessage(messageId, activeSplitSessionId);
      handleSendRight(newContent, attachments);
    },
    [activeSplitSessionId, rollbackBeforeMessage, handleSendRight],
  );

  // 右屏人工审批操作
  const handleDecideRight = useCallback(
    (activityId: string, decision: "approve" | "reject"): void => {
      if (!activeSplitSessionId) return;
      const interruptId = activityId.split(":")[1];
      if (interruptId) {
        setDecision(
          interruptId,
          {
            type: decision,
            message: decision === "reject" ? "用户拒绝了该操作。" : undefined,
          },
          activeSplitSessionId,
        );
        setTimeout(() => {
          void submitDecisions(
            {
              providerId: settings.activeProviderId ?? undefined,
              modelId: currentModelId ?? undefined,
              effort: effortResolution.effort,
              workspaceRoot: rightWorkspace ?? undefined,
              permissionMode,
              webSearch,
              planEnabled,
              computerUseEnabled,
            },
            activeSplitSessionId,
          );
        }, 60);
      }
    },
    [activeSplitSessionId, setDecision, submitDecisions, settings.activeProviderId, currentModelId, effortResolution.effort, rightWorkspace, permissionMode, webSearch, planEnabled, computerUseEnabled],
  );

  const handleSubmitDecisionsRight = useCallback((): void => {
    if (!activeSplitSessionId) return;
    void submitDecisions(
      {
        providerId: settings.activeProviderId ?? undefined,
        modelId: currentModelId ?? undefined,
        effort: effortResolution.effort,
        workspaceRoot: rightWorkspace ?? undefined,
        permissionMode,
        webSearch,
        planEnabled,
        computerUseEnabled,
      },
      activeSplitSessionId,
    );
  }, [activeSplitSessionId, submitDecisions, settings.activeProviderId, currentModelId, effortResolution.effort, rightWorkspace, permissionMode, webSearch, planEnabled, computerUseEnabled]);

  // 上次关闭前若有分屏会话，启动恢复完成后自动重新拉起右屏（线程不在内存时后台载入，不打乱主屏）
  useEffect(() => {
    if (!workbenchReady) return;
    if (!splitSessionId) return;
    const sessionExists = sessions.some((s) => s.id === splitSessionId);
    if (splitSessionId === state.threadId || (sessions.length > 0 && !sessionExists)) {
      // 分屏会话已不存在或与主屏相同：分屏状态作废
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 启动恢复完成后一次性校正持久化的分屏状态
      setSplitSessionId(null);
      return;
    }
    if (allStates[splitSessionId]) return; // 已在内存中，SplitChatView 可直接渲染
    void handleOpenSplitWithSession(splitSessionId);
    // 仅在启动恢复完成时执行一次，避免会话列表变化时重复拉起
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbenchReady]);

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
      getSplitState: () => (activeSplitSessionId ? allStates[activeSplitSessionId] : null),
      getSplitSessionId: () => activeSplitSessionId,
      loadState,
      handleSend,
      handleSendRight,
      handleEditMessage,
      handleNewSession,
      handleSubmitDecisions,
      handleOpenSplitWithSession,
      handleCloseSplit: handleCloseRightPane,
      handleCloseLeftPane,
      handleCloseRightPane,
      handleSwapPanes,
      sessionsManager,
    };
    // handleSubmitDecisions 依赖 settings/effortResolution 等渲染期值，
    // 每次渲染都是新引用；这里刻意只按状态键重挂载，避免钩子频繁重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, activeSplitSessionId, allStates, loadState, handleSend, handleSendRight, handleEditMessage, handleNewSession, sessionsManager]);

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
          if (id === activeSplitSessionId) {
            setSplitSessionId(null);
          }
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
        onOpenWeChatModal={() => setWechatModalOpen(true)}
        wechatConnected={wechat.connection.connected}
        wechatStatus={wechat.scanStatus}
        splitSessionId={activeSplitSessionId}
      />

      {/* 右侧主聊天区：Split View 分屏与主聊天视图（移植自 agentscope-harness 项目） */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-black">
        <SplitChatView
          isSplit={Boolean(activeSplitSessionId && rightState)}
          splitRatio={splitRatio}
          onSplitRatioChange={setSplitRatio}
          onOpenSplitWithSession={handleOpenSplitWithSession}
          leftPane={
            <ChatPane
              paneId="left"
              isSplit={Boolean(activeSplitSessionId && rightState)}
              sessionId={state.threadId}
              sessionTitle={currentTitle}
              state={state}
              isRunning={isRunning}
              effort={effortResolution.effort}
              supportedEfforts={effortResolution.supported}
              reasoningUnsupported={reasoningUnsupported}
              fallbackApplied={effortResolution.fallbackApplied}
              requestedEffort={settings.effort}
              onEffortChange={(value: ReasoningEffort) => settings.setEffort(value)}
              availableModels={allAvailableModels}
              currentModelId={currentModelId ?? undefined}
              onSelectModel={(model: string) => settings.setActiveModelId(model)}
              modelStatus={modelStatus}
              modelStatusKind={modelStatusKind}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
            planEnabled={planEnabled}
            onPlanEnabledChange={setPlanEnabled}
              workspaceRoot={workspaceRoot}
              customWorkspaces={customWorkspaces}
              onSelectWorkspace={(path) => {
                setWorkspaceRoot(path);
                if (state.messages.length === 0 && state.activities.length === 0) {
                  saveSessionState(state.threadId, state, path ?? "");
                }
              }}
              onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              canSend={canSend}
              onSend={handleSend}
              onStop={() => void stop()}
              onRetry={handleRetry}
              onEditMessage={handleEditMessage}
              onDecide={handleDecide}
              onSubmitDecisions={handleSubmitDecisions}
              onCloseSplit={handleCloseLeftPane}
              onSwapPanes={handleSwapPanes}
              isSidebarOpen={isSidebarOpen}
              onToggleSidebar={toggleSidebar}
              isReviewOpen={isReviewOpen && hasChatContent}
              onToggleReview={toggleReview}
              onBlockedSend={() => setIsMissingProviderAlertOpen(true)}
              isProviderConfigured={canSend}
              webSearch={webSearch}
              onWebSearchChange={setWebSearch}
              providers={settings.providers}
              activeProviderId={settings.activeProviderId}
              onSelectProviderModel={settings.selectProviderModel}
              onDropSession={(droppedId) => {
                if (droppedId !== state.threadId) {
                  void handleOpenSplitWithSession(droppedId);
                }
              }}
            />
          }
          rightPane={
            activeSplitSessionId && rightState ? (
              <ChatPane
                paneId="right"
                isSplit={true}
                sessionId={activeSplitSessionId}
                sessionTitle={rightTitle}
                state={rightState}
                isRunning={isRightRunning}
                effort={effortResolution.effort}
                supportedEfforts={effortResolution.supported}
                reasoningUnsupported={reasoningUnsupported}
                fallbackApplied={effortResolution.fallbackApplied}
                requestedEffort={settings.effort}
                onEffortChange={(value: ReasoningEffort) => settings.setEffort(value)}
                availableModels={allAvailableModels}
                currentModelId={currentModelId ?? undefined}
                onSelectModel={(model: string) => settings.setActiveModelId(model)}
                modelStatus={modelStatus}
                modelStatusKind={modelStatusKind}
                permissionMode={permissionMode}
                onPermissionModeChange={setPermissionMode}
            planEnabled={planEnabled}
            onPlanEnabledChange={setPlanEnabled}
                workspaceRoot={rightWorkspace}
                customWorkspaces={customWorkspaces}
                onSelectWorkspace={(path) => {
                  if (splitSessionId) {
                    saveSessionState(splitSessionId, rightState, path ?? "");
                  }
                }}
                onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
                canSend={canSend}
                onSend={handleSendRight}
                onStop={handleStopRight}
                onRetry={handleRetryRight}
                onEditMessage={handleEditMessageRight}
                onDecide={handleDecideRight}
                onSubmitDecisions={handleSubmitDecisionsRight}
                onCloseSplit={handleCloseRightPane}
                onSwapPanes={handleSwapPanes}
                onBlockedSend={() => setIsMissingProviderAlertOpen(true)}
                isProviderConfigured={canSend}
                webSearch={webSearch}
                onWebSearchChange={setWebSearch}
                providers={settings.providers}
                activeProviderId={settings.activeProviderId}
                onSelectProviderModel={settings.selectProviderModel}
                onDropSession={(droppedId) => {
                  if (droppedId !== splitSessionId) {
                    void handleOpenSplitWithSession(droppedId);
                  }
                }}
              />
            ) : undefined
          }
        />
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

      {/* 模型与系统设置弹窗 */}
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
        themeMode={themeMode}
        onThemeModeChange={setThemeMode}
        computerUseEnabled={computerUseEnabled}
        onComputerUseEnabledChange={setComputerUseEnabled}
        onStartOAuth={settings.startOAuthLogin}
        onPollOAuth={settings.pollOAuthStatus}
        onOAuthRefresh={settings.refreshOAuthToken}
        onOAuthLogout={settings.logoutOAuth}
        onFetchBalance={settings.fetchBalance}
        onRefreshProviders={settings.refresh}
      />

      {/* 个人微信 ClawBot 扫码绑定弹窗 (iLink 协议) */}
      <WeChatClawbotModal
        open={wechatModalOpen}
        onClose={() => setWechatModalOpen(false)}
        connection={wechat.connection}
        qrData={wechat.qrData}
        scanStatus={wechat.scanStatus}
        errorMessage={wechat.errorMessage}
        resetting={wechat.resetting}
        onFetchQrCode={wechat.fetchQrCode}
        onResetChannel={wechat.resetChannel}
      />

      {/* 未配置API厂商拦截警告弹窗（黑白双主题深度自适应） */}
      <MissingProviderAlertModal
        open={isMissingProviderAlertOpen}
        onClose={() => setIsMissingProviderAlertOpen(false)}
        onOpenSettings={() => {
          setIsMissingProviderAlertOpen(false);
          setSettingsOpen(true);
        }}
        statusText={modelStatus}
      />
    </div>
  );
}

/**
 * 未配置 API 提供商拦截警告弹窗组件。
 * 深度适配黑白双色主题，提供友好说明与一键打开配置指引。
 */
function MissingProviderAlertModal({
  open,
  onClose,
  onOpenSettings,
  statusText,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  statusText?: string;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-xs animate-in fade-in duration-150 select-none"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-[#1c1d22] dark:text-zinc-100 transition-colors animate-in zoom-in-95 duration-150"
      >
        <div className="flex items-start gap-3.5">
          <div className="size-10 rounded-full bg-amber-500/15 text-amber-600 dark:bg-amber-400/15 dark:text-amber-400 flex items-center justify-center shrink-0">
            <AlertTriangleIcon className="size-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[15.5px] font-semibold text-zinc-900 dark:text-zinc-100">
              未配置 API 厂商
            </h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              检测到当前尚未配置有效的大模型提供商或未填写 API Key，无法发送消息发起对话。
            </p>
            {statusText && (
              <div className="mt-2.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-mono text-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800">
                当前状态：<span className="text-amber-600 dark:text-amber-400 font-medium">{statusText}</span>
              </div>
            )}
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              请先在设置中添加或启用模型提供商（如 DeepSeek、OpenAI、SiliconFlow 等）并填入 API Key。
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-3.5 py-1.5 text-[13px] font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white transition-colors cursor-pointer"
          >
            我知道了
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-xl bg-zinc-900 px-4 py-1.5 text-[13px] font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white transition-colors cursor-pointer shadow-xs"
          >
            前往配置提供商
          </button>
        </div>
      </div>
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
