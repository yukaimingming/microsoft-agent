/**
 * AG-UI 自定义事件名称常量。
 *
 * Deep Agents 的内部事件无法一一映射到 AG-UI 标准事件，
 * 这里用 `CUSTOM` 事件承载扩展状态，事件名集中定义避免拼写漂移。
 */
export const AGUI_CUSTOM_EVENT = {
  /** 活动时间线增量（卡片创建/更新）。 */
  ACTIVITY_DELTA: "deepagent:activity",
  /** 运行状态快照（状态、进度摘要、待审批中断）。 */
  RUN_SNAPSHOT: "deepagent:run-snapshot",
  /** 标记某条文本消息属于伴随工具调用的中间过程说明（在时间线内部按序流式输出）。 */
  PROCESS_MESSAGE: "deepagent:process-message",
  /** 模型列表获取失败等原因的提示。 */
  NOTICE: "deepagent:notice",
} as const;

export type AguiCustomEventName = (typeof AGUI_CUSTOM_EVENT)[keyof typeof AGUI_CUSTOM_EVENT];
