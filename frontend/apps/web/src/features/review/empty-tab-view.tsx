import { useState, useMemo } from "react";
import { GitPullRequestIcon, FileCodeIcon, TerminalIcon, SearchIcon, ArrowRightIcon } from "lucide-react";
import type { GitFileItem } from "./review-types.js";

interface EmptyTabViewProps {
  onOpenReview: () => void;
  onOpenFile: (path?: string) => void;
  onOpenTerminal: () => void;
  changedFiles?: GitFileItem[];
}

/**
 * 对应图 1：当没有激活的标签页或新建 Tab 时显示的检索与快捷入口视图。
 */
export function EmptyTabView({
  onOpenReview,
  onOpenFile,
  onOpenTerminal,
  changedFiles = [],
}: EmptyTabViewProps) {
  const [searchTerm, setSearchTerm] = useState("");

  const actions = [
    {
      id: "review",
      icon: GitPullRequestIcon,
      label: "Review",
      desc: "查看 Git 代码变更、Diff 对比与提交",
      onClick: onOpenReview,
    },
    {
      id: "file",
      icon: FileCodeIcon,
      label: "Open File",
      desc: "快速定位并浏览工作区文件与代码",
      onClick: () => onOpenFile(),
    },
    {
      id: "terminal",
      icon: TerminalIcon,
      label: "Terminal",
      desc: "启动交互式控制台终端并运行 Shell 命令",
      onClick: onOpenTerminal,
    },
  ];

  // 快捷入口搜索匹配
  const filteredActions = actions.filter((act) =>
    !searchTerm.trim() ||
    act.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
    act.desc.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // 工作区变更文件搜索匹配（让搜索真正能搜出文件！）
  const matchedFiles = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const term = searchTerm.toLowerCase();
    return changedFiles.filter(
      (f) => f.name.toLowerCase().includes(term) || f.path.toLowerCase().includes(term)
    ).slice(0, 5);
  }, [searchTerm, changedFiles]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const firstAction = filteredActions[0];
      const firstFile = matchedFiles[0];
      if (firstAction) {
        firstAction.onClick();
      } else if (firstFile) {
        onOpenFile(firstFile.path);
      }
    }
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 bg-black text-zinc-300 select-none">
      <div className="w-full max-w-md space-y-4">
        {/* 顶部搜索框（图 1 风格） */}
        <div className="relative w-full">
          <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-zinc-500" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search tabs, files, plugins, subagents, artifacts, tasks..."
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950/80 px-10 py-2.5 text-xs text-zinc-200 placeholder-zinc-500 shadow-inner outline-none transition-colors focus:border-zinc-700 focus:bg-zinc-900"
            autoFocus
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500 font-mono">
            Enter
          </span>
        </div>

        {/* 快捷操作选项列表（图 1 风格） */}
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-1.5 shadow-xl backdrop-blur space-y-1">
          {filteredActions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                type="button"
                onClick={action.onClick}
                className="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-zinc-800/60 hover:text-white cursor-pointer"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded border border-zinc-800 bg-zinc-900/90 text-zinc-400 group-hover:border-zinc-700 group-hover:text-zinc-200">
                  <Icon className="size-4" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-zinc-200 group-hover:text-white">
                      {action.label}
                    </span>
                  </div>
                  <span className="truncate text-[11px] text-zinc-500 group-hover:text-zinc-400">
                    {action.desc}
                  </span>
                </div>
                <ArrowRightIcon className="size-3.5 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            );
          })}

          {/* 搜索命中的工作区文件 */}
          {matchedFiles.length > 0 && (
            <div className="pt-2 border-t border-zinc-800/80 mt-1">
              <div className="px-3 py-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                匹配的文件
              </div>
              {matchedFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => onOpenFile(file.path)}
                  className="group flex w-full items-center justify-between px-3 py-2 text-left rounded hover:bg-zinc-800/50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <FileCodeIcon className="size-3.5 text-blue-400 shrink-0" />
                    <span className="text-xs text-zinc-300 group-hover:text-white truncate">
                      {file.name}
                    </span>
                    <span className="text-[10px] text-zinc-500 truncate">{file.dir}</span>
                  </div>
                  <span className="text-[10px] text-zinc-600 group-hover:text-zinc-400">打开查看</span>
                </button>
              ))}
            </div>
          )}

          {filteredActions.length === 0 && matchedFiles.length === 0 && (
            <div className="py-6 text-center text-xs text-zinc-500">
              未匹配到 “{searchTerm}” 相关选项或文件
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
