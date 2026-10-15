import { useState, useEffect } from "react";
import { FileCodeIcon, SearchIcon, RefreshCwIcon, CopyIcon, CheckIcon, FolderIcon } from "lucide-react";

interface FileViewerProps {
  initialPath?: string;
  workspaceRoot: string | null;
}

export function FileViewer({ initialPath, workspaceRoot }: FileViewerProps) {
  const [filePath, setFilePath] = useState(initialPath || "backend/src/main/java/com/agentscope/harness/controller/GitController.java");
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");

  const loadFile = async (path: string) => {
    if (!path.trim()) return;
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ path });
      if (workspaceRoot) {
        params.set("root", workspaceRoot);
      }
      const res = await fetch(`/api/git/file-content?${params.toString()}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "读取文件失败");
      }
      setContent(data.content || "");
      setFilePath(path);
    } catch (err: any) {
      setError(err.message || String(err));
      setContent("");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialPath) {
      void loadFile(initialPath);
    } else {
      void loadFile(filePath);
    }
  }, [initialPath]);

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = content.split("\n");

  return (
    <div className="flex flex-1 flex-col h-full bg-black text-zinc-200 text-xs overflow-hidden">
      {/* 顶部路径输入与操作条 */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileCodeIcon className="size-4 text-blue-400 shrink-0" />
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void loadFile(filePath);
              }
            }}
            placeholder="输入文件相对路径 (例如 run.cmd, backend/pom.xml)..."
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => void loadFile(filePath)}
            className="rounded bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 hover:text-white"
          >
            打开
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            title="复制代码内容"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            {copied ? <CheckIcon className="size-3.5 text-emerald-400" /> : <CopyIcon className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void loadFile(filePath)}
            title="重新加载"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* 文件代码内容区 */}
      <div className="flex-1 overflow-auto bg-black p-2 font-mono text-xs">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-zinc-500">
            <RefreshCwIcon className="size-4 animate-spin mr-2" />
            正在加载文件内容...
          </div>
        ) : error ? (
          <div className="p-4 text-rose-400 bg-rose-950/20 border border-rose-900/50 rounded">
            {error}
          </div>
        ) : (
          <div className="min-w-max text-[11.5px] leading-relaxed">
            {lines.map((line, idx) => (
              <div key={idx} className="flex items-start hover:bg-zinc-800/30">
                <span className="w-12 shrink-0 text-right pr-3 text-zinc-600 select-none border-r border-zinc-800/80 text-[10px]">
                  {idx + 1}
                </span>
                <span className="whitespace-pre pl-3 text-zinc-300">{line}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
