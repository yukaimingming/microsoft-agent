/**
 * 对话会话管理器。
 *
 * 支持按工作区文件夹（Workspace Folders）分组管理对话历史：
 * - 纯净对齐用户设计（类似 Cursor / VSCode 分组）：每个工作区文件夹下挂载对应的聊天记录
 * - 记录并持久化自定义工作区文件夹列表
 * - 会话状态本地持久化存储（localStorage）
 * - 自动根据首条用户消息生成对话标题
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientState } from "./client-reducer.js";

const SESSIONS_STORAGE_KEY = "agentscope_sessions_list_v1";
const WORKSPACES_STORAGE_KEY = "agentscope_workspaces_list_v1";
const SESSION_STATE_PREFIX = "agentscope_session_state_";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  workspaceRoot: string;
  folderName: string;
}

export interface FolderGroup {
  folderPath: string;
  folderName: string;
  sessions: SessionSummary[];
}

export interface RemoteWorkbenchIndex {
  sessions: SessionSummary[];
  customWorkspaces: string[];
  activeSessionId: string;
}

/** 规范化路径用于对比。 */
export function normalizePath(p: string): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 从路径提取文件夹名称。 */
export function extractFolderName(pathStr: string): string {
  if (!pathStr || pathStr.trim().length === 0) return "直接聊天";
  const normalized = pathStr.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

/** 初始空会话。 */
function createNewSessionSummary(id: string, workspaceRoot: string = ""): SessionSummary {
  return {
    id,
    title: "新对话",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    workspaceRoot,
    folderName: extractFolderName(workspaceRoot),
  };
}

export function useSessions(initialThreadId: string, defaultWorkspace: string = "") {
  const remoteSessionStates = useRef(new Map<string, ClientState>());
  // 自定义添加的工作区文件夹路径列表
  const [customWorkspaces, setCustomWorkspaces] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(WORKSPACES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        if (Array.isArray(parsed)) {
          return parsed.filter((p) => p && typeof p === "string" && p.trim().length > 0);
        }
      }
    } catch {
      // 忽略存储读取异常
    }
    return defaultWorkspace ? [defaultWorkspace] : [];
  });

  const [sessions, setSessions] = useState<SessionSummary[]>(() => {
    try {
      const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SessionSummary[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // 容错处理
    }
    return [createNewSessionSummary(initialThreadId, defaultWorkspace)];
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    return sessions[0]?.id ?? initialThreadId;
  });

  // 持久化工作区文件夹列表
  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(customWorkspaces));
    } catch {
      // 忽略
    }
  }, [customWorkspaces]);

  // 持久化会话摘要列表
  useEffect(() => {
    try {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      // 忽略
    }
  }, [sessions]);

  /** 添加或切换工作区文件夹。 */
  const addWorkspace = useCallback((folderPath: string) => {
    const trimmed = folderPath.trim();
    if (!trimmed) return;
    setCustomWorkspaces((prev) => {
      const targetNorm = normalizePath(trimmed);
      if (prev.some((p) => normalizePath(p) === targetNorm)) return prev;
      return [...prev, trimmed];
    });
  }, []);

  /** 彻底移除工作区文件夹，并将其下关联的会话重置为直接聊天模式。 */
  const removeWorkspace = useCallback((folderPath: string) => {
    const targetNorm = normalizePath(folderPath);
    const targetName = extractFolderName(folderPath).toLowerCase();

    // 1. 从 customWorkspaces 彻底移除
    setCustomWorkspaces((prev) =>
      prev.filter((p) => {
        const pNorm = normalizePath(p);
        const pName = extractFolderName(p).toLowerCase();
        return pNorm !== targetNorm && pName !== targetName && p !== folderPath;
      }),
    );

    // 2. 将关联属于该工作区的所有会话，workspaceRoot 置为空 ""（迁移为直接聊天模式）
    setSessions((prev) =>
      prev.map((s) => {
        const sNorm = normalizePath(s.workspaceRoot);
        const sName = extractFolderName(s.workspaceRoot).toLowerCase();
        if (sNorm === targetNorm || sName === targetName || s.workspaceRoot === folderPath) {
          return {
            ...s,
            workspaceRoot: "",
            folderName: "直接聊天",
          };
        }
        return s;
      }),
    );
  }, []);

  /** 读取指定会话的完整状态。 */
  const loadSessionState = useCallback((id: string): ClientState | null => {
    const remoteState = remoteSessionStates.current.get(id);
    if (remoteState) return remoteState;
    try {
      const raw = localStorage.getItem(`${SESSION_STATE_PREFIX}${id}`);
      if (raw) {
        return JSON.parse(raw) as ClientState;
      }
    } catch {
      // 异常时返回 null
    }
    return null;
  }, []);

  const cacheRemoteSessionState = useCallback((id: string, state: ClientState) => {
    remoteSessionStates.current.set(id, state);
    try {
      localStorage.setItem(`${SESSION_STATE_PREFIX}${id}`, JSON.stringify(state));
    } catch {
      // 服务端仍保留会话；本地缓存空间不足时忽略。
    }
  }, []);

  const restoreRemoteIndex = useCallback((index: RemoteWorkbenchIndex) => {
    if (index.sessions.length > 0) setSessions(index.sessions);
    if (index.customWorkspaces.length > 0 || index.sessions.length > 0) {
      setCustomWorkspaces(index.customWorkspaces);
    }
    if (index.sessions.some((session) => session.id === index.activeSessionId)) {
      setActiveSessionId(index.activeSessionId);
    } else if (index.sessions[0]) {
      setActiveSessionId(index.sessions[0].id);
    }
  }, []);

  /** 保存指定会话的完整状态并同步会话摘要。 */
  const saveSessionState = useCallback(
    (id: string, state: ClientState, workspaceRoot: string = "") => {
      try {
        localStorage.setItem(`${SESSION_STATE_PREFIX}${id}`, JSON.stringify(state));
      } catch {
        // 存储异常
      }

      setSessions((prev) => {
        const index = prev.findIndex((s) => s.id === id);
        const userMsg = state.messages.find((m) => m.role === "user");
        let title = "新对话";
        if (userMsg && userMsg.content) {
          title = userMsg.content.slice(0, 24).trim();
          if (userMsg.content.length > 24) title += "…";
        }

        const now = Date.now();
        const root = workspaceRoot ?? "";
        const folder = extractFolderName(root);

        if (index >= 0) {
          const current = prev[index];
          if (!current) return prev;
          const nextTitle = current.title !== "新对话" ? current.title : title;
          if (
            current.title === nextTitle &&
            current.messageCount === state.messages.length &&
            current.workspaceRoot === root
          ) {
            return prev;
          }
          const hasNewMessages = state.messages.length !== current.messageCount;
          const updated: SessionSummary = {
            ...current,
            title: nextTitle,
            updatedAt: hasNewMessages ? now : (current.updatedAt ?? now),
            messageCount: state.messages.length,
            workspaceRoot: root,
            folderName: folder,
          };
          const next = [...prev];
          next[index] = updated;
          return next;
        }

        const newSummary: SessionSummary = {
          id,
          title,
          createdAt: now,
          updatedAt: now,
          messageCount: state.messages.length,
          workspaceRoot: root,
          folderName: folder,
        };
        return [newSummary, ...prev];
      });
    },
    [],
  );

  /** 新建会话：若当前已是干净无消息的空会话，直接复用当前会话，避免产生大量重复的未发消息空会话。 */
  const createSession = useCallback((newId: string, workspaceRoot: string = ""): string => {
    const current = sessions.find((s) => s.id === activeSessionId);
    if (current && current.messageCount === 0 && current.title === "新对话") {
      return current.id;
    }

    const summary = createNewSessionSummary(newId, workspaceRoot);
    setSessions((prev) => [summary, ...prev.filter((s) => s.id !== newId)]);
    setActiveSessionId(newId);
    return newId;
  }, [sessions, activeSessionId]);

  /** 删除会话。 */
  const removeSession = useCallback((id: string) => {
    remoteSessionStates.current.delete(id);
    try {
      localStorage.removeItem(`${SESSION_STATE_PREFIX}${id}`);
    } catch {
      // 异常
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const clearSessionState = useCallback((id: string) => {
    remoteSessionStates.current.delete(id);
    try {
      localStorage.removeItem(`${SESSION_STATE_PREFIX}${id}`);
    } catch {
      // 服务端状态仍会由调用方清理。
    }
  }, []);

  /** 重命名会话。 */
  const renameSession = useCallback((id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: trimmed, updatedAt: Date.now() } : s)),
    );
  }, []);

  /** 当前激活会话所属的工作区根目录。 */
  const activeSession = useMemo(() => {
    return sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  }, [sessions, activeSessionId]);

  /** 按工作区文件夹分组后的会话列表（仅允许有效工作区，绝不复活已删除文件夹）。 */
  const groupedSessions = useMemo((): FolderGroup[] => {
    // 文件夹名称Key -> { canonicalPath, sessions }
    const groupMap = new Map<string, { canonicalPath: string; sessions: SessionSummary[] }>();

    const registerFolder = (rawPath: string) => {
      const trimmed = rawPath.trim();
      if (!trimmed) return;
      const nameKey = extractFolderName(trimmed).toLowerCase();
      const existing = groupMap.get(nameKey);
      if (existing) {
        if (trimmed.length > existing.canonicalPath.length) {
          existing.canonicalPath = trimmed;
        }
      } else {
        groupMap.set(nameKey, { canonicalPath: trimmed, sessions: [] });
      }
    };

    // 1. 严格仅注册 customWorkspaces 里的有效文件夹
    for (const ws of customWorkspaces) {
      if (ws && ws.trim()) {
        registerFolder(ws);
      }
    }

    // 2. 收集无工作区（直接聊天模式）或所属工作区已被移除的会话
    const directChatSessions: SessionSummary[] = [];

    // 3. 将会话归类：仅归入当前合法的工作区分组中；绝不复活已被删除的工作区
    for (const session of sessions) {
      const root = session.workspaceRoot ? session.workspaceRoot.trim() : "";
      if (!root) {
        directChatSessions.push(session);
        continue;
      }
      const nameKey = extractFolderName(root).toLowerCase();
      const target = groupMap.get(nameKey);
      if (target) {
        target.sessions.push(session);
      } else {
        // 所属工作区已不存在，安全归入直接聊天列表
        directChatSessions.push({
          ...session,
          workspaceRoot: "",
          folderName: "直接聊天",
        });
      }
    }

    // 4. 生成最终分组列表
    const groups: FolderGroup[] = [];

    // 排序辅助函数：严格按照最近活跃更新时间降序排列
    const sortByTimeDesc = (a: SessionSummary, b: SessionSummary) => {
      const timeA = a.updatedAt || a.createdAt || 0;
      const timeB = b.updatedAt || b.createdAt || 0;
      return timeB - timeA;
    };

    // 若有直接聊天会话，或者当前无任何工作区文件夹，提供直接聊天分组
    if (directChatSessions.length > 0 || groupMap.size === 0) {
      groups.push({
        folderPath: "",
        folderName: "直接聊天",
        sessions: directChatSessions.sort(sortByTimeDesc),
      });
    }

    // 遍历各合法工作区
    for (const { canonicalPath, sessions: sessionList } of groupMap.values()) {
      groups.push({
        folderPath: canonicalPath,
        folderName: extractFolderName(canonicalPath),
        sessions: sessionList.sort(sortByTimeDesc),
      });
    }

    return groups;
  }, [customWorkspaces, sessions]);

  return {
    sessions,
    groupedSessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    createSession,
    removeSession,
    clearSessionState,
    renameSession,
    loadSessionState,
    cacheRemoteSessionState,
    restoreRemoteIndex,
    saveSessionState,
    customWorkspaces,
    addWorkspace,
    removeWorkspace,
  };
}
