/** 模态弹窗容器：基于 shadcn/ui Dialog 封装，统一语义令牌与双主题适配。 */

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "./ui/dialog.js";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: "md" | "lg";
}

export function Modal({ open, onClose, title, children, width = "lg" }: ModalProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton
        className={`top-[2.5rem] w-full translate-y-0 gap-0 overflow-hidden rounded-xl bg-card p-0 text-card-foreground shadow-2xl ${
          width === "lg" ? "sm:max-w-3xl" : "sm:max-w-xl"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <DialogTitle className="text-[14px] font-semibold">{title}</DialogTitle>
        </div>
        <div className="px-5 py-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
