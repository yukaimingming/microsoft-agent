/** 模态弹窗容器：Esc 关闭、点击遮罩关闭、焦点圈在弹窗内。 */

import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: "md" | "lg";
}

export function Modal({ open, onClose, title, children, width = "lg" }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    // 打开时把焦点移入弹窗，避免键盘用户留在背景页。
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        // 只在点击遮罩本身时关闭。
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`my-8 w-full ${width === "lg" ? "max-w-3xl" : "max-w-xl"} rounded-xl border border-zinc-800 bg-[#09090b] shadow-2xl outline-none text-zinc-100 modal-panel`}
      >
        <header className="flex items-center justify-between border-b border-zinc-800/80 px-5 py-3.5 modal-header">
          <h2 className="text-[14px] font-semibold text-zinc-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded px-2 py-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
