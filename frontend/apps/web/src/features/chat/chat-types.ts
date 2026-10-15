/** 聊天功能共用的类型（从 client-reducer 再导出，避免循环依赖）。 */

export type { ChatMessage, ClientState, PendingDecision } from "./client-reducer.js";
export type { Activity } from "@deepagent/shared";
