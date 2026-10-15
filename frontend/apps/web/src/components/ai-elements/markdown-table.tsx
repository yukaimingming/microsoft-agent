/**
 * 自定义 Markdown 表格组件。
 *
 * 解决 Streamdown 原生表格点击复制时弹出 CSV/TSV 菜单且样式错位的问题：
 * - 点击复制按钮直接复制表格，绝不弹出任何二级菜单。
 * - 复制时同时写入标准 Markdown 纯文本与 HTML 富文本，贴入 Excel/Word/飞书/Markdown 均完美兼容。
 * - 点击后即刻显示绿色对勾反馈，2 秒后自动复原。
 * - 支持一键直接下载为带 UTF-8 BOM 的 CSV 文件，中文绝不乱码。
 */

import { memo, useRef, useState, type ComponentProps } from "react";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** 从 HTML 表格 DOM 提取结构化数据 */
function extractTableData(table: HTMLTableElement): { headers: string[]; rows: string[][] } {
  const headers: string[] = [];
  const rows: string[][] = [];

  // 获取表头
  const theadRows = Array.from(table.querySelectorAll("thead tr, tr:has(th)"));
  if (theadRows.length > 0 && theadRows[0]) {
    const thCells = Array.from(theadRows[0].querySelectorAll("th, td"));
    thCells.forEach((th) => headers.push((th.textContent || "").trim()));
  }

  // 获取数据行
  const tbodyRows = Array.from(table.querySelectorAll("tbody tr"));
  const bodyRowsToProcess =
    tbodyRows.length > 0
      ? tbodyRows
      : Array.from(table.querySelectorAll("tr")).slice(headers.length > 0 ? 1 : 0);

  bodyRowsToProcess.forEach((tr) => {
    if (tr.querySelector("th") && headers.length > 0) return;
    const cells = Array.from(tr.querySelectorAll("td, th"));
    if (cells.length > 0) {
      rows.push(cells.map((td) => (td.textContent || "").trim()));
    }
  });

  return { headers, rows };
}

/** 转换为标准 Markdown 表格 */
function tableToMarkdown(tableData: { headers: string[]; rows: string[][] }): string {
  const { headers, rows } = tableData;
  if (headers.length === 0 && rows.length === 0) return "";

  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const safeHeaders = headers.length > 0 ? headers : new Array(colCount).fill("");

  const escapeCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

  const headerLine = `| ${safeHeaders.map(escapeCell).join(" | ")} |`;
  const separatorLine = `| ${new Array(colCount).fill("---").join(" | ")} |`;
  const bodyLines = rows.map((r) => {
    const padded = [...r];
    while (padded.length < colCount) padded.push("");
    return `| ${padded.map(escapeCell).join(" | ")} |`;
  });

  return [headerLine, separatorLine, ...bodyLines].join("\n");
}

/** 转换为 CSV 数据 */
function tableToCSV(tableData: { headers: string[]; rows: string[][] }): string {
  const { headers, rows } = tableData;
  const escapeCSV = (s: string) => {
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const allRows = headers.length > 0 ? [headers, ...rows] : rows;
  return allRows.map((r) => r.map(escapeCSV).join(",")).join("\n");
}

export const MarkdownTable = memo(function MarkdownTable({
  children,
  className,
  ...props
}: ComponentProps<"table">) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);

  /** 一键直接复制，绝不弹出 CSV/TSV 菜单 */
  const handleDirectCopy = async () => {
    if (!tableRef.current) return;
    try {
      const data = extractTableData(tableRef.current);
      const md = tableToMarkdown(data);
      const html = tableRef.current.outerHTML;

      if (navigator.clipboard && window.ClipboardItem) {
        const item = new ClipboardItem({
          "text/plain": new Blob([md], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        });
        await navigator.clipboard.write([item]);
      } else {
        await navigator.clipboard.writeText(md);
      }

      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 兼容性降级：使用隐藏textarea与execCommand
      try {
        if (tableRef.current) {
          const data = extractTableData(tableRef.current);
          const md = tableToMarkdown(data);
          const ta = document.createElement("textarea");
          ta.value = md;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
      } catch (e) {
        console.warn("剪贴板环境受限:", e);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  /** 直接下载表格 CSV 文件 */
  const handleDirectDownload = () => {
    if (!tableRef.current) return;
    try {
      const data = extractTableData(tableRef.current);
      const csv = tableToCSV(data);
      // 添加 UTF-8 BOM (\uFEFF) 确保 Windows Excel 打开中文不乱码
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `table-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("下载表格失败:", e);
    }
  };

  return (
    <div className="my-4 flex flex-col space-y-1.5 group/table-wrapper" data-streamdown="table-wrapper">
      {/* 表格顶部操作工具条：靠右展示，点击直接复制/下载，绝无任何弹窗 */}
      <div className="flex items-center justify-end gap-1 px-1">
        <button
          type="button"
          onClick={handleDirectCopy}
          className={cn(
            "flex items-center gap-1 p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 transition-colors cursor-pointer",
            copied && "text-emerald-400 hover:text-emerald-300"
          )}
          title={copied ? "已复制表格" : "复制表格"}
        >
          {copied ? <CheckIcon className="size-3.5 text-emerald-400" /> : <CopyIcon className="size-3.5" />}
          {copied && <span className="text-[11px] font-medium text-emerald-400">已复制</span>}
        </button>

        <button
          type="button"
          onClick={handleDirectDownload}
          className="flex items-center p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 transition-colors cursor-pointer"
          title="下载表格 (CSV)"
        >
          <DownloadIcon className="size-3.5" />
        </button>
      </div>

      {/* 表格主体渲染 */}
      <div className="overflow-x-auto rounded-lg border border-zinc-800/80 bg-zinc-950/40 table-container">
        <table
          ref={tableRef}
          className={cn(
            "w-full border-collapse text-[13px] text-zinc-200 markdown-table-body",
            "[&_th]:border-b [&_th]:border-zinc-800 [&_th]:bg-zinc-900/60 [&_th]:px-3.5 [&_th]:py-2.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-zinc-100",
            "[&_td]:border-b [&_td]:border-zinc-800/50 [&_td]:px-3.5 [&_td]:py-2.5",
            "[&_tr:last-child_td]:border-b-0",
            "[&_tr:hover]:bg-zinc-900/40 transition-colors",
            className
          )}
          data-streamdown="table"
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
});
