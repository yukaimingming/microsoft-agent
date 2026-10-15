import { useState } from "react";
import { useGitReview } from "./use-git-review.js";
import { ReviewDiffView } from "./review-diff-view.js";
import { ReviewFileList } from "./review-file-list.js";
import {
  ChevronDownIcon,
  SearchIcon,
  MoreVerticalIcon,
  LayoutListIcon,
  RefreshCwIcon,
  CheckIcon,
  SendIcon,
} from "lucide-react";

interface ReviewPanelProps {
  workspaceRoot: string | null;
}

export function ReviewPanel({ workspaceRoot }: ReviewPanelProps) {
  const {
    status,
    loading,
    selectedCommit,
    setSelectedCommit,
    selectedFile,
    setSelectedFile,
    currentDiff,
    diffLoading,
    commitLoading,
    refresh,
    commit,
  } = useGitReview(workspaceRoot);

  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitSuccess, setCommitSuccess] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const handleDoCommit = async () => {
    if (!commitMsg.trim()) {
      setCommitError("请输入提交说明");
      return;
    }
    setCommitError(null);
    try {
      await commit(commitMsg);
      setCommitSuccess(true);
      setCommitMsg("");
      setTimeout(() => {
        setCommitSuccess(false);
        setIsCommitModalOpen(false);
      }, 1200);
    } catch (err: any) {
      setCommitError(err.message || "提交失败");
    }
  };

  const stagedFiles = status?.staged || [];
  const changesFiles = status?.changes || [];
  const commits = status?.commits || [];
  const isGitRepo = status?.isGitRepo ?? false;
  const totalChanges = stagedFiles.length + changesFiles.length;

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden bg-black text-zinc-200">
      {/* 顶部 Review 工具栏（对应图 2） */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3">
        {/* 左侧 Review 与 Commit 下拉选择 */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-300">Review</span>
          <div className="relative">
            <select
              value={selectedCommit}
              onChange={(e) => setSelectedCommit(e.target.value)}
              className="appearance-none rounded border border-zinc-800 bg-zinc-900 py-1 pl-2.5 pr-7 text-xs text-zinc-200 hover:border-zinc-700 focus:border-zinc-600 focus:outline-none"
            >
              <option value="uncommitted">
                Uncommitted ({changesFiles.length + stagedFiles.length})
              </option>
              {commits.map((c) => (
                <option key={c.hash} value={c.hash}>
                  {c.hash} {c.subject.slice(0, 24)}...
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3 text-zinc-500" />
          </div>
        </div>

        {/* 右侧蓝色 Commit 按钮与工具图标 */}
        <div className="flex items-center gap-2">
          {/* Commit 按钮 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsCommitModalOpen(!isCommitModalOpen)}
              className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white shadow hover:bg-blue-500 active:bg-blue-700 transition-colors"
            >
              <span>Commit</span>
              <ChevronDownIcon className="size-3" />
            </button>

            {/* Commit 弹出卡片 */}
            {isCommitModalOpen && (
              <div className="absolute right-0 top-9 z-50 w-80 rounded-lg border border-zinc-800 bg-zinc-950 p-3 shadow-2xl backdrop-blur">
                <div className="mb-2 text-xs font-semibold text-zinc-200">
                  提交 Git 变更
                </div>
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="输入 commit message 说明..."
                  rows={3}
                  className="w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-xs text-zinc-100 placeholder-zinc-500 focus:border-blue-500 focus:outline-none resize-none"
                  autoFocus
                />
                {commitError && (
                  <div className="mt-1 text-[11px] text-rose-400">{commitError}</div>
                )}
                {commitSuccess && (
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-400">
                    <CheckIcon className="size-3" /> 提交成功！已刷新
                  </div>
                )}
                <div className="mt-2.5 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsCommitModalOpen(false)}
                    className="rounded px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={commitLoading || !commitMsg.trim()}
                    onClick={handleDoCommit}
                    className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                  >
                    {commitLoading ? (
                      <RefreshCwIcon className="size-3 animate-spin" />
                    ) : (
                      <SendIcon className="size-3" />
                    )}
                    <span>提交</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 搜索开关 */}
          <button
            type="button"
            onClick={() => setShowSearch(!showSearch)}
            title="搜索变更文件"
            className={`rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 ${
              showSearch ? "bg-zinc-800 text-zinc-100" : ""
            }`}
          >
            <SearchIcon className="size-3.5" />
          </button>

          {/* 刷新 */}
          <button
            type="button"
            onClick={refresh}
            title="刷新 Git 变更"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>

          {/* 视图模式切换 */}
          <button
            type="button"
            title="切换视图"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <LayoutListIcon className="size-3.5" />
          </button>

          {/* 更多操作 */}
          <button
            type="button"
            title="更多选项"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <MoreVerticalIcon className="size-3.5" />
          </button>
        </div>
      </div>

      {/* 搜索过滤栏 */}
      {showSearch && (
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-3 py-1.5">
          <div className="flex items-center flex-1 mr-2">
            <SearchIcon className="size-3.5 text-zinc-500 mr-2 shrink-0" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => {
                const term = e.target.value;
                setSearchTerm(term);
                if (term.trim()) {
                  const all = [...changesFiles, ...stagedFiles];
                  const matched = all.find(
                    (f) =>
                      f.name.toLowerCase().includes(term.toLowerCase()) ||
                      f.path.toLowerCase().includes(term.toLowerCase())
                  );
                  if (matched) {
                    setSelectedFile(matched);
                  }
                }
              }}
              placeholder="过滤文件名称或目录..."
              className="w-full bg-transparent text-xs text-zinc-200 placeholder-zinc-500 outline-none"
              autoFocus
            />
          </div>
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm("")}
              className="text-[10px] text-zinc-400 hover:text-zinc-200"
            >
              清空
            </button>
          )}
        </div>
      )}

      {/* 主体分栏：左侧 Diff 对比，右侧文件列表（仅当有 Git 内容且有修改时显示） */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* 左侧 Diff 内容区 */}
        <div className="flex-1 min-w-0 h-full overflow-hidden">
          {totalChanges > 0 ? (
            <ReviewDiffView
              file={selectedFile}
              allFiles={[...changesFiles, ...stagedFiles]}
              diff={currentDiff}
              loading={diffLoading}
              onSelectFile={setSelectedFile}
              onRefresh={() => selectedFile && setSelectedFile({ ...selectedFile })}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center h-full p-8 text-center text-zinc-500">
              <div className="size-10 rounded-full border border-zinc-800 bg-zinc-900/60 flex items-center justify-center mb-3 text-zinc-400">
                <LayoutListIcon className="size-5" />
              </div>
              <h3 className="text-sm font-medium text-zinc-300 mb-1">
                新建干净工作区
              </h3>
              <p className="text-xs text-zinc-500 max-w-xs">
                当前工作区暂无任何未提交的 Git 代码变更，右侧变更列表已自动隐藏。
              </p>
            </div>
          )}
        </div>

        {/* 右侧变更文件列表：按要求仅在工作区有 Git 内容且有修改时才显示，新建空工作区不显示 */}
        {isGitRepo && totalChanges > 0 && (
          <div className="w-64 shrink-0 h-full overflow-hidden">
            <ReviewFileList
              stagedFiles={stagedFiles}
              changesFiles={changesFiles}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              searchTerm={searchTerm}
            />
          </div>
        )}
      </div>
    </div>
  );
}
