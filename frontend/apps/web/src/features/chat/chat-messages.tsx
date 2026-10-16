/**
 * 聊天消息列表。
 *
 * 严格对齐 AI SDK Elements 官网组件规范 (https://elements.ai-sdk.dev/components)：
 * 1. 纯黑极简底色（与侧边栏一体化），完全去掉用户和智能体的头像。
 * 2. 用户消息：支持重新编辑功能（点击编辑按钮原地修改并重新发送），彻底删除无用的 Checkpoint。
 * 3. 思考组件（Reasoning）：
 *    - 具备微光闪烁（Shimmer 闪光 2 秒动效）；
 *    - 在生成中时展示流式思考动态，并可实时折叠/展开；
 *    - 回答完成后保留折叠卡片，可随时回顾思考过程。
 * 4. 任务列表组件（Queue / Todo）：
 *    - 严格遵循 AI SDK Elements Queue 规范，支持任务状态指示与划线完成。
 * 5. 工具调用卡片（Tool）：
 *    - 实时展开展示调用的工具名、参数输入（ToolInput）与终端执行结果（ToolOutput）。
 * 6. 人工安全审批与纯净 Markdown 渲染。
 */

import { useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../../components/ai-elements/conversation.js";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageToolbar,
  MessageActions as MessageActionsGroup,
  MessageAction,
} from "../../components/ai-elements/message.js";
import { ProcessActivityGroup, type ProcessTimelineItem } from "./process-activity-group.js";
import { DiffCard, type FileChangeSummary } from "./diff-card.js";
import { ChatAttachmentGallery, ImagePreviewDialog, type ChatAttachment } from "./chat-attachments.js";
import { ApprovalCard } from "./approval-card.js";
import {
  CopyIcon,
  CheckIcon,
  RotateCcwIcon,
  SparklesIcon,
  ArrowRightIcon,
  PencilIcon,
  CornerDownLeftIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";
import { cn } from "../../lib/utils.js";
import type { Activity, ChatMessage } from "./chat-types.js";
import type { RunSnapshot } from "@deepagent/shared";

interface ChatMessagesProps {
  messages: ChatMessage[];
  activities: Activity[];
  error: string | null;
  isRunning?: boolean;
  runSnapshot?: RunSnapshot;
  onRetry?: (messageId: string) => void;
  onEditMessage?: (messageId: string, newContent: string, attachments?: ChatAttachment[]) => void;
  onDecide?: (activityId: string, decision: "approve" | "reject") => void;
  decisions?: Record<string, { type: "approve" | "edit" | "reject" }>;
  onQuickPrompt?: (prompt: string) => void;
}

export interface TurnAnswerState {
  streaming: boolean;
  complete: boolean;
}

export interface TurnProcessTimeline {
  /** 键是本轮第一条助手消息。时间线不跟着后面的新消息搬家。 */
  byFinalMessage: Map<string, ProcessTimelineItem[]>;
  ownedMessageIds: Set<string>;
  /** 本轮第一条助手消息，即使还没有任何过程项。 */
  turnHostIds: Set<string>;
  /** 最终正文的流式/完成状态，挂在时间线宿主上，避免总结出现后总线还停在「正在分析」。 */
  answerByHost: Map<string, TurnAnswerState>;
  /** 整轮耗时挂在时间线宿主上，供多段消息场景复用。 */
  durationByHost: Map<string, number>;
}

function timelineRank(item: ProcessTimelineItem): number {
  if (item.kind === "activity") return 2;
  return item.section === "reasoning" ? 0 : 1;
}

export function compareTimelineItems(left: ProcessTimelineItem, right: ProcessTimelineItem): number {
  const leftAt = left.kind === "assistant" ? left.startedAt : left.activity.startedAt;
  const rightAt = right.kind === "assistant" ? right.startedAt : right.activity.startedAt;
  if (leftAt !== rightAt) return leftAt - rightAt;
  return timelineRank(left) - timelineRank(right);
}

/**
 * 按时间戳与阶段优先级排列过程行。
 * 由于客户端归约器已对思考开始、正文开始、工具开始打上单调递增且不可变的启动时间戳，
 * 按 compareTimelineItems 排序即可保证所有过程项始终处于真实的产生顺序，
 * 不会出现中间过程说明被排到下一轮思考后面的问题。
 */
export function appendTimelineOrder(
  order: Map<string, number>,
  items: ProcessTimelineItem[],
): ProcessTimelineItem[] {
  const known: ProcessTimelineItem[] = [];
  const fresh: ProcessTimelineItem[] = [];
  for (const item of items) {
    if (order.has(item.id)) known.push(item);
    else fresh.push(item);
  }
  known.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  fresh.sort(compareTimelineItems);

  const result = [...known];
  for (const item of fresh) {
    if (item.id.startsWith("message:")) {
      const msgId = item.id.slice("message:".length);
      const reasoningIdx = result.findIndex((existing) => existing.id === `reasoning:${msgId}`);
      if (reasoningIdx !== -1) {
        result.splice(reasoningIdx + 1, 0, item);
        continue;
      }
    }
    result.push(item);
  }

  order.clear();
  result.forEach((item, index) => order.set(item.id, index));
  return result;
}

function projectTimeline(
  messages: ChatMessage[],
  activities: Activity[],
  previousOrder: ReadonlyMap<string, number>,
): TurnProcessTimeline & { messages: ChatMessage[]; activities: Activity[]; order: Map<string, number> } {
  const built = buildTurnProcessTimeline(messages, activities);
  const order = new Map(previousOrder);
  const byFinalMessage = new Map<string, ProcessTimelineItem[]>();
  for (const [hostId, items] of built.byFinalMessage) {
    byFinalMessage.set(hostId, appendTimelineOrder(order, items));
  }
  return { ...built, byFinalMessage, messages, activities, order };
}

/**
 * 按时间把一轮里的思考、中间说明和工具排进同一条时间线。
 * 时间线挂在本轮第一条助手消息上。
 * 最后一条非过程性质且有正文的消息留在时间线外面，用 Markdown 显示。
 * 中间说明直接进入时间线按序流式展示，不会先跳到外部 Markdown 再跳回时间线。
 */
export function buildTurnProcessTimeline(
  messages: ChatMessage[],
  activities: Activity[],
): TurnProcessTimeline {
  const byFinalMessage = new Map<string, ProcessTimelineItem[]>();
  const ownedMessageIds = new Set<string>();
  const turnHostIds = new Set<string>();
  const answerByHost = new Map<string, TurnAnswerState>();
  const durationByHost = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    let start = index;
    while (start > 0 && messages[start - 1]?.role !== "user") start -= 1;
    let end = index + 1;
    while (end < messages.length && messages[end]?.role !== "user") end += 1;
    const turnMessages = messages.slice(start, end).filter((item) => item.role === "assistant");
    const host = turnMessages[0];
    if (!host || host.id !== message.id) continue;
    turnHostIds.add(host.id);

    const turnDuration = [...turnMessages].reverse().find((item) => item.runDurationMs !== undefined)?.runDurationMs;
    if (turnDuration !== undefined) {
      durationByHost.set(host.id, turnDuration);
    }

    const runIds = new Set(turnMessages.map((item) => item.runId).filter((id): id is string => Boolean(id)));
    const firstTime = host.createdAt ?? 0;
    const nextTurnTime = messages[end]?.createdAt;
    const turnActivities = activities.filter((activity) => {
      if (activity.kind !== "tool" && activity.kind !== "subagent") return false;
      if (activity.runId && runIds.size > 0 && !runIds.has(activity.runId)) return false;
      if (!activity.runId && activity.startedAt < firstTime) return false;
      if (nextTurnTime !== undefined && activity.startedAt >= nextTurnTime) return false;
      return true;
    });

    const isItemProcessMessage = (item: ChatMessage, msgIdx: number): boolean => {
      if (item.isProcess === true) return true;
      const hasLaterAssistantContent = turnMessages
        .slice(msgIdx + 1)
        .some((later) => Boolean(later.content.trim()));
      if (hasLaterAssistantContent) return true;

      // 核心防线：若本轮后面已无后续助手正文且当前消息处于本轮最后一条，它必然是本轮最终答复，
      // 绝不可被判定为过程消息吞掉，彻底杜绝正文闪现后消失的问题！
      if (msgIdx === turnMessages.length - 1) {
        return false;
      }

      const contentStart = item.contentStartedAt ?? item.createdAt ?? 0;
      if (
        Boolean(item.content.trim()) &&
        turnActivities.some((activity) => activity.startedAt >= contentStart)
      ) {
        return true;
      }
      if (Boolean(item.reasoning) && msgIdx < turnMessages.length - 1) {
        return true;
      }
      // 【关键修复】：当大模型流式输出中间过渡文本（如“我来为你加载/查询某文件”），
      // 若该消息伴随思考且文本属于引导短句（字数 < 120 字且以意图动词开头，或在活跃运行中），
      // 必须留在思考链时间线内部流式展示，严禁跳到外部正文气泡中闪现再缩回！
      if (
        item.streaming &&
        Boolean(item.reasoning) &&
        (item.content.trim().length < 120 && /^(我来|我将|让我|正在|先|为了|接下来|准备|调用|使用|执行|通过)/.test(item.content.trim()))
      ) {
        return true;
      }
      return false;
    };

    let finalMessage: ChatMessage | null = null;
    for (let msgIdx = turnMessages.length - 1; msgIdx >= 0; msgIdx -= 1) {
      const candidate = turnMessages[msgIdx]!;
      if (candidate.content.trim() && !isItemProcessMessage(candidate, msgIdx)) {
        finalMessage = candidate;
        break;
      }
    }

    if (finalMessage && finalMessage.content.trim()) {
      answerByHost.set(host.id, {
        streaming: finalMessage.streaming,
        complete: !finalMessage.streaming,
      });
    }

    if (
      turnActivities.length === 0 &&
      !turnMessages.some((item, msgIdx) => Boolean(item.reasoning) || isItemProcessMessage(item, msgIdx))
    ) {
      continue;
    }

    const items: ProcessTimelineItem[] = [];
    for (let msgIdx = 0; msgIdx < turnMessages.length; msgIdx += 1) {
      const item = turnMessages[msgIdx]!;
      const createdAt = item.createdAt ?? 0;
      const isProcess = isItemProcessMessage(item, msgIdx);
      if (item.reasoning) {
        items.push({
          id: `reasoning:${item.id}`,
          kind: "assistant",
          label: item.reasoningStreaming ? "正在思考" : "已完成分析",
          content: item.reasoning,
          startedAt: item.reasoningStartedAt ?? createdAt,
          streaming: item.reasoningStreaming,
          section: "reasoning",
        });
        if (item.id !== finalMessage?.id && (!item.content.trim() || isProcess)) {
          ownedMessageIds.add(item.id);
        }
      }
      if (isProcess && (item.content.trim() || (item.streaming && !item.reasoningStreaming))) {
        if (item.content.trim()) {
          items.push({
            id: `message:${item.id}`,
            kind: "assistant",
            label: item.streaming ? "正在整理过程" : "已完成分析",
            content: item.content,
            startedAt: item.contentStartedAt ?? createdAt,
            streaming: item.streaming,
          });
        }
        ownedMessageIds.add(item.id);
      }
      // 防御锁：非最终答复且无实质正文的消息（如中间过程节点、空占位），一律由时间线接管，禁止外漏
      if (item.id !== finalMessage?.id && !item.content.trim()) {
        ownedMessageIds.add(item.id);
      }
    }
    for (const activity of turnActivities) items.push({ id: activity.id, kind: "activity", activity });
    items.sort(compareTimelineItems);
    byFinalMessage.set(host.id, items);
  }
  return { byFinalMessage, ownedMessageIds, turnHostIds, answerByHost, durationByHost };
}

export function findPromotedMessageId(
  messages: ChatMessage[],
  toolsByMessage: Map<string, Activity[]>,
): string | null {
  const latest = [...messages].reverse().find((item) => item.role === "assistant");
  if (!latest) return null;
  const runMessages = messages.filter((item) => item.role === "assistant" && item.runId === latest.runId && item.content.trim());
  if (runMessages.some((item) => (toolsByMessage.get(item.id) ?? []).length === 0)) return null;
  return runMessages.at(-1)?.id ?? null;
}

export function shouldHideIntermediateAssistantText(
  message: Pick<ChatMessage, "id" | "content" | "streaming">,
  toolActivities: Activity[],
  promotedId: string | null,
): boolean {
  return toolActivities.length > 0 && message.content.length > 0 && message.id !== promotedId && !message.streaming;
}

/** 映射审批中断决策 */
function decisionFor(
  decisions: Record<string, { type: "approve" | "edit" | "reject" }> | undefined,
  activity: Activity,
): "approve" | "reject" | undefined {
  if (!decisions) return undefined;
  const interruptId = activity.id.split(":")[1];
  if (!interruptId) return undefined;
  const decision = decisions[interruptId] ?? decisions[activity.id];
  if (!decision) return undefined;
  return decision.type === "approve" ? "approve" : "reject";
}

/** 格式化消息发送时间为 HH:mm 格式（例如 14:14），若无有效时间戳返回空字符串，严禁使用 new Date() 当前时间覆盖历史 */
function formatMessageTime(createdAt?: number): string {
  if (!createdAt || typeof createdAt !== "number" || Number.isNaN(createdAt) || createdAt <= 0) {
    return "";
  }
  const d = new Date(createdAt);
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function ChatMessages({
  messages,
  activities,
  error: _error,
  isRunning: _isRunning = false,
  runSnapshot,
  onRetry,
  onEditMessage,
  onDecide,
  decisions,
  onQuickPrompt,
}: ChatMessagesProps) {
  // 人工审批活动：仅在当前明确处于等待审批态且该中断尚未决断时展示，用户操作后立即隐藏，严禁残留无用卡片
  const isWaitingApproval = runSnapshot?.status === "waiting_approval";
  const pendingInterruptIds = useMemo(() => {
    return new Set(runSnapshot?.interrupts?.map((item) => item.id) ?? []);
  }, [runSnapshot?.interrupts]);
  const approvals = useMemo(() => {
    if (!isWaitingApproval) return [];
    return activities.filter((activity) => {
      if (activity.kind !== "approval") return false;
      const interruptId = activity.id.replace("approval:", "");
      return pendingInterruptIds.has(interruptId) && !decisionFor(decisions, activity);
    });
  }, [activities, isWaitingApproval, pendingInterruptIds, decisions]);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<ChatAttachment | null>(null);
  // 顺序表必须跟这次渲染一起更新，使用 useRef 保存已有顺序，useMemo 纯计算消除 render 阶段调用 setState 的死循环隐患
  const timelineOrderRef = useRef<Map<string, number>>(new Map());
  const timelineView = useMemo(() => {
    const projected = projectTimeline(messages, activities, timelineOrderRef.current);
    timelineOrderRef.current = projected.order;
    return projected;
  }, [messages, activities]);
  const {
    byFinalMessage: turnTimelineByMessage,
    ownedMessageIds: timelineOwnedMessageIds,
    turnHostIds,
    answerByHost,
    durationByHost,
  } = timelineView;

  // 用户消息原地编辑状态
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [editingAttachments, setEditingAttachments] = useState<ChatAttachment[]>([]);

  const fileChanges = useMemo<FileChangeSummary[]>(() => {
    const grouped = new Map<string, FileChangeSummary>();
    for (const activity of activities) {
      if (activity.kind !== "file") continue;
      const detail = activity.detail as { path?: string; operation?: string; diff?: { additions?: number; deletions?: number; patch?: string; truncated?: boolean } } | undefined;
      if (!detail?.path || !detail.diff || typeof detail.diff.additions !== "number") continue;
      const revision = {
        additions: detail.diff.additions,
        deletions: detail.diff.deletions ?? 0,
        patch: detail.diff.patch ?? "",
        truncated: Boolean(detail.diff.truncated),
      };
      const operation = detail.operation === "edit" || detail.operation === "delete" ? detail.operation : "write";
      const existing = grouped.get(detail.path);
      if (existing) {
        existing.additions += revision.additions;
        existing.deletions += revision.deletions;
        existing.revisions.push(revision);
        existing.operation = operation;
      } else {
        grouped.set(detail.path, { path: detail.path, operation, additions: revision.additions, deletions: revision.deletions, revisions: [revision] });
      }
    }
    return [...grouped.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [activities]);

  const handleCopy = (id: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const startEditMessage = (id: string, currentContent: string, attachments: ChatAttachment[] = []) => {
    setEditingMessageId(id);
    setEditingContent(currentContent);
    setEditingAttachments(attachments);
  };

  const handleSaveEdit = (messageId: string) => {
    const trimmed = editingContent.trim();
    if (trimmed && onEditMessage) {
      const message = messages.find((item) => item.id === messageId);
      onEditMessage(messageId, trimmed, editingAttachments.length ? editingAttachments : message?.attachments);
    }
    setEditingMessageId(null);
  };

  return (
    <Conversation className="min-h-0 flex-1 bg-black">
      <ConversationContent className="mx-auto w-full max-w-3xl px-0 py-8">
        {messages.length === 0 ? (
          /* 空状态引导区 */
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-zinc-900 border border-zinc-800 text-zinc-300 shadow-inner">
              <SparklesIcon className="size-6 text-zinc-100" />
            </div>
            {(() => {
              const hour = new Date().getHours();
              let greetingTitle: string;
              let greetingDesc: string;
              if (hour >= 5 && hour < 9) {
                greetingTitle = "早上好呀！";
                greetingDesc = "新的一天开始啦，今天想一起做些什么呢？";
              } else if (hour >= 9 && hour < 12) {
                greetingTitle = "上午好！";
                greetingDesc = "保持专注与好心情，有什么任务或灵感随时告诉我。";
              } else if (hour >= 12 && hour < 14) {
                greetingTitle = "中午好！";
                greetingDesc = "忙碌了一上午，记得适度休息、按时吃顿午餐哦。";
              } else if (hour >= 14 && hour < 18) {
                greetingTitle = "下午好！";
                greetingDesc = "喝杯水稍作休息，今天也辛苦啦，继续为你提供全方位协助。";
              } else if (hour >= 18 && hour < 23) {
                greetingTitle = "晚上好！";
                greetingDesc = "今天辛苦啦！放松一下心情，或者整理沉淀一下今天的成果吧。";
              } else {
                greetingTitle = "夜深了！";
                greetingDesc = "夜深人静啦，注意早点休息哦，明天又是充实而美好的一天。";
              }
              return (
                <>
                  <h2 className="mb-2 text-xl font-semibold text-zinc-100 tracking-tight">
                    {greetingTitle}
                  </h2>
                  <p className="mb-6 max-w-md text-[13.5px] text-zinc-400">
                    {greetingDesc}
                  </p>
                </>
              );
            })()}

            <div className="grid w-full max-w-2xl grid-cols-1 gap-2 text-left sm:grid-cols-2">
              {[
                {
                  badge: "待办清单",
                  label: "任务清单与自治循环",
                  desc: "todos_* 拆解清单、推进并自动评估",
                  prompt: "使用 todos_add 为当前工作区规划一个开发自动化脚本的待办任务清单，逐步标记完成并汇报成果。",
                },
                {
                  badge: "文件变更",
                  label: "多盘读写与行级 Diff",
                  desc: "file_access_* 读写替换并生成差异卡片",
                  prompt: "在工作区创建一个名为 demo-notes.txt 的文件，写入几行项目介绍；再用 file_access_replace 修改其中内容并展示行级 Diff 对比。",
                },
                {
                  badge: "深度思考",
                  label: "深度推演与思维链",
                  desc: "流式输出思考过程并支持实时折叠展开",
                  prompt: "请启动深度思考，全面对比快速排序与堆排序算法在内存局部性、最坏时间复杂度与工业界实际系统场景下的核心差异。",
                },
                {
                  badge: "文档子Agent",
                  label: "委派 docAnalyst 分析文档",
                  desc: "委派只读子智能体解析 PDF / Excel",
                  prompt: "委派 docAnalyst 子智能体帮我读取并分析工作区中的文档，提取核心指标和结论，返回结构化中文摘要。",
                },
                {
                  badge: "整理子Agent",
                  label: "委派 fileOrganizer 归类",
                  desc: "委派子智能体扫描目录规划归类方案",
                  prompt: "委派 fileOrganizer 子智能体扫描当前目录的文件结构，按文件类型和用途输出清晰的归类整理规划方案。",
                },
                {
                  badge: "智能终端",
                  label: "Shell 命令与安全放行",
                  desc: "run_shell 命令执行与只读自动免审",
                  prompt: "使用 run_shell 执行 PowerShell 命令查看当前系统与目录环境信息，体验只读命令自动放行机制。",
                },
                {
                  badge: "模式切换",
                  label: "规划与执行模式切换",
                  desc: "mode_get / mode_set 严谨推进复杂任务",
                  prompt: "使用 mode_get 查看当前工作模式，并为复杂重构任务在 plan 规划模式与 execute 执行模式之间智能切换。",
                },
                {
                  badge: "长期记忆",
                  label: "跨会话记忆检索与沉淀",
                  desc: "file_memory_* 事实抽取与长期记忆存储",
                  prompt: "请记住：我的首选开发框架是 Microsoft Agent Framework (MAF) .NET 10，把这个开发偏好存入长期记忆并在后续对话中生效。",
                },
              ].map((item) => (

                <button
                  key={item.label}
                  type="button"
                  onClick={() => onQuickPrompt?.(item.prompt)}
                  className="group flex flex-col justify-between gap-1 rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-2.5 text-left transition-all hover:border-zinc-700 hover:bg-zinc-900/90 hover:shadow-md cursor-pointer"
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-300 border border-zinc-700/60">
                      {item.badge}
                    </span>
                    <ArrowRightIcon className="size-3 text-zinc-500 group-hover:text-zinc-200 transition-colors" />
                  </div>
                  <div>
                    <div className="text-[12.5px] font-medium text-zinc-200 group-hover:text-white">
                      {item.label}
                    </div>
                    <div className="text-[11px] text-zinc-400 line-clamp-1 mt-0.5">
                      {item.desc}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col space-y-6">
            {messages.map((message, idx) => {
              const isUser = message.role === "user";
              const isLast = idx === messages.length - 1;
              const isEditing = editingMessageId === message.id;


              // 用户消息渲染
              if (isUser) {
                const messageTime = formatMessageTime(message.createdAt);
                const isCopied = copiedId === message.id;

                return (
                  <div key={message.id} className="group/user flex flex-col items-end w-full">
                    {isEditing ? (
                      /* 内联编辑模式：与提示词输入框风格统一，重新发送按钮完全一致 */
                      <div className="w-full max-w-[85%] rounded-2xl border border-zinc-700/80 bg-zinc-900 p-3.5 shadow-xl">
                        <ChatAttachmentGallery files={editingAttachments} onPreview={setPreviewAttachment} />
                        <textarea
                          value={editingContent}
                          onChange={(e) => setEditingContent(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              handleSaveEdit(message.id);
                            } else if (e.key === "Escape") {
                              setEditingMessageId(null);
                            }
                          }}
                          className="w-full min-h-[75px] bg-transparent text-[14px] text-zinc-100 outline-none resize-none placeholder:text-zinc-500 leading-relaxed"
                          placeholder="重新编辑消息内容..."
                          autoFocus
                        />
                        <div className="flex items-center justify-end gap-2 mt-2 pt-2 border-t border-zinc-800/80">
                          <button
                            type="button"
                            onClick={() => setEditingMessageId(null)}
                            className="px-2.5 py-1 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors"
                          >
                            取消
                          </button>
                          {/* 重新发送按钮：与底部提示词输入框样式及图标完全一致 */}
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(message.id)}
                            disabled={!editingContent.trim()}
                            className="size-8 rounded-lg bg-zinc-100 text-black hover:bg-white disabled:opacity-30 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors shadow-none flex items-center justify-center cursor-pointer disabled:cursor-not-allowed"
                            title="重新发送 (Enter)"
                          >
                            <CornerDownLeftIcon className="size-4" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* 普通气泡展示模式：按用户截图样式呈现（气泡 + 下方时间戳 + 复制 + 编辑） */
                      <div className="flex flex-col items-end max-w-[85%] space-y-1">
                        {/* 气泡主体 */}
                        <div className="rounded-2xl bg-zinc-900/90 px-4 py-2.5 text-[14px] text-zinc-100 shadow-sm border border-zinc-800/80">
                          <p className="whitespace-pre-wrap break-words leading-relaxed">
                            {message.content}
                          </p>
                        </div>
                        <ChatAttachmentGallery files={message.attachments ?? []} onPreview={setPreviewAttachment} />

                        {/* 气泡右下方元数据操作栏：时间戳、复制、编辑（完全对齐用户上传截图） */}
                        <div className="flex items-center gap-1.5 pt-0.5 text-zinc-400">
                          {/* 时间戳 */}
                          <span className="text-[12px] text-zinc-500 select-none tabular-nums font-normal mr-0.5">
                            {messageTime}
                          </span>

                          {/* 复制按钮 */}
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => handleCopy(message.id, message.content)}
                                  className="flex size-6 items-center justify-center rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors cursor-pointer"
                                >
                                  {isCopied ? (
                                    <CheckIcon className="size-3.5 text-emerald-400" />
                                  ) : (
                                    <CopyIcon className="size-3.5" />
                                  )}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">
                                {isCopied ? "已复制" : "复制"}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>

                          {/* 编辑按钮（悬停弹出黑底白字 Tooltip） */}
                          {onEditMessage && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                  onClick={() => startEditMessage(message.id, message.content, message.attachments)}
                                    className="flex size-6 items-center justify-center rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors cursor-pointer"
                                  >
                                    <PencilIcon className="size-3.5" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">
                                  编辑
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              // 助手 Agent 消息（无头像、左对齐纯净排版）

              const processItems = turnTimelineByMessage.get(message.id) ?? [];
              const messageIsInTimeline = timelineOwnedMessageIds.has(message.id);
              if (messageIsInTimeline && processItems.length === 0) return null;
              const runIsLive = runSnapshot?.status === "connecting"
                || runSnapshot?.status === "running"
                || runSnapshot?.status === "waiting_approval";
              const hasLaterUserMessage = messages.slice(idx + 1).some((item) => item.role === "user");
              const isLatestTurn = !hasLaterUserMessage;
              // 空的「正在分析」只出现在本轮第一条助手消息上。后面的消息不再另起一条总线。
              const showLivePlaceholder = processItems.length === 0
                && turnHostIds.has(message.id)
                && isLatestTurn
                && runIsLive;
              // 思考还在增量到达时先不画正文，避免两段抢同一条消息。
              // 已被时间线收下的说明（含运行中、工具之后的中间返回）不在外面再画一份 Markdown。
              const isReasoningStreaming = message.reasoningStreaming === true;
              const hasSubstantialContent = Boolean(message.content && message.content.trim().length > 0);
              const shouldShowMessageContent =
                !messageIsInTimeline &&
                !isReasoningStreaming &&
                (hasSubstantialContent || (message.streaming && !message.reasoningStreaming));
              const turnAnswer = answerByHost.get(message.id);
              const hostDurationMs = durationByHost.get(message.id) ?? message.runDurationMs;

              const hasProcessSection = Boolean(processItems.length > 0 || showLivePlaceholder);
              const hasApprovalSection = Boolean(isLast && approvals.length > 0);
              // 如果既没有过程时间线，也没有正文内容，也没有审批卡片，整块直接跳过，避免留出多余空容器
              if (!hasProcessSection && !shouldShowMessageContent && !hasApprovalSection) {
                return null;
              }

              return (
                <div key={message.id} className="flex flex-col w-full text-zinc-100 space-y-3">
                  {/* 过程时间线固定在本轮第一条助手消息上，工具按出现顺序往下追加。 */}
                  {hasProcessSection && (
                  <ProcessActivityGroup
                    key={message.id}
                    items={processItems}
                    isActive={showLivePlaceholder || (runIsLive && processItems.length > 0 && isLatestTurn)}
                    startedAt={runSnapshot?.startedAt}
                    finalAnswerComplete={turnAnswer?.complete ?? false}
                    finalAnswerStreaming={turnAnswer?.streaming ?? false}
                    durationMs={hostDurationMs ?? (message.runId === runSnapshot?.runId ? runSnapshot?.durationMs : undefined)}
                    runCompleted={message.runId === runSnapshot?.runId ? runSnapshot?.status === "completed" : hostDurationMs !== undefined}
                  />
                  )}

                  {/* 4. 人工安全审批卡片 */}
                  {hasApprovalSection &&
                    approvals.map((activity) => (
                      <div key={activity.id} className="w-full my-1">
                        <ApprovalCard
                          activity={activity}
                          decision={decisionFor(decisions, activity)}
                          onDecide={onDecide}
                        />
                      </div>
                    ))}

                  {/* 5. 消息正文与流式回答：仅在推理完成后开始输出 */}
                  {shouldShowMessageContent && (
                    <Message from="assistant" className="w-full">
                      <MessageContent className="text-zinc-100 w-full text-[14px]">
                        {message.streaming && !hasSubstantialContent ? (
                          <span className="text-[13px] text-zinc-500 animate-pulse">
                            正在输出回答…
                          </span>
                        ) : hasSubstantialContent ? (
                          <div className={cn("w-full text-zinc-100", message.streaming && "streaming-caret")}>
                            <MessageResponse mode="static" isAnimating={message.streaming}>
                              {message.content}
                            </MessageResponse>
                          </div>
                        ) : null}
                      </MessageContent>

                      {/* 消息底部操作工具条（复制、重试）：严格要求有实质非空正文 */}
                      {!message.streaming && hasSubstantialContent && (
                        <MessageToolbar className="mt-2 text-zinc-500">
                          <MessageActionsGroup>
                            <MessageAction
                              tooltip="复制回答"
                              onClick={() => handleCopy(message.id, message.content)}
                              className="hover:text-zinc-200"
                            >
                              {copiedId === message.id ? (
                                <CheckIcon className="size-3.5 text-emerald-400" />
                              ) : (
                                <CopyIcon className="size-3.5" />
                              )}
                            </MessageAction>

                            {onRetry && (
                              <MessageAction
                                tooltip="重新生成回答"
                                onClick={() => onRetry(message.id)}
                                className="hover:text-zinc-200"
                              >
                                <RotateCcwIcon className="size-3.5" />
                              </MessageAction>
                            )}
                          </MessageActionsGroup>
                        </MessageToolbar>
                      )}
                    </Message>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {fileChanges.length > 0 && <DiffCard changes={fileChanges} />}
      </ConversationContent>
      <ConversationScrollButton />
      <ImagePreviewDialog file={previewAttachment} onOpenChange={(open) => { if (!open) setPreviewAttachment(null); }} />
    </Conversation>
  );
}
