import { useState, useRef, useEffect } from "react";
import { TerminalIcon, Trash2Icon, Maximize2Icon } from "lucide-react";

interface TerminalViewProps {
  workspaceRoot: string | null;
}

interface OutputEntry {
  type: "banner" | "command" | "output" | "error";
  text: string;
}

export function TerminalView({ workspaceRoot }: TerminalViewProps) {
  const currentCwd = workspaceRoot || "D:\\temp\\agentscope-harness";
  const [outputLines, setOutputLines] = useState<OutputEntry[]>([
    {
      type: "banner",
      text: "Windows PowerShell\n版权所有 (C) Microsoft Corporation。保留所有权利。\n\n安装最新的 PowerShell，了解新功能和改进！https://aka.ms/PSWindows\n",
    },
  ]);
  const [inputVal, setInputVal] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [outputLines]);

  const handleRunCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = inputVal.trim();
    if (!cmd) {
      setOutputLines((prev) => [
        ...prev,
        { type: "command", text: `PS ${currentCwd}> ` },
      ]);
      return;
    }

    if (cmd.toLowerCase() === "cls" || cmd.toLowerCase() === "clear") {
      setOutputLines([]);
      setInputVal("");
      return;
    }

    // 记录历史
    setHistory((prev) => [...prev, cmd]);
    setHistoryIdx(-1);

    // 显示用户输入的命令行
    setOutputLines((prev) => [
      ...prev,
      { type: "command", text: `PS ${currentCwd}> ${cmd}` },
    ]);
    setInputVal("");
    setRunning(true);

    try {
      const res = await fetch("/api/git/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: cmd,
          root: workspaceRoot,
        }),
      });
      const data = await res.json();
      const outputText = data.output ?? "";
      if (outputText.trim()) {
        setOutputLines((prev) => [
          ...prev,
          {
            type: data.ok ? "output" : "error",
            text: outputText,
          },
        ]);
      } else {
        setOutputLines((prev) => [
          ...prev,
          {
            type: "output",
            text: "",
          },
        ]);
      }
    } catch (err: any) {
      setOutputLines((prev) => [
        ...prev,
        {
          type: "error",
          text: `终端执行错误: ${err.message || String(err)}`,
        },
      ]);
    } finally {
      setRunning(false);
      setTimeout(() => {
        inputRef.current?.focus();
        scrollToBottom();
      }, 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const nextIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(nextIdx);
      setInputVal(history[nextIdx] || "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (history.length === 0 || historyIdx === -1) return;
      const nextIdx = historyIdx + 1;
      if (nextIdx >= history.length) {
        setHistoryIdx(-1);
        setInputVal("");
      } else {
        setHistoryIdx(nextIdx);
        setInputVal(history[nextIdx] || "");
      }
    }
  };

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className="flex flex-1 flex-col h-full bg-[#0c0c0c] text-[#cccccc] font-mono text-[12.5px] leading-relaxed overflow-hidden select-text cursor-text"
      style={{ fontFamily: "'Cascadia Code', 'Consolas', 'Lucida Console', Courier, monospace" }}
    >
      {/* 终端顶部标题栏（纯正 Windows 终端风格） */}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-zinc-800/80 bg-[#1f1f1f] px-3 select-none">
        <div className="flex items-center gap-2">
          <span className="flex size-3 items-center justify-center rounded-sm bg-[#012456] text-[9px] font-bold text-sky-300">
            PS
          </span>
          <span className="text-xs font-semibold text-zinc-300">Windows PowerShell</span>
          <span className="text-[10px] text-zinc-500 truncate max-w-[200px]" title={currentCwd}>
            ({currentCwd})
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOutputLines([]);
            }}
            title="清屏 (cls)"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <Trash2Icon className="size-3.5" />
          </button>
        </div>
      </div>

      {/* 终端正文输出区 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {outputLines.map((entry, idx) => {
          if (entry.type === "banner") {
            return (
              <div key={idx} className="whitespace-pre-wrap text-zinc-300 select-text">
                {entry.text}
              </div>
            );
          }
          if (entry.type === "command") {
            return (
              <div key={idx} className="flex items-center font-semibold text-white whitespace-pre-wrap">
                {entry.text}
              </div>
            );
          }
          return (
            <div
              key={idx}
              className={`whitespace-pre-wrap select-text leading-tight ${
                entry.type === "error" ? "text-rose-400" : "text-zinc-300"
              }`}
            >
              {entry.text}
            </div>
          );
        })}

        {/* 正在运行中的光标提示 */}
        {running ? (
          <div className="flex items-center gap-1.5 text-zinc-400 pt-1">
            <span className="size-1.5 rounded-full bg-sky-400 animate-pulse" />
            <span className="text-xs">正在执行命令...</span>
          </div>
        ) : (
          /* 当前命令行输入 */
          <form onSubmit={handleRunCommand} className="flex items-center min-w-0 pt-0.5">
            <span className="shrink-0 font-semibold text-white select-none mr-1.5">
              PS {currentCwd}&gt;
            </span>
            <input
              ref={inputRef}
              type="text"
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={running}
              autoFocus
              className="flex-1 bg-transparent text-[#cccccc] font-mono text-[12.5px] outline-none caret-white"
              spellCheck={false}
              autoComplete="off"
            />
          </form>
        )}
        <div ref={terminalEndRef} />
      </div>
    </div>
  );
}
