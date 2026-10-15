/**
 * 文件夹选择弹窗。
 *
 * 满足用户需求：
 * - 点击“添加文件夹”时弹窗选择，而非生硬内嵌输入框
 * - 允许浏览本地文件系统（通过服务端 /api/workspace/browse 接口）
 * - 支持快速点击系统快捷路径（桌面、工作区、各盘符）
 * - 支持双击/点击钻取子文件夹，支持返回上一级
 * - 支持手动输入路径快速跳转
 * - 纯黑主题（与 AI Elements 整体界面风格严格一致）
 */

import { useCallback, useEffect, useState } from "react";
import {
  FolderIcon,
  FolderPlusIcon,
  ChevronRightIcon,
  ArrowUpIcon,
  RefreshCwIcon,
  HardDriveIcon,
  CheckIcon,
} from "lucide-react";
import { Modal } from "../../components/modal.js";

interface FolderItem {
  name: string;
  path: string;
}

interface QuickPath {
  name: string;
  path: string;
}

interface BrowseResult {
  ok: boolean;
  current: string;
  parent: string | null;
  folders: FolderItem[];
  quickPaths: QuickPath[];
  error?: string;
}

interface FolderPickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (selectedPath: string) => void;
  initialPath?: string;
}

export function FolderPickerModal({
  open,
  onClose,
  onSelect,
  initialPath,
}: FolderPickerModalProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || "");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [quickPaths, setQuickPaths] = useState<QuickPath[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 新建子文件夹输入状态
  const [isCreatingDir, setIsCreatingDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");

  // 加载目录数据
  const loadDirectory = useCallback(async (path?: string) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const url = new URL("http://127.0.0.1:8787/api/workspace/browse");
      if (path && path.trim()) {
        url.searchParams.set("path", path.trim());
      }
      const res = await fetch(url.toString());
      const data = (await res.json()) as BrowseResult;
      if (data.ok) {
        setCurrentPath(data.current);
        setSelectedFolder(data.current);
        setParentPath(data.parent);
        setFolders(data.folders || []);
        if (data.quickPaths && data.quickPaths.length > 0) {
          setQuickPaths(data.quickPaths);
        }
      } else {
        setErrorMsg(data.error || "读取目录失败");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "连接本地服务失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadDirectory(initialPath);
    }
  }, [open, initialPath, loadDirectory]);

  // 新建文件夹
  const handleCreateDirectory = async () => {
    const trimmed = newDirName.trim();
    if (!trimmed || !currentPath) return;
    try {
      const res = await fetch("http://127.0.0.1:8787/api/workspace/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentDir: currentPath, dirName: trimmed }),
      });
      const data = (await res.json()) as { ok?: boolean; createdPath?: string; error?: string };
      if (res.ok && data.ok) {
        setNewDirName("");
        setIsCreatingDir(false);
        // 重新加载并选中新创建的目录
        void loadDirectory(currentPath);
        if (data.createdPath) {
          setSelectedFolder(data.createdPath);
        }
      } else {
        setErrorMsg(data.error || "创建文件夹失败");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "创建失败");
    }
  };

  const handleConfirm = () => {
    const chosen = selectedFolder || currentPath;
    if (chosen) {
      onSelect(chosen);
      onClose();
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="选择工作区文件夹" width="lg">
      <div className="flex flex-col gap-4 text-zinc-200">
        {/* 顶部：快速推荐路径条 */}
        {quickPaths.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap pb-2 border-b border-zinc-800/60">
            <span className="text-[11.5px] text-zinc-500 mr-1 flex items-center gap-1">
              <HardDriveIcon className="size-3.5" /> 常用位置:
            </span>
            {quickPaths.map((item) => (
              <button
                key={item.path}
                type="button"
                onClick={() => void loadDirectory(item.path)}
                className={`px-2 py-0.5 rounded text-[12px] transition-colors border ${
                  currentPath === item.path
                    ? "bg-zinc-800 text-white border-zinc-700"
                    : "bg-zinc-900/80 text-zinc-400 hover:text-zinc-200 border-zinc-800/80 hover:border-zinc-700"
                }`}
                title={item.path}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}

        {/* 路径导航行：上一级、当前路径输入/展示、刷新、新建 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => parentPath && void loadDirectory(parentPath)}
            disabled={!parentPath || loading}
            className="flex size-7 items-center justify-center rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title="返回上一级目录"
          >
            <ArrowUpIcon className="size-3.5" />
          </button>

          <div className="relative flex-1">
            <input
              type="text"
              value={currentPath}
              onChange={(e) => setCurrentPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void loadDirectory(currentPath);
                }
              }}
              placeholder="输入或选择目录完整路径..."
              className="w-full rounded bg-zinc-900/90 border border-zinc-800 px-3 py-1.5 text-[12.5px] font-mono text-zinc-200 focus:outline-none focus:border-zinc-600"
            />
          </div>

          <button
            type="button"
            onClick={() => void loadDirectory(currentPath)}
            disabled={loading}
            className="flex size-7 items-center justify-center rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white transition-colors"
            title="刷新目录"
          >
            <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>

          <button
            type="button"
            onClick={() => setIsCreatingDir((v) => !v)}
            className="flex items-center gap-1 h-7 px-2.5 rounded bg-zinc-900 border border-zinc-800 text-[12px] text-zinc-400 hover:text-white transition-colors"
            title="新建子文件夹"
          >
            <FolderPlusIcon className="size-3.5" />
            <span>新建</span>
          </button>
        </div>

        {/* 新建子文件夹内联输入 */}
        {isCreatingDir && (
          <div className="flex items-center gap-2 p-2 rounded bg-zinc-900/90 border border-zinc-800">
            <FolderIcon className="size-4 text-zinc-400 shrink-0" />
            <input
              type="text"
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateDirectory();
                if (e.key === "Escape") setIsCreatingDir(false);
              }}
              placeholder="输入新文件夹名称..."
              autoFocus
              className="flex-1 bg-transparent text-[12.5px] text-zinc-200 outline-none"
            />
            <button
              type="button"
              onClick={() => void handleCreateDirectory()}
              className="px-2 py-0.5 rounded bg-zinc-800 text-[11.5px] text-zinc-200 hover:bg-zinc-700"
            >
              创建
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingDir(false)}
              className="px-2 py-0.5 text-[11.5px] text-zinc-500 hover:text-zinc-300"
            >
              取消
            </button>
          </div>
        )}

        {/* 错误提示 */}
        {errorMsg && (
          <div className="rounded bg-rose-950/40 border border-rose-800/50 p-2 text-[12px] text-rose-300">
            {errorMsg}
          </div>
        )}

        {/* 文件夹列表展示区域 */}
        <div className="h-[260px] overflow-y-auto rounded-lg border border-zinc-800/80 bg-black/60 p-2">
          {loading ? (
            <div className="flex h-full items-center justify-center text-[12.5px] text-zinc-500">
              <RefreshCwIcon className="mr-2 size-4 animate-spin" />
              正在读取文件夹...
            </div>
          ) : folders.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-zinc-500 text-[12.5px] gap-1">
              <FolderIcon className="size-8 stroke-[1.2] opacity-40" />
              <span>当前目录下没有子文件夹</span>
              <span className="text-[11.5px] text-zinc-600">可以直接点击下方按钮选择当前目录</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">
              {folders.map((folder) => {
                const isSelected = selectedFolder === folder.path;
                return (
                  <div
                    key={folder.path}
                    onClick={() => setSelectedFolder(folder.path)}
                    onDoubleClick={() => void loadDirectory(folder.path)}
                    className={`flex items-center justify-between gap-2 px-3 py-2 rounded-md cursor-pointer border transition-colors ${
                      isSelected
                        ? "bg-zinc-800 border-zinc-600 text-white"
                        : "bg-zinc-950/40 border-zinc-900 text-zinc-300 hover:bg-zinc-900 hover:border-zinc-800"
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <FolderIcon className={`size-4 shrink-0 ${isSelected ? "text-amber-400" : "text-zinc-400"}`} />
                      <span className="truncate text-[12.5px]">{folder.name}</span>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void loadDirectory(folder.path);
                      }}
                      className="p-1 rounded hover:bg-zinc-700/60 text-zinc-500 hover:text-zinc-200 transition-colors"
                      title="进入此文件夹"
                    >
                      <ChevronRightIcon className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 底部信息与确认按钮 */}
        <div className="flex items-center justify-between pt-2 border-t border-zinc-800/80">
          <div className="text-[12px] text-zinc-400 truncate max-w-[420px]">
            <span className="text-zinc-500 mr-1.5">已选中:</span>
            <span className="font-mono text-zinc-200 truncate">{selectedFolder || currentPath}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-[12.5px] text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-zinc-100 text-black font-medium text-[12.5px] hover:bg-white transition-colors"
            >
              <CheckIcon className="size-3.5 stroke-[2.5]" />
              选择此文件夹
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
