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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
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
import { ConversationTurnNavigator, type ConversationTurn } from "./conversation-turn-navigator.js";
import { DiffCard, type FileChangeSummary, type FileRevision } from "./diff-card.js";
import { ChatAttachmentGallery, ImagePreviewDialog, type ChatAttachment } from "./chat-attachments.js";
import { ApprovalCard } from "./approval-card.js";
import { BloubBot } from "./bloub-bot.js";
import {
  CopyIcon,
  CheckIcon,
  RotateCcwIcon,
  ArrowRightIcon,
  PencilIcon,
  ArrowUpIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";
import { InputGroupButton } from "../../components/ui/input-group.js";
import { cn } from "../../lib/utils.js";
import type { Activity, ChatMessage } from "./chat-types.js";
import type { RunSnapshot } from "@deepagent/shared";
import {
  FINAL_SUMMARY_STRUCTURE_RE,
  INTERMEDIATE_ACTION_HINT_RE,
  PROCESS_PREAMBLE_LEAD_RE,
  STREAMING_PROCESS_HINT_RE,
  canDemoteAssistantToProcess,
  hasStructuredExternalMarkdown,
  isProcessOpeningText,
  plainProcessHintText,
  plansConcreteTool,
} from "./client-reducer.js";

/** 流式输出尚未达到足够长度前的缓冲门槛，避免短前缀先闪现到外部正文区再跳回时间线。 */
const PENDING_TEXT_THRESHOLD = 48;
const PENDING_TEXT_THRESHOLD_AFTER_TOOLS = 100;

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
  /** 键是所属分段的第一条助手消息（常见单段场景即本轮第一条助手消息）。 */
  byFinalMessage: Map<string, ProcessTimelineItem[]>;
  /** 外部实质回答之后直接跟了工具、尚无后续助手消息可挂载时，暂挂在该回答下方。 */
  trailingByMessage: Map<string, ProcessTimelineItem[]>;
  ownedMessageIds: Set<string>;
  /** 允许承载「正在分析」空占位的分段宿主消息 ID。 */
  turnHostIds: Set<string>;
  /** 当前仍处于活跃或收尾中的分段宿主集合（避免多段轮次里已完成的旧段被误置为正在分析）。 */
  activeHostIds: Set<string>;
  /** 尚未达到稳定门限、暂不在正文区渲染的流式短文本 ID。 */
  pendingMessageIds: Set<string>;
  /** 各分段最终正文的流式/完成状态，挂在对应分段宿主上。 */
  answerByHost: Map<string, TurnAnswerState>;
  /** 分段耗时（单段复用整轮耗时；多段按本段实际时间跨度计算）。 */
  durationByHost: Map<string, number>;
  /** 多段模式下各分段独立起始时间（供活跃新段从自身起点计时）。 */
  segmentStartedAtByHost: Map<string, number>;
  /** 各分段是否已收尾完成。 */
  segmentCompletedByHost: Map<string, boolean>;
  /** 标记属于多段拆分轮次的分段宿主（避免错误沿用整轮总耗时覆盖本段耗时）。 */
  multiSegmentHostIds: Set<string>;
  /** 本轮/本段文件变更 Diff 摘要，严格归属于产生修改的助手消息，绝不泄露到后续对话轮次中。 */
  diffByMessageId: Map<string, FileChangeSummary[]>;
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
  const trailingByMessage = new Map<string, ProcessTimelineItem[]>();
  for (const [hostId, items] of built.trailingByMessage) {
    trailingByMessage.set(hostId, appendTimelineOrder(order, items));
  }
  return { ...built, byFinalMessage, trailingByMessage, messages, activities, order };
}

/**
 * 从文件活动列表中解析文件差异汇总数据。
 */
export function parseFileChangesFromActivities(activities: Activity[]): FileChangeSummary[] {
  const grouped = new Map<string, FileChangeSummary>();
  for (const activity of activities) {
    if (activity.kind !== "file") continue;
    const detail = activity.detail as
      | {
          path?: string;
          operation?: string;
          diff?: { additions?: number; deletions?: number; patch?: string; truncated?: boolean };
        }
      | undefined;
    if (!detail?.path || !detail.diff || typeof detail.diff.additions !== "number") continue;
    const revision: FileRevision = {
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
      grouped.set(detail.path, {
        path: detail.path,
        operation,
        additions: revision.additions,
        deletions: revision.deletions,
        revisions: [revision],
      });
    }
  }
  return [...grouped.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 按时间把一轮里的思考、中间说明和工具按「实质外部回答」分段排进时间线（方案 A）。
 * - 常规轮次（前置过程 + 最终答复）保持为单一分段，时间线固定在本轮第一条助手消息上；
 * - 若同一轮先产出了一份实质外部回答、后续又触发工具调用或新一轮步骤，则以该实质回答为界自然分段：
 *   原实质回答稳定留在正文 Markdown 区，后续工具与新步骤作为下一条时间线接在其下方；
 * - 流式过程中尚未越过稳定门限的短前缀暂入 pendingMessageIds，防止正文区与时间线之间来回跳动。
 */
export function buildTurnProcessTimeline(
  messages: ChatMessage[],
  activities: Activity[],
): TurnProcessTimeline {
  const byFinalMessage = new Map<string, ProcessTimelineItem[]>();
  const trailingByMessage = new Map<string, ProcessTimelineItem[]>();
  const ownedMessageIds = new Set<string>();
  const turnHostIds = new Set<string>();
  const activeHostIds = new Set<string>();
  const pendingMessageIds = new Set<string>();
  const answerByHost = new Map<string, TurnAnswerState>();
  const durationByHost = new Map<string, number>();
  const segmentStartedAtByHost = new Map<string, number>();
  const segmentCompletedByHost = new Map<string, boolean>();
  const multiSegmentHostIds = new Set<string>();
  const diffByMessageId = new Map<string, FileChangeSummary[]>();

  interface TurnSegment {
    startIdx: number;
    endIdx: number;
    host: ChatMessage;
    answerMessage: ChatMessage | null;
    activities: Activity[];
    trailingActivities: Activity[];
    fileActivities: Activity[];
  }

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

    const turnDuration = [...turnMessages].reverse().find((item) => item.runDurationMs !== undefined)?.runDurationMs;

    const runIds = new Set(turnMessages.map((item) => item.runId).filter((id): id is string => Boolean(id)));
    const userMsg = start > 0 ? messages[start - 1] : null;
    const turnStartTime = userMsg?.createdAt ?? host.createdAt ?? 0;
    const nextTurnTime = messages[end]?.createdAt;
    const turnActivities = activities.filter((activity) => {
      if (activity.kind !== "tool" && activity.kind !== "subagent") return false;
      // 轮次隔离：绝不带入上一轮的工具活动
      if (turnStartTime > 0 && activity.startedAt > 0 && activity.startedAt < turnStartTime) return false;
      if (activity.runId && runIds.size > 0 && !runIds.has(activity.runId)) return false;
      if (nextTurnTime !== undefined && activity.startedAt >= nextTurnTime) return false;
      return true;
    });

    const allTurnActivities = activities.filter((activity) => {
      const kind = activity.kind as string;
      if (
        kind !== "tool" &&
        kind !== "subagent" &&
        kind !== "todo" &&
        kind !== "reflection" &&
        kind !== "approval" &&
        kind !== "file"
      ) {
        return false;
      }
      if (turnStartTime > 0 && activity.startedAt > 0 && activity.startedAt < turnStartTime) return false;
      if (activity.runId && runIds.size > 0 && !runIds.has(activity.runId)) return false;
      if (nextTurnTime !== undefined && activity.startedAt >= nextTurnTime) return false;
      return true;
    });

    const isItemProcessMessage = (item: ChatMessage, msgIdx: number): boolean => {
      const trimmed = item.content.trim();

      // 0. 治本防降级与历史纠偏（方案 1）：
      //    结构化外部正文（或未预标过程且已跨过缓冲形成非过程实质正文）禁止落入过程摘要——
      //    即使后续又产生工具调用、新消息，或历史持久化数据曾误带 `isProcess: true`。
      if (trimmed && !canDemoteAssistantToProcess(item)) {
        return false;
      }

      // 1. 已被标记为过程消息（后端 CUSTOM_PROCESS_MESSAGE / isProcess: true），属于时间线过程
      if (item.isProcess === true) return true;

      // 2. 后续已有其他 assistant 消息且有正文内容：前面非实质正文的短消息属于前序过程说明
      const hasLaterAssistantContent = turnMessages
        .slice(msgIdx + 1)
        .some((later) => Boolean(later.content.trim()));
      if (hasLaterAssistantContent) return true;

      const contentStart = item.contentStartedAt ?? item.createdAt ?? 0;
      const hintText = plainProcessHintText(trimmed);

      // 3. 流式过程中带「操作引导」语气的非结构化说明（即使写成单行 ### 标题）先留在时间线内，
      //    等后续工具调用确认，避免先闪现到外部总结区再跳回时间线。
      if (
        item.streaming &&
        Boolean(hintText) &&
        !hasStructuredExternalMarkdown(trimmed) &&
        turnActivities.length > 0 &&
        (STREAMING_PROCESS_HINT_RE.test(hintText) ||
          PROCESS_PREAMBLE_LEAD_RE.test(hintText) ||
          INTERMEDIATE_ACTION_HINT_RE.test(hintText))
      ) {
        return true;
      }

      // 4. 在当前短/非实质消息内容开始时或之后，存在工具调用或子智能体活动：这是工具前过程说明
      if (
        Boolean(trimmed) &&
        turnActivities.some((activity) => activity.startedAt >= contentStart)
      ) {
        return true;
      }

      // 5. 伴随思考的非实质节点且并非本轮最后一条消息
      if (Boolean(item.reasoning) && msgIdx < turnMessages.length - 1) {
        return true;
      }

      // 6. 流式期间尚未收到 PROCESS_MESSAGE 标记的纯单段工具前过渡句兜底（排除任何带明确总结结构的终稿）
      if (item.streaming && Boolean(trimmed)) {
        if (!FINAL_SUMMARY_STRUCTURE_RE.test(trimmed)) {
          const hasToolBeforeContent = allTurnActivities.some(
            (activity) => activity.startedAt > 0 && activity.startedAt <= contentStart,
          );
          if (!hasToolBeforeContent && plansConcreteTool(item.reasoning)) {
            return true;
          }
          if (
            allTurnActivities.length > 0 &&
            (PROCESS_PREAMBLE_LEAD_RE.test(hintText) || INTERMEDIATE_ACTION_HINT_RE.test(hintText))
          ) {
            return true;
          }
        }
      }

      return false;
    };

    const processFlags = turnMessages.map((item, msgIdx) => isItemProcessMessage(item, msgIdx));
    const isExternalAnswer = (msgIdx: number): boolean =>
      Boolean(turnMessages[msgIdx]?.content.trim()) && !processFlags[msgIdx];

    // 尚未判定归属的流式短前缀（或尚带过程引导语且未达 140 字门限的流式文本）先在 pendingMessageIds 暂缓外显，
    // 防止在正文区与时间线之间先闪现再缩回的跳动。
    for (let msgIdx = 0; msgIdx < turnMessages.length; msgIdx += 1) {
      const item = turnMessages[msgIdx]!;
      const trimmed = item.content.trim();
      if (!item.streaming || !trimmed || processFlags[msgIdx]) continue;
      if (hasStructuredExternalMarkdown(trimmed) || FINAL_SUMMARY_STRUCTURE_RE.test(trimmed)) {
        continue;
      }
      if (isProcessOpeningText(trimmed) && trimmed.length < 140) {
        pendingMessageIds.add(item.id);
        continue;
      }
      const threshold = turnActivities.length > 0 ? PENDING_TEXT_THRESHOLD_AFTER_TOOLS : PENDING_TEXT_THRESHOLD;
      if (trimmed.length < threshold) {
        pendingMessageIds.add(item.id);
      }
    }

    // 方案 A：按「非过程外部回答」将本轮自然切分为有序分段
    const segments: TurnSegment[] = [];
    let lastExternalIdx = -1;
    for (let msgIdx = 0; msgIdx < turnMessages.length; msgIdx += 1) {
      if (isExternalAnswer(msgIdx)) lastExternalIdx = msgIdx;
    }

    let segStart = 0;
    for (let msgIdx = 0; msgIdx < turnMessages.length; msgIdx += 1) {
      if (!isExternalAnswer(msgIdx)) continue;
      const answerMsg = turnMessages[msgIdx]!;
      let segEnd = msgIdx;
      if (msgIdx === lastExternalIdx && msgIdx < turnMessages.length - 1) {
        // 兼容外部回答结束后紧邻一个空内容补充推理节点的场景（不额外拆出第二条无正文时间线）
        const hasTailContent = turnMessages.slice(msgIdx + 1).some((m) => Boolean(m.content.trim()));
        const postBoundaryTime = answerMsg.contentStartedAt ?? answerMsg.createdAt ?? 0;
        const hasTailActivity =
          postBoundaryTime > 0 &&
          turnActivities.some((activity) => activity.startedAt >= postBoundaryTime);
        if (!hasTailContent && !hasTailActivity) {
          segEnd = turnMessages.length - 1;
        }
      }
      segments.push({
        startIdx: segStart,
        endIdx: segEnd,
        host: turnMessages[segStart]!,
        answerMessage: answerMsg,
        activities: [],
        trailingActivities: [],
        fileActivities: [],
      });
      segStart = segEnd + 1;
      msgIdx = segEnd;
    }
    if (segStart < turnMessages.length) {
      segments.push({
        startIdx: segStart,
        endIdx: turnMessages.length - 1,
        host: turnMessages[segStart]!,
        answerMessage: null,
        activities: [],
        trailingActivities: [],
        fileActivities: [],
      });
    }

    const segmentStartAnchor = (seg: TurnSegment): number | undefined => {
      for (let idx2 = seg.startIdx; idx2 <= seg.endIdx; idx2 += 1) {
        const msg = turnMessages[idx2]!;
        const anchor = msg.reasoningStartedAt ?? msg.contentStartedAt ?? msg.createdAt;
        if (typeof anchor === "number" && anchor > 0) return anchor;
      }
      return undefined;
    };

    const pickSegmentForActivity = (activity: Activity): { segIdx: number; trailing: boolean } => {
      for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
        const seg = segments[segIdx]!;
        const answer = seg.answerMessage;
        if (!answer) {
          return { segIdx, trailing: false };
        }
        const nextSeg = segments[segIdx + 1];
        if (nextSeg) {
          const splitAt =
            answer.contentStartedAt !== undefined
              ? answer.contentStartedAt
              : (segmentStartAnchor(nextSeg) ?? answer.createdAt ?? 0);
          if (splitAt <= 0 || activity.startedAt < splitAt) {
            return { segIdx, trailing: false };
          }
          continue;
        }
        // 最后一个已有实质回答的分段：仅当其拥有明确的 contentStartedAt，
        // 且工具明显发起于该回答输出之后时，挂在回答下方避免时序倒挂。
        if (
          answer.contentStartedAt !== undefined &&
          answer.contentStartedAt > 0 &&
          activity.startedAt >= answer.contentStartedAt &&
          !canDemoteAssistantToProcess(answer)
        ) {
          return { segIdx, trailing: true };
        }
        return { segIdx, trailing: false };
      }
      return { segIdx: Math.max(0, segments.length - 1), trailing: false };
    };

    for (const activity of turnActivities) {
      const { segIdx, trailing } = pickSegmentForActivity(activity);
      const targetSeg = segments[segIdx];
      if (!targetSeg) continue;
      if (trailing) targetSeg.trailingActivities.push(activity);
      else targetSeg.activities.push(activity);
    }

    // 轮次文件 Diff 隔离：提取属于本轮的文件修改活动，按分段挂到对应的实质回答或宿主上
    const turnFileActivities = activities.filter((activity) => {
      if (activity.kind !== "file") return false;
      if (activity.runId && runIds.size > 0) {
        if (!runIds.has(activity.runId)) return false;
      } else {
        if (turnStartTime > 0 && activity.startedAt > 0 && activity.startedAt < turnStartTime) return false;
        if (nextTurnTime !== undefined && activity.startedAt >= nextTurnTime) return false;
      }
      return true;
    });
    for (const fileActivity of turnFileActivities) {
      const { segIdx } = pickSegmentForActivity(fileActivity);
      segments[segIdx]?.fileActivities.push(fileActivity);
    }

    const isMultiSegmentTurn =
      segments.length > 1 || segments.some((seg) => seg.trailingActivities.length > 0);
    const activeSegmentIndex = segments.length - 1;

    for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
      const seg = segments[segIdx]!;
      const segHost = seg.host;
      const isLastSegment = segIdx === activeSegmentIndex;
      const hasTrailingAfterLastAnswer = isLastSegment && seg.trailingActivities.length > 0;

      if (isLastSegment && !hasTrailingAfterLastAnswer) {
        turnHostIds.add(segHost.id);
      }
      if (isLastSegment && (!seg.answerMessage || seg.answerMessage.streaming)) {
        activeHostIds.add(segHost.id);
      }
      if (isMultiSegmentTurn) {
        multiSegmentHostIds.add(segHost.id);
      }

      if (seg.answerMessage && seg.answerMessage.content.trim()) {
        answerByHost.set(segHost.id, {
          streaming: seg.answerMessage.streaming,
          complete: !seg.answerMessage.streaming,
        });
      }

      const segItems: ProcessTimelineItem[] = [];
      let segHasTimelineTrigger = seg.activities.length > 0;
      for (let msgIdx = seg.startIdx; msgIdx <= seg.endIdx; msgIdx += 1) {
        const item = turnMessages[msgIdx]!;
        const createdAt = item.createdAt ?? 0;
        const isProcess = processFlags[msgIdx] ?? false;
        if (item.reasoning) {
          segHasTimelineTrigger = true;
          segItems.push({
            id: `reasoning:${item.id}`,
            kind: "assistant",
            label: item.reasoningStreaming ? "正在思考" : "思考",
            content: item.reasoning,
            startedAt: item.reasoningStartedAt ?? createdAt,
            streaming: item.reasoningStreaming,
            reasoningDuration: item.reasoningDuration,
            section: "reasoning",
          });
        }
        if (isProcess) {
          segHasTimelineTrigger = true;
          if (item.content.trim()) {
            segItems.push({
              id: `message:${item.id}`,
              kind: "assistant",
              label: item.streaming ? "正在整理过程" : "过程摘要",
              content: item.content,
              startedAt: item.contentStartedAt ?? createdAt,
              streaming: item.streaming,
            });
          }
        }
        // 防御锁：非外部实质正文（空占位、过程说明）交由时间线接管；
        // 外部实质回答绝不放进 ownedMessageIds，保证稳定渲染在 Markdown 正文区。
        if (!item.content.trim() || isProcess) {
          ownedMessageIds.add(item.id);
        }
      }

      if (segHasTimelineTrigger) {
        for (const activity of seg.activities) {
          segItems.push({ id: activity.id, kind: "activity", activity });
        }
        segItems.sort(compareTimelineItems);
        byFinalMessage.set(segHost.id, segItems);
      }

      if (seg.trailingActivities.length > 0 && seg.answerMessage) {
        const trailingItems = seg.trailingActivities
          .map((activity): ProcessTimelineItem => ({ id: activity.id, kind: "activity", activity }))
          .sort(compareTimelineItems);
        trailingByMessage.set(seg.answerMessage.id, trailingItems);
      }

      // 统计本分段的有效时间戳跨度
      const segValidStarts: number[] = [];
      const segValidEnds: number[] = [];
      for (const item of segItems) {
        if (item.kind === "assistant") {
          if (item.startedAt >= 1_000_000_000_000) {
            segValidStarts.push(item.startedAt);
            if (typeof item.reasoningDuration === "number" && item.reasoningDuration > 0) {
              segValidEnds.push(item.startedAt + item.reasoningDuration * 1000);
            }
          }
        } else {
          if (item.activity.startedAt >= 1_000_000_000_000) {
            segValidStarts.push(item.activity.startedAt);
          }
          if (item.activity.endedAt && item.activity.endedAt >= 1_000_000_000_000) {
            segValidEnds.push(item.activity.endedAt);
          }
        }
      }
      if (
        seg.answerMessage?.contentStartedAt &&
        seg.answerMessage.contentStartedAt >= 1_000_000_000_000 &&
        seg.activities.length > 0
      ) {
        segValidEnds.push(seg.answerMessage.contentStartedAt);
      }
      if (
        isLastSegment &&
        seg.answerMessage?.runEndedAt &&
        seg.answerMessage.runEndedAt >= 1_000_000_000_000
      ) {
        segValidEnds.push(seg.answerMessage.runEndedAt);
      }
      if (segIdx > 0 && segValidStarts.length > 0) {
        segmentStartedAtByHost.set(segHost.id, Math.min(...segValidStarts));
      }

      if (!isMultiSegmentTurn) {
        if (turnDuration !== undefined) {
          durationByHost.set(segHost.id, turnDuration);
        }
      } else {
        const segHasStreamingItem = segItems.some((item) =>
          item.kind === "assistant"
            ? Boolean(item.streaming)
            : item.activity.status === "running" ||
              item.activity.status === "pending" ||
              item.activity.status === "waiting_approval",
        );
        const segSettled =
          Boolean(seg.answerMessage && !seg.answerMessage.streaming) ||
          !isLastSegment ||
          turnDuration !== undefined;
        segmentCompletedByHost.set(segHost.id, segSettled && !segHasStreamingItem);
        if (segSettled && !segHasStreamingItem && segValidStarts.length > 0 && segValidEnds.length > 0) {
          const span = Math.max(...segValidEnds) - Math.min(...segValidStarts);
          if (span >= -60_000 && span <= 3_600_000) {
            durationByHost.set(segHost.id, Math.max(1000, span));
          }
        }
      }

      const segFileChanges = parseFileChangesFromActivities(seg.fileActivities);
      if (segFileChanges.length > 0) {
        const targetDiffMsgId =
          seg.answerMessage && !ownedMessageIds.has(seg.answerMessage.id)
            ? seg.answerMessage.id
            : segHost.id;
        diffByMessageId.set(targetDiffMsgId, segFileChanges);
      }
    }
  }

  return {
    byFinalMessage,
    trailingByMessage,
    ownedMessageIds,
    turnHostIds,
    activeHostIds,
    pendingMessageIds,
    answerByHost,
    durationByHost,
    segmentStartedAtByHost,
    segmentCompletedByHost,
    multiSegmentHostIds,
    diffByMessageId,
  };
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

/** 格式化回合完整日期时间（例如：2026年10月28日 10:12） */
function formatTurnDateTime(createdAt?: number): string {
  if (!createdAt || typeof createdAt !== "number" || Number.isNaN(createdAt) || createdAt <= 0) {
    return "";
  }
  const d = new Date(createdAt);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}年${month}月${day}日 ${hours}:${minutes}`;
}

/** 清理 Markdown 语法符号，生成干净自然的回合回复摘要文本 */
function cleanMarkdownForTurnPreview(text: string): string {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[ \t]*[-*+>][ \t]+/gm, "")
    .replace(/:?-{2,}:?/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 流式 Markdown 渲染节流间隔（ms）：
 * `Streamdown` 在 `mode="static"` 下每次文本变更都会重跑完整 Markdown 解析并在 `useEffect` 内调用 `setBlocks(parsedBlocks)`；
 * 若按 `REVEAL_MS=18ms` 连续推送而单次渲染耗时超过 18ms，`setBlocks` 会在尚未独立提交前被下一拍覆写，
 * 导致 React 19 `nestedPassiveUpdateCount` 连续累加至 > 50 触发 `Maximum update depth exceeded`。
 * 提交后留出 >=140ms 静默窗口，可让 `Streamdown` 稳定完成空副作用周期并将计数清零；非流式态立即全量直通渲染。
 */
const STREAM_MARKDOWN_FLUSH_MS = 140;

function StreamingMessageResponse({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const [displayedContent, setDisplayedContent] = useState(() => content);
  const latestContentRef = useRef(content);
  latestContentRef.current = content;
  const lastCommittedAtRef = useRef<number>(
    typeof performance !== "undefined" ? performance.now() : Date.now(),
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    lastCommittedAtRef.current =
      typeof performance !== "undefined" ? performance.now() : Date.now();
  }, [displayedContent]);

  useEffect(() => {
    if (!streaming || content.length < displayedContent.length) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (content === displayedContent || timerRef.current !== null) return;

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const waitMs = Math.max(16, STREAM_MARKDOWN_FLUSH_MS - (now - lastCommittedAtRef.current));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setDisplayedContent(latestContentRef.current);
    }, waitMs);
  }, [content, displayedContent, streaming]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const effectiveContent =
    !streaming || content.length < displayedContent.length ? content : displayedContent;

  return (
    <MessageResponse mode="static" isAnimating={streaming}>
      {effectiveContent}
    </MessageResponse>
  );
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
    trailingByMessage,
    ownedMessageIds: timelineOwnedMessageIds,
    turnHostIds,
    activeHostIds,
    pendingMessageIds,
    answerByHost,
    durationByHost,
    segmentStartedAtByHost,
    segmentCompletedByHost,
    multiSegmentHostIds,
    diffByMessageId,
  } = timelineView;

  // 用户消息原地编辑状态
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [editingAttachments, setEditingAttachments] = useState<ChatAttachment[]>([]);

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

  // StickToBottom 上下文：给回合导航条提供真实滚动元素与解除粘底的能力
  const stickContextRef = useRef<StickToBottomContext | null>(null);
  const getScrollElement = useCallback(() => stickContextRef.current?.scrollRef.current ?? null, []);
  const stopStickyScroll = useCallback(() => stickContextRef.current?.stopScroll(), []);

  // 左侧回合导航条的数据：每个用户消息开启一个回合，同时聚合本轮助手回复摘要与完整日期时间
  const turns = useMemo<ConversationTurn[]>(() => {
    const result: ConversationTurn[] = [];
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (!msg || msg.role !== "user") continue;

      const promptLine =
        msg.content
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.trim() ?? "(图片或文件消息)";

      const turnAssistantMessages: ChatMessage[] = [];
      for (let j = i + 1; j < messages.length; j += 1) {
        const nextMsg = messages[j];
        if (!nextMsg) continue;
        if (nextMsg.role === "user") break;
        if (nextMsg.role === "assistant") {
          turnAssistantMessages.push(nextMsg);
        }
      }

      const finalAssistant =
        [...turnAssistantMessages]
          .reverse()
          .find((m) => !timelineOwnedMessageIds.has(m.id) && m.content.trim().length > 0) ??
        [...turnAssistantMessages]
          .reverse()
          .find((m) => m.content.trim().length > 0);

      let rawReply = finalAssistant?.content ?? "";
      if (!rawReply.trim()) {
        const anyReasoning = [...turnAssistantMessages]
          .reverse()
          .find((m) => Boolean(m.reasoning && m.reasoning.trim().length > 0));
        if (anyReasoning?.reasoning) {
          rawReply = anyReasoning.reasoning;
        } else if (turnAssistantMessages.some((m) => m.streaming || m.reasoningStreaming)) {
          rawReply = "正在思考与生成回复中...";
        }
      }

      result.push({
        id: msg.id,
        time: formatMessageTime(msg.createdAt),
        dateTime: formatTurnDateTime(msg.createdAt),
        prompt: promptLine,
        replyPreview: cleanMarkdownForTurnPreview(rawReply),
      });
    }
    return result;
  }, [messages, timelineOwnedMessageIds]);

  return (
    <div className="relative flex min-h-0 flex-1 @container overflow-x-hidden">
      <Conversation contextRef={stickContextRef} className="min-h-0 flex-1 bg-black overflow-x-hidden">
      <ConversationContent className="mx-auto w-full max-w-3xl px-0 py-8" scrollClassName="overflow-x-hidden">
        {messages.length === 0 ? (
          /* 空状态引导区 */
          <div className="-my-8 flex min-h-full flex-col items-center justify-center text-center">
            <BloubBot size={88} />
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
                  <h2 className="mb-1 text-xl font-semibold text-zinc-100 tracking-tight">
                    {greetingTitle}
                  </h2>
                  <p className="mb-2 max-w-md text-[13.5px] text-zinc-400">
                    {greetingDesc}
                  </p>
                </>
              );
            })()}

            <div className="grid w-full max-w-2xl grid-cols-1 gap-1 text-left sm:grid-cols-2">
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
                  className="group flex flex-col justify-between gap-1 rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-2 text-left transition-all hover:border-zinc-700 hover:bg-zinc-900/90 hover:shadow-md cursor-pointer"
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
                  <div key={message.id} data-message-id={message.id} className="group/user flex flex-col items-end w-full">
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
                          {/* 重新发送按钮：复用底部发送按钮同一渲染路径（InputGroupButton + chat-submit-btn），形状配色图标深浅色完全一致（图标同底部为 ArrowUp） */}
                          <InputGroupButton
                            type="button"
                            variant="default"
                            size="icon-sm"
                            onClick={() => handleSaveEdit(message.id)}
                            disabled={!editingContent.trim()}
                            className="chat-submit-btn size-8 rounded-full transition-colors shadow-none"
                            title="重新发送 (Enter)"
                          >
                            <ArrowUpIcon className="size-4" />
                          </InputGroupButton>
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
              const trailingProcessItems = trailingByMessage.get(message.id) ?? [];
              const messageIsInTimeline = timelineOwnedMessageIds.has(message.id);
              const runIsLive = runSnapshot?.status === "connecting"
                || runSnapshot?.status === "running"
                || runSnapshot?.status === "waiting_approval";
              const hasLaterUserMessage = messages.slice(idx + 1).some((item) => item.role === "user");
              const isLatestTurn = !hasLaterUserMessage;
              // 空的「正在分析」只出现在本轮当前活跃分段宿主上，避免前面已完成回答或后续节点重复占位。
              const showLivePlaceholder = processItems.length === 0
                && trailingProcessItems.length === 0
                && turnHostIds.has(message.id)
                && isLatestTurn
                && runIsLive
                && (!message.runId || message.runId === runSnapshot?.runId);
              if (
                messageIsInTimeline &&
                processItems.length === 0 &&
                trailingProcessItems.length === 0 &&
                !showLivePlaceholder
              ) {
                return null;
              }
              // 思考还在增量到达时先不画正文，避免两段抢同一条消息。
              // 已被时间线收下的说明（或尚未越过稳定门限的流式短前缀）不在外面画 Markdown。
              const isReasoningStreaming = message.reasoningStreaming === true;
              const hasSubstantialContent = Boolean(message.content && message.content.trim().length > 0);
              const isPendingText = pendingMessageIds.has(message.id);
              // 外部正文展示防跳动规则：
              // 1. 绝对不能在时间线内（非过程消息）
              // 2. 思考不能正在流式输出
              // 3. 尚未越过长度/结构稳定门限的流式短前缀暂缓外显，防止刚冒头又退回时间线
              // 4. 必须已有实质内容，禁止在空内容或思考刚结束时抢跑弹出外漏
              const shouldShowMessageContent =
                !messageIsInTimeline &&
                !isReasoningStreaming &&
                !isPendingText &&
                hasSubstantialContent;
              const turnAnswer = answerByHost.get(message.id);
              const isMultiSegmentHost = multiSegmentHostIds.has(message.id);
              const isActiveSegmentHost = activeHostIds.has(message.id);
              const hostDurationMs =
                durationByHost.get(message.id) ??
                (!isMultiSegmentHost ? message.runDurationMs : undefined);
              const effectiveDurationMs =
                hostDurationMs ??
                (!isMultiSegmentHost && message.runId === runSnapshot?.runId ? runSnapshot?.durationMs : undefined);
              const effectiveStartedAt =
                segmentStartedAtByHost.get(message.id) ?? runSnapshot?.startedAt;
              const hostRunCompleted = isMultiSegmentHost
                ? (segmentCompletedByHost.get(message.id) ??
                  (message.runId === runSnapshot?.runId ? runSnapshot?.status === "completed" : true))
                : (message.runId === runSnapshot?.runId
                    ? runSnapshot?.status === "completed"
                    : hostDurationMs !== undefined);
              const turnFileChanges = diffByMessageId.get(message.id) ?? [];
              const hasDiffSection = turnFileChanges.length > 0;

              const hasProcessSection = Boolean(processItems.length > 0 || showLivePlaceholder);
              const hasTrailingProcessSection = trailingProcessItems.length > 0;
              const hasApprovalSection = Boolean(isLast && approvals.length > 0);
              // 如果既没有过程时间线，也没有正文内容，也没有审批卡片，也没有文件 Diff 变更卡片，整块直接跳过，避免留出多余空容器
              if (!hasProcessSection && !shouldShowMessageContent && !hasTrailingProcessSection && !hasApprovalSection && !hasDiffSection) {
                return null;
              }

              const trailingValidStarts = trailingProcessItems
                .map((item) => (item.kind === "assistant" ? item.startedAt : item.activity.startedAt))
                .filter((t): t is number => typeof t === "number" && t >= 1_000_000_000_000);
              const trailingStartedAt =
                trailingValidStarts.length > 0 ? Math.min(...trailingValidStarts) : undefined;
              const trailingHasRunning = trailingProcessItems.some((item) =>
                item.kind === "assistant"
                  ? Boolean(item.streaming)
                  : item.activity.status === "running" ||
                    item.activity.status === "pending" ||
                    item.activity.status === "waiting_approval",
              );
              const trailingValidEnds = trailingProcessItems
                .map((item) => (item.kind === "assistant" ? undefined : item.activity.endedAt))
                .filter((t): t is number => typeof t === "number" && t >= 1_000_000_000_000);
              if (!trailingHasRunning && message.runEndedAt && message.runEndedAt >= 1_000_000_000_000) {
                trailingValidEnds.push(message.runEndedAt);
              }
              const trailingSpan =
                !trailingHasRunning &&
                trailingStartedAt !== undefined &&
                trailingValidEnds.length > 0
                  ? Math.max(...trailingValidEnds) - trailingStartedAt
                  : undefined;
              const trailingDurationMs =
                trailingSpan !== undefined && trailingSpan >= -60_000 && trailingSpan <= 3_600_000
                  ? Math.max(1000, trailingSpan)
                  : undefined;
              const trailingIsActive = Boolean(
                runIsLive &&
                  isLatestTurn &&
                  (!message.runId || !runSnapshot?.runId || message.runId === runSnapshot.runId),
              );
              const trailingRunCompleted =
                message.runId === runSnapshot?.runId
                  ? runSnapshot?.status === "completed"
                  : !trailingIsActive;

              return (
                <div key={message.id} data-message-id={message.id} className="flex flex-col w-full text-zinc-100 space-y-3">
                  {/* 前置过程时间线：常规轮次固定在分段首条助手消息上方。 */}
                  {hasProcessSection && (
                  <ProcessActivityGroup
                    key={message.id}
                    items={processItems}
                    isActive={
                      showLivePlaceholder ||
                      (runIsLive &&
                        processItems.length > 0 &&
                        isLatestTurn &&
                        (!isMultiSegmentHost || isActiveSegmentHost))
                    }
                    startedAt={effectiveStartedAt}
                    finalAnswerComplete={turnAnswer?.complete ?? false}
                    finalAnswerStreaming={turnAnswer?.streaming ?? false}
                    durationMs={effectiveDurationMs}
                    runCompleted={hostRunCompleted}
                  />
                  )}

                  {/* 4. 人工安全审批卡片（前置阶段） */}
                  {hasApprovalSection && !hasTrailingProcessSection &&
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
                            <StreamingMessageResponse
                              key={message.id}
                              content={message.content}
                              streaming={Boolean(message.streaming)}
                            />
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

                  {/* 方案 A 后置时间线：若实质外部回答结束后直接跟了工具调用，时间线自然挂在其下方 */}
                  {hasTrailingProcessSection && (
                    <ProcessActivityGroup
                      key={`trailing:${message.id}`}
                      items={trailingProcessItems}
                      isActive={trailingIsActive}
                      startedAt={trailingStartedAt}
                      finalAnswerComplete={false}
                      finalAnswerStreaming={false}
                      durationMs={trailingDurationMs}
                      runCompleted={trailingRunCompleted}
                    />
                  )}

                  {/* 4b. 人工安全审批卡片（后置工具触发场景） */}
                  {hasApprovalSection && hasTrailingProcessSection &&
                    approvals.map((activity) => (
                      <div key={activity.id} className="w-full my-1">
                        <ApprovalCard
                          activity={activity}
                          decision={decisionFor(decisions, activity)}
                          onDecide={onDecide}
                        />
                      </div>
                    ))}

                  {/* 6. 文件变更 Diff 汇总卡片：严格归属于本轮产生修改的助手回答，绝不外漏到后续对话 */}
                  {hasDiffSection && (
                    <DiffCard changes={turnFileChanges} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
      <ImagePreviewDialog file={previewAttachment} onOpenChange={(open) => { if (!open) setPreviewAttachment(null); }} />
      </Conversation>
      <ConversationTurnNavigator
        turns={turns}
        getScrollElement={getScrollElement}
        stopScroll={stopStickyScroll}
      />
    </div>
  );
}
