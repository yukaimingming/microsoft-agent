import { useState } from "react";
import { safeStringify, type Activity, type ApprovalDetail } from "@deepagent/shared";
import { CheckIcon, XIcon, ChevronDownIcon } from "lucide-react";
import {
  Confirmation,
  ConfirmationRequest,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationActions,
  ConfirmationAction,
  type ToolApprovalState,
} from "../../components/ai-elements/confirmation.js";
import { CodeBlock } from "../../components/ai-elements/code-block.js";
import { cn } from "../../lib/utils.js";

export function ApprovalCard({
  activity,
  onDecide,
  decision,
}: {
  activity: Activity;
  onDecide?: (activityId: string, decision: "approve" | "reject") => void;
  decision?: "approve" | "reject";
}) {
  const detail = activity.detail as ApprovalDetail | undefined;
  const args = safeStringify(detail?.args);
  const disabled = onDecide === undefined;
  const [isExpanded, setIsExpanded] = useState(false);

  const toolName = detail?.toolName ?? activity.title;

  // 根据当前是否有决策映射为官方定义的 approval 和 state
  const approvalState: ToolApprovalState = decision
    ? decision === "approve"
      ? "approval-responded"
      : "output-denied"
    : "approval-requested";

  const approvalInfo = {
    id: activity.id,
    approved: decision ? decision === "approve" : undefined,
  };

  return (
    <Confirmation approval={approvalInfo} state={approvalState} className="my-2.5">
      <ConfirmationRequest>
        <div className="flex flex-col gap-1.5">
          <div className="text-foreground text-sm font-medium">
            此工具请求执行敏感操作：<code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">{toolName}</code>
          </div>
          {detail?.impact ? (
            <div className="text-muted-foreground text-xs leading-relaxed">
              {detail.impact}
            </div>
          ) : null}
          {args.text ? (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <span>{isExpanded ? "收起参数" : "查看调用参数"}</span>
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", isExpanded ? "rotate-180" : "rotate-0")}
                />
              </button>
              {isExpanded && (
                <div className="mt-1.5 max-h-48 overflow-auto rounded border border-border">
                  <CodeBlock code={args.text} language="json" />
                </div>
              )}
            </div>
          ) : null}
        </div>
      </ConfirmationRequest>

      <ConfirmationAccepted>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <CheckIcon className="size-4 text-emerald-500 shrink-0" />
            <span className="font-medium text-sm">
              已批准执行：<code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">{toolName}</code>
            </span>
          </div>
          {args.text && (
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors ml-2"
            >
              <span>{isExpanded ? "收起" : "参数"}</span>
              <ChevronDownIcon className={cn("size-3 transition-transform", isExpanded ? "rotate-180" : "rotate-0")} />
            </button>
          )}
        </div>
        {isExpanded && args.text && (
          <div className="mt-2 max-h-40 overflow-auto rounded border border-border w-full">
            <CodeBlock code={args.text} language="json" />
          </div>
        )}
      </ConfirmationAccepted>

      <ConfirmationRejected>
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <XIcon className="size-4 text-destructive shrink-0" />
            <span className="font-medium text-sm">
              已拒绝执行：<code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">{toolName}</code>
            </span>
          </div>
          {args.text && (
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors ml-2"
            >
              <span>{isExpanded ? "收起" : "参数"}</span>
              <ChevronDownIcon className={cn("size-3 transition-transform", isExpanded ? "rotate-180" : "rotate-0")} />
            </button>
          )}
        </div>
        {isExpanded && args.text && (
          <div className="mt-2 max-h-40 overflow-auto rounded border border-border w-full">
            <CodeBlock code={args.text} language="json" />
          </div>
        )}
      </ConfirmationRejected>

      <ConfirmationActions>
        <ConfirmationAction
          variant="outline"
          disabled={disabled}
          onClick={() => onDecide?.(activity.id, "reject")}
        >
          拒绝
        </ConfirmationAction>
        <ConfirmationAction
          variant="default"
          disabled={disabled}
          onClick={() => onDecide?.(activity.id, "approve")}
        >
          批准
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}
