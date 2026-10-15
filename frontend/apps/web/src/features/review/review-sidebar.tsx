import { useState } from "react";
import { ReviewPanel } from "./review-panel.js";
import { EmptyTabView } from "./empty-tab-view.js";
import { TerminalView } from "./terminal-view.js";
import { FileViewer } from "./file-viewer.js";
import {
  GitPullRequestIcon,
  PlusIcon,
  XIcon,
  PanelRightCloseIcon,
  Maximize2Icon,
  Minimize2Icon,
  TerminalIcon,
  FileCodeIcon,
  SearchIcon,
} from "lucide-react";

interface TabItem {
  id: string;
  title: string;
  type: "review" | "empty" | "terminal" | "file";
  filePath?: string;
}

interface ReviewSidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  workspaceRoot: string | null;
}

export function ReviewSidebar({ isOpen, onToggle, workspaceRoot }: ReviewSidebarProps) {
  // 默认初始为主面板（图 1 风格：居中搜索 + Review / Open File / Terminal 三个快捷卡片）
  const [tabs, setTabs] = useState<TabItem[]>([
    { id: "main-panel", title: "Search", type: "empty" },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>("main-panel");
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [width, setWidth] = useState(660);
  const [isResizing, setIsResizing] = useState(false);

  // 拖拽调节宽度
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = width;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = startX - moveEvent.clientX;
      const nextWidth = Math.max(380, Math.min(window.innerWidth - 300, startWidth + deltaX));
      setWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  /** 新增空标签（显示欢迎检索页） */
  const handleAddTab = () => {
    const newId = `tab-${Date.now()}`;
    setTabs((prev) => [...prev, { id: newId, title: "Search", type: "empty" }]);
    setActiveTabId(newId);
  };

  /**
   * 关闭标签：
   * 严格按照用户需求：当点击关闭只有这一个标签（如默认Review标签）时，直接收缩侧边栏并复位为主面板！
   */
  const handleCloseTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();

    // 关键需求：只有这一个默认标签时，直接收缩侧边栏，并重置为主面板供下次展开
    if (tabs.length <= 1) {
      onToggle();
      setTabs([{ id: "main-panel", title: "Search", type: "empty" }]);
      setActiveTabId("main-panel");
      return;
    }

    // 若有多个标签，正常关闭并切换到相邻标签
    const filtered = tabs.filter((t) => t.id !== id);
    setTabs(filtered);
    if (activeTabId === id) {
      const lastTab = filtered[filtered.length - 1];
      if (lastTab) {
        setActiveTabId(lastTab.id);
      }
    }
  };

  /** 打开 Review 功能 */
  const handleOpenReview = () => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId ? { ...t, title: "Review", type: "review" } : t
      )
    );
  };

  /** 打开文件查看器功能 */
  const handleOpenFile = (path?: string) => {
    const fileName = path ? path.split("/").pop() || path : "Open File";
    // 如果当前已经是 empty tab，直接替换，否则新建 tab
    const curTab = tabs.find((t) => t.id === activeTabId);
    if (curTab && curTab.type === "empty") {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? { ...t, title: fileName, type: "file", filePath: path }
            : t
        )
      );
    } else {
      const newId = `file-${Date.now()}`;
      setTabs((prev) => [
        ...prev,
        { id: newId, title: fileName, type: "file", filePath: path },
      ]);
      setActiveTabId(newId);
    }
  };

  /** 打开交互式 Terminal 功能 */
  const handleOpenTerminal = () => {
    const curTab = tabs.find((t) => t.id === activeTabId);
    if (curTab && curTab.type === "empty") {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId ? { ...t, title: "Terminal", type: "terminal" } : t
        )
      );
    } else {
      const newId = `terminal-${Date.now()}`;
      setTabs((prev) => [
        ...prev,
        { id: newId, title: "Terminal", type: "terminal" },
      ]);
      setActiveTabId(newId);
    }
  };

  if (!isOpen) {
    return null;
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  const getTabIcon = (type: TabItem["type"]) => {
    switch (type) {
      case "review":
        return <GitPullRequestIcon className="size-3.5 text-zinc-400 group-hover:text-zinc-200" />;
      case "terminal":
        return <TerminalIcon className="size-3.5 text-emerald-400" />;
      case "file":
        return <FileCodeIcon className="size-3.5 text-blue-400" />;
      case "empty":
        return <SearchIcon className="size-3.5 text-zinc-400" />;
      default:
        return <PlusIcon className="size-3.5 text-zinc-400" />;
    }
  };

  return (
    <aside
      style={{ width: isFullScreen ? "100%" : `${width}px` }}
      className={`relative flex flex-col h-full shrink-0 border-l border-zinc-800 bg-black shadow-2xl transition-all duration-150 ${
        isResizing ? "select-none" : ""
      }`}
    >
      {/* 左侧可拖拽调整尺寸的手柄 */}
      {!isFullScreen && (
        <div
          onMouseDown={handleMouseDown}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 transition-colors z-30"
          title="拖拽调节宽度"
        />
      )}

      {/* 顶部 Tab 栏（对应图 1 与图 2 顶部） */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-800/90 bg-zinc-950 px-2 select-none">
        {/* 左侧标签页列表 */}
        <div className="flex items-center gap-1 overflow-x-auto min-w-0 pr-2">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`group flex items-center gap-1.5 rounded-t px-2.5 py-1.5 text-xs font-medium cursor-pointer transition-colors border-b-2 ${
                  isActive
                    ? "bg-zinc-900 text-white border-blue-500 shadow-sm"
                    : "text-zinc-400 border-transparent hover:bg-zinc-900/50 hover:text-zinc-200"
                }`}
              >
                {getTabIcon(tab.type)}
                <span className="truncate max-w-[120px]">{tab.title}</span>
                <button
                  type="button"
                  onClick={(e) => handleCloseTab(tab.id, e)}
                  title={tabs.length <= 1 ? "关闭并收起侧边栏" : "关闭标签"}
                  className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            );
          })}

          {/* 新增 Tab 按钮（对应图 2 中 Rev 标签右侧的 +） */}
          <button
            type="button"
            onClick={handleAddTab}
            title="新建标签页"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>

        {/* 右上角操作按钮（对应用户截图图 1 和图 2 右上角：收起与全屏） */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setIsFullScreen(!isFullScreen)}
            title={isFullScreen ? "退出全屏" : "全屏显示"}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            {isFullScreen ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={onToggle}
            title="收起右侧边栏"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </button>
        </div>
      </div>

      {/* 标签页内容呈现 */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {activeTab?.type === "review" && (
          <ReviewPanel workspaceRoot={workspaceRoot} />
        )}
        {activeTab?.type === "empty" && (
          <EmptyTabView
            onOpenReview={handleOpenReview}
            onOpenFile={handleOpenFile}
            onOpenTerminal={handleOpenTerminal}
          />
        )}
        {activeTab?.type === "terminal" && (
          <TerminalView workspaceRoot={workspaceRoot} />
        )}
        {activeTab?.type === "file" && (
          <FileViewer initialPath={activeTab.filePath} workspaceRoot={workspaceRoot} />
        )}
      </div>
    </aside>
  );
}
