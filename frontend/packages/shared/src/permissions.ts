/** 聊天运行期间应用的权限审批策略。 */
export const PERMISSION_MODES = ["ask", "auto", "full"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** 未指定或无效模式时使用最严格的审批策略。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";
