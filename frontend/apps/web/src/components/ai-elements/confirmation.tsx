"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Alert, AlertDescription } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { cn } from "../../lib/utils.js";

export type ToolApprovalState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-denied"
  | "output-available";

export interface ToolApprovalInfo {
  id: string;
  approved?: boolean;
  reason?: string;
}

interface ConfirmationContextValue {
  approval?: ToolApprovalInfo;
  state: ToolApprovalState;
}

const ConfirmationContext = createContext<ConfirmationContextValue | null>(null);

export const useConfirmation = () => {
  const context = useContext(ConfirmationContext);
  if (!context) {
    throw new Error("useConfirmation must be used within a Confirmation");
  }
  return context;
};

export type ConfirmationProps = ComponentProps<typeof Alert> & {
  approval?: ToolApprovalInfo;
  state: ToolApprovalState;
};

export const Confirmation = ({
  className,
  approval,
  state,
  children,
  ...props
}: ConfirmationProps) => {
  const contextValue = useMemo(
    () => ({ approval, state }),
    [approval, state]
  );

  if (!approval || state === "input-streaming" || state === "input-available") {
    return null;
  }

  return (
    <ConfirmationContext.Provider value={contextValue}>
      <Alert
        data-slot="confirmation"
        className={cn("flex flex-col gap-2 rounded-lg border p-4 text-sm bg-card text-card-foreground shadow-xs my-2", className)}
        {...props}
      >
        {children}
      </Alert>
    </ConfirmationContext.Provider>
  );
};

export type ConfirmationTitleProps = ComponentProps<typeof AlertDescription>;

export const ConfirmationTitle = ({
  className,
  ...props
}: ConfirmationTitleProps) => (
  <AlertDescription className={cn("inline font-medium text-foreground", className)} {...props} />
);

export interface ConfirmationRequestProps {
  children?: ReactNode;
}

export const ConfirmationRequest = ({ children }: ConfirmationRequestProps) => {
  const { state } = useConfirmation();

  if (state !== "approval-requested") {
    return null;
  }

  return <div className="text-muted-foreground text-sm leading-relaxed">{children}</div>;
};

export interface ConfirmationAcceptedProps {
  children?: ReactNode;
}

export const ConfirmationAccepted = ({
  children,
}: ConfirmationAcceptedProps) => {
  const { approval, state } = useConfirmation();

  if (
    !approval?.approved ||
    (state !== "approval-responded" &&
      state !== "output-denied" &&
      state !== "output-available")
  ) {
    return null;
  }

  return <div className="flex items-center gap-2 text-sm text-foreground font-medium">{children}</div>;
};

export interface ConfirmationRejectedProps {
  children?: ReactNode;
}

export const ConfirmationRejected = ({
  children,
}: ConfirmationRejectedProps) => {
  const { approval, state } = useConfirmation();

  if (
    approval?.approved !== false ||
    (state !== "approval-responded" &&
      state !== "output-denied" &&
      state !== "output-available")
  ) {
    return null;
  }

  return <div className="flex items-center gap-2 text-sm text-muted-foreground font-medium">{children}</div>;
};

export type ConfirmationActionsProps = ComponentProps<"div">;

export const ConfirmationActions = ({
  className,
  ...props
}: ConfirmationActionsProps) => {
  const { state } = useConfirmation();

  if (state !== "approval-requested") {
    return null;
  }

  return (
    <div
      className={cn("flex items-center justify-end gap-2 self-end mt-1", className)}
      {...props}
    />
  );
};

export type ConfirmationActionProps = ComponentProps<typeof Button>;

export const ConfirmationAction = (props: ConfirmationActionProps) => (
  <Button className="h-8 px-3 text-sm font-medium" type="button" {...props} />
);
