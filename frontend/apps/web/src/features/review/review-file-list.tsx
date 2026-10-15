import { useState } from "react";
import type { GitFileItem } from "./review-types.js";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, MinusIcon } from "lucide-react";

interface ReviewFileListProps {
  stagedFiles: GitFileItem[];
  changesFiles: GitFileItem[];
  selectedFile: GitFileItem | null;
  onSelectFile: (file: GitFileItem) => void;
  searchTerm?: string;
}

function getFileBadge(name: string) {
  const ext = name.split(".").pop()?.toUpperCase() || "";
  if (ext === "TS" || ext === "TSX") {
    return { text: ext, color: "text-blue-400 bg-blue-950/60 border-blue-900/60" };
  }
  if (ext === "JS" || ext === "JSX") {
    return { text: ext, color: "text-yellow-400 bg-yellow-950/60 border-yellow-900/60" };
  }
  if (ext === "JAVA") {
    return { text: "JAVA", color: "text-orange-400 bg-orange-950/60 border-orange-900/60" };
  }
  if (["PNG", "JPG", "JPEG", "SVG", "GIF", "WEBP"].includes(ext)) {
    return { text: ext, color: "text-purple-400 bg-purple-950/60 border-purple-900/60" };
  }
  if (ext === "JSON") {
    return { text: "JSON", color: "text-emerald-400 bg-emerald-950/60 border-emerald-900/60" };
  }
  if (ext === "MD") {
    return { text: "MD", color: "text-sky-400 bg-sky-950/60 border-sky-900/60" };
  }
  return { text: ext.slice(0, 4) || "FILE", color: "text-zinc-400 bg-zinc-900 border-zinc-800" };
}

export function ReviewFileList({
  stagedFiles,
  changesFiles,
  selectedFile,
  onSelectFile,
  searchTerm = "",
}: ReviewFileListProps) {
  const [stagedExpanded, setStagedExpanded] = useState(true);
  const [changesExpanded, setChangesExpanded] = useState(true);

  const filterFn = (f: GitFileItem) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase();
    return f.name.toLowerCase().includes(term) || f.path.toLowerCase().includes(term);
  };

  const filteredStaged = stagedFiles.filter(filterFn);
  const filteredChanges = changesFiles.filter(filterFn);

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-zinc-950 text-xs border-l border-zinc-800 select-none">
      {/* Staged Changes 分组 */}
      <div className="border-b border-zinc-800/80">
        <button
          type="button"
          onClick={() => setStagedExpanded(!stagedExpanded)}
          className="flex w-full items-center justify-between px-3 py-1.5 font-medium text-zinc-400 hover:bg-zinc-900/60 transition-colors"
        >
          <div className="flex items-center gap-1.5">
            {stagedExpanded ? (
              <ChevronDownIcon className="size-3.5 text-zinc-500" />
            ) : (
              <ChevronRightIcon className="size-3.5 text-zinc-500" />
            )}
            <span className="text-zinc-300 font-semibold text-[11px] uppercase tracking-wider">
              Staged Changes
            </span>
          </div>
          <span className="rounded-full bg-zinc-900 px-1.5 py-0.2 text-[10px] text-zinc-500 font-mono">
            {filteredStaged.length}
          </span>
        </button>

        {stagedExpanded && (
          <div className="pb-1">
            {filteredStaged.length === 0 ? (
              <div className="px-6 py-2 text-[11px] text-zinc-500 italic">
                No file changes
              </div>
            ) : (
              filteredStaged.map((file) => {
                const isSelected = selectedFile?.path === file.path;
                const badge = getFileBadge(file.name);
                return (
                  <button
                    key={`staged-${file.path}`}
                    type="button"
                    onClick={() => onSelectFile(file)}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors ${
                      isSelected
                        ? "bg-zinc-800 text-white font-medium"
                        : "text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`rounded border px-1 py-0.2 text-[9px] font-mono font-bold shrink-0 ${badge.color}`}
                      >
                        {badge.text}
                      </span>
                      <span className="truncate text-xs">{file.name}</span>
                      <span className="truncate text-[10px] text-zinc-500" title={file.dir}>
                        {file.dir}
                      </span>
                    </div>

                    <span
                      className={`ml-2 shrink-0 rounded px-1.5 py-0.2 text-[10px] font-mono font-bold ${
                        file.status === "U"
                          ? "text-emerald-400"
                          : file.status === "M"
                            ? "text-amber-400"
                            : "text-rose-400"
                      }`}
                    >
                      {file.status}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Changes 分组 */}
      <div className="border-b border-zinc-800/80">
        <button
          type="button"
          onClick={() => setChangesExpanded(!changesExpanded)}
          className="flex w-full items-center justify-between px-3 py-1.5 font-medium text-zinc-400 hover:bg-zinc-900/60 transition-colors"
        >
          <div className="flex items-center gap-1.5">
            {changesExpanded ? (
              <ChevronDownIcon className="size-3.5 text-zinc-500" />
            ) : (
              <ChevronRightIcon className="size-3.5 text-zinc-500" />
            )}
            <span className="text-zinc-300 font-semibold text-[11px] uppercase tracking-wider">
              Changes
            </span>
          </div>
          <span className="rounded-full bg-zinc-900 px-1.5 py-0.2 text-[10px] text-zinc-500 font-mono">
            {filteredChanges.length}
          </span>
        </button>

        {changesExpanded && (
          <div className="pb-1">
            {filteredChanges.length === 0 ? (
              <div className="px-6 py-2 text-[11px] text-zinc-500 italic">
                No file changes
              </div>
            ) : (
              filteredChanges.map((file) => {
                const isSelected = selectedFile?.path === file.path;
                const badge = getFileBadge(file.name);
                return (
                  <button
                    key={`changes-${file.path}`}
                    type="button"
                    onClick={() => onSelectFile(file)}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors ${
                      isSelected
                        ? "bg-zinc-800 text-white font-medium"
                        : "text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`rounded border px-1 py-0.2 text-[9px] font-mono font-bold shrink-0 ${badge.color}`}
                      >
                        {badge.text}
                      </span>
                      <span className="truncate text-xs">{file.name}</span>
                      <span className="truncate text-[10px] text-zinc-500" title={file.dir}>
                        {file.dir}
                      </span>
                    </div>

                    <span
                      className={`ml-2 shrink-0 rounded px-1.5 py-0.2 text-[10px] font-mono font-bold ${
                        file.status === "U"
                          ? "text-emerald-400"
                          : file.status === "M"
                            ? "text-amber-400"
                            : "text-rose-400"
                      }`}
                    >
                      {file.status}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
