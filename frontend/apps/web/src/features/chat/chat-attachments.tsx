import type { FileUIPart } from "ai";
import { Attachment, AttachmentPreview, AttachmentRemove, Attachments } from "../../components/ai-elements/attachments.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "../../components/ui/dialog.js";

export type ChatAttachment = FileUIPart & { id: string };

interface ChatAttachmentGalleryProps {
  files: ChatAttachment[];
  onPreview?: (file: ChatAttachment) => void;
  onRemove?: (id: string) => void;
}

export function ChatAttachmentGallery({ files, onPreview, onRemove }: ChatAttachmentGalleryProps) {
  if (files.length === 0) return null;

  return (
    <Attachments variant="grid" className="!ml-0 justify-end">
      {files.map((file) => {
        const isImage = file.mediaType.startsWith("image/");
        return (
          <Attachment
            key={file.id}
            data={file}
            onRemove={onRemove ? () => onRemove(file.id) : undefined}
            className="border border-zinc-700/70 bg-zinc-900"
          >
            <button
              type="button"
              aria-label={isImage ? `放大预览：${file.filename ?? "图片"}` : undefined}
              disabled={!isImage || !onPreview}
              onClick={() => onPreview?.(file)}
              className="relative size-full overflow-hidden disabled:cursor-default"
            >
              <AttachmentPreview />
              {file.filename && (
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-1.5 py-1 text-left text-[10px] text-white">
                  {file.filename}
                </span>
              )}
            </button>
            {onRemove && <AttachmentRemove label="移除附件" />}
          </Attachment>
        );
      })}
    </Attachments>
  );
}

interface ImagePreviewDialogProps {
  file: ChatAttachment | null;
  onOpenChange: (open: boolean) => void;
}

export function ImagePreviewDialog({ file, onOpenChange }: ImagePreviewDialogProps) {
  return (
    <Dialog open={file !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] border-zinc-700 bg-zinc-950 p-3 sm:max-w-5xl">
        <DialogTitle className="sr-only">图片预览：{file?.filename ?? "附件图片"}</DialogTitle>
        {file && (
          <img
            src={file.url}
            alt={file.filename ?? "用户上传的图片"}
            className="mx-auto max-h-[85vh] max-w-full rounded-md object-contain"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
