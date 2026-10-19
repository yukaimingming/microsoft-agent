/**
 * Web 预览全局事件通道。
 * 用于在聊天工具调用（如网络搜索来源）与右侧 ReviewSidebar 之间进行解耦通信。
 */

export const OPEN_WEB_PREVIEW_EVENT = "deepagent:open-web-preview";

export interface OpenWebPreviewDetail {
  url: string;
  title?: string;
}

/**
 * 触发在右侧 Webview 中展开预览指定 URL。
 */
export function openInWebPreview(url: string, title?: string) {
  if (typeof window === "undefined") return;
  const trimmed = url.trim();
  if (!trimmed) return;
  window.dispatchEvent(
    new CustomEvent<OpenWebPreviewDetail>(OPEN_WEB_PREVIEW_EVENT, {
      detail: { url: trimmed, title },
    })
  );
}
