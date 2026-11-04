import React, { useState, useEffect, useRef, useId, useCallback } from "react";
import mermaid from "mermaid";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize2,
  Minimize2,
  Copy,
  Check,
  Code2,
  Eye,
  Download,
  Image as ImageIcon,
  FileCode,
  RefreshCw,
  AlertCircle,
  Network,
  Scan,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { sanitizeMermaid, repairMermaid } from "./mermaid-sanitizer.js";

export interface DiagramViewerProps {
  code: string;
  title?: string;
  className?: string;
}

// 解析图表类型与展示名称
function detectDiagramType(code: string): { type: string; label: string } {
  const clean = code.trim().toLowerCase();
  if (clean.startsWith("sequencediagram")) {
    return { type: "sequence", label: "时序图 (Sequence)" };
  }
  if (clean.startsWith("statediagram") || clean.startsWith("statediagram-v2")) {
    return { type: "state", label: "状态机图 (State)" };
  }
  if (clean.startsWith("classdiagram")) {
    return { type: "class", label: "类图 (Class)" };
  }
  if (clean.startsWith("erdiagram")) {
    return { type: "er", label: "实体关系图 (ER)" };
  }
  if (clean.startsWith("architecture-beta") || clean.startsWith("architecture")) {
    return { type: "architecture", label: "架构图 (Architecture)" };
  }
  if (clean.startsWith("gantt")) {
    return { type: "gantt", label: "甘特图 (Gantt)" };
  }
  if (clean.startsWith("mindmap")) {
    return { type: "mindmap", label: "思维导图 (Mindmap)" };
  }
  if (clean.startsWith("gitgraph")) {
    return { type: "gitGraph", label: "Git 分支图 (GitGraph)" };
  }
  return { type: "flowchart", label: "流程图 (Flowchart)" };
}

// 提取图表标题
function extractDiagramTitle(code: string, fallbackType: string): string {
  const lines = code.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("title ")) {
      return trimmed.replace(/^title\s+/, "").trim();
    }
    if (trimmed.startsWith("%% title:")) {
      return trimmed.replace(/^%%\s*title:\s*/, "").trim();
    }
  }
  return `${fallbackType} 可视化`;
}

export const DiagramViewer: React.FC<DiagramViewerProps> = ({
  code: initialCode,
  title: initialTitle,
  className,
}) => {
  const [code, setCode] = useState(initialCode);
  const [svgHtml, setSvgHtml] = useState<string>("");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const uniqueId = useId().replace(/:/g, "_");
  const renderCounter = useRef(0);

  const isDraggingRef = useRef(false);
  const hasMovedRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, startOffsetX: 0, startOffsetY: 0 });
  const stateRef = useRef({ zoom: 1, offset: { x: 0, y: 0 } });

  // 同步状态引用，避免事件闭包 stale state
  useEffect(() => {
    stateRef.current = { zoom, offset };
  }, [zoom, offset]);

  // 监听主题变化（深色 / 浅色）
  const [isDark, setIsDark] = useState(() => {
    if (typeof document !== "undefined") {
      return document.documentElement.classList.contains("dark");
    }
    return false;
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  const { label: typeLabel } = detectDiagramType(code);
  const displayTitle = initialTitle || extractDiagramTitle(code, typeLabel.split(" ")[0] ?? "流程图");

  // 辅助函数：清理 document.body 下遗留的 Mermaid 临时 DOM 节点
  const cleanupTempDom = (elementId: string) => {
    if (typeof document !== "undefined") {
      const tempIds = [elementId, `d${elementId}`, `i${elementId}`];
      for (const tid of tempIds) {
        const el = document.getElementById(tid);
        if (el && el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }
      // 深度清理 document.body 直属的任何包含 elementId 的临时容器
      const trailingEls = document.querySelectorAll(`[id*="${elementId}"]`);
      trailingEls.forEach((el) => {
        if (el && el.parentNode === document.body) {
          document.body.removeChild(el);
        }
      });
    }
  };

  // Mermaid 渲染引擎执行
  const renderDiagram = useCallback(
    async (codeToRender: string) => {
      const trimmed = codeToRender.trim();
      if (!trimmed) {
        setSvgHtml("");
        setRenderError("图表代码不能为空。");
        return;
      }

      renderCounter.current += 1;
      const elementId = `mermaid_diag_${uniqueId}_${renderCounter.current}`;

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict", // 启用严格安全级别，阻断 XSS 与 SVG 脚本注入
        suppressErrorRendering: true, // 禁用 Mermaid 内置报错图挂载至 DOM
        theme: isDark ? "dark" : "default",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        flowchart: { htmlLabels: true, curve: "basis" },
        sequence: { actorMargin: 50 },
      });

      // 阶段 1：先过常规语法清洗 sanitizeMermaid
      const sanitized = sanitizeMermaid(trimmed);

      try {
        const { svg } = await mermaid.render(elementId, sanitized);
        setSvgHtml(svg);
        setRenderError(null);
      } catch (err: unknown) {
        console.warn("Mermaid 初始渲染失败，尝试激进修复:", err);
        cleanupTempDom(elementId);

        // 阶段 2：如果渲染失败，再用 repairMermaid 重试一次
        try {
          renderCounter.current += 1;
          const retryElementId = `mermaid_diag_${uniqueId}_${renderCounter.current}`;
          const repaired = repairMermaid(trimmed);
          const { svg: retrySvg } = await mermaid.render(retryElementId, repaired);
          setSvgHtml(retrySvg);
          setRenderError(null);
        } catch (retryErr: unknown) {
          console.warn("Mermaid 激进重试后仍失败:", retryErr);
          const rawMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          const firstLine = rawMsg.split("\n")[0] || rawMsg;
          setRenderError(firstLine);
        } finally {
          cleanupTempDom(`mermaid_diag_${uniqueId}_${renderCounter.current}`);
        }
      } finally {
        // 兜底清理 document.body 下遗留的 Mermaid 临时 DOM 节点
        cleanupTempDom(elementId);
      }
    },
    [isDark, uniqueId]
  );

  // 计算 contain 适配比例与重置居中
  const fitToViewport = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const svg = container.querySelector("svg");
    if (!svg) return;

    let svgWidth = 800;
    let svgHeight = 600;

    const vb = svg.viewBox?.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
      svgWidth = vb.width;
      svgHeight = vb.height;
    } else {
      const vbAttr = svg.getAttribute("viewBox");
      if (vbAttr) {
        const parts = vbAttr.trim().split(/[\s,]+/).map(Number);
        const w = parts[2];
        const h = parts[3];
        if (parts.length === 4 && typeof w === "number" && w > 0 && typeof h === "number" && h > 0) {
          svgWidth = w;
          svgHeight = h;
        }
      } else {
        const rect = svg.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          svgWidth = rect.width;
          svgHeight = rect.height;
        }
      }
    }

    // 视口容器可用空间（减去 padding，p-6 对应上下各 24px、左右各 24px）
    const paddingX = 48;
    const paddingY = 48;
    const availWidth = Math.max(container.clientWidth - paddingX, 40);
    const availHeight = Math.max(container.clientHeight - paddingY, 40);

    setNaturalSize({ width: svgWidth, height: svgHeight });

    const fitZoom = Math.min(availWidth / svgWidth, availHeight / svgHeight);
    // 初始/自适应取 min(fitZoom, 1)，下限 0.1
    const nextZoom = Math.max(Math.min(fitZoom, 1), 0.1);
    const nextOffset = { x: 0, y: 0 };

    stateRef.current = { zoom: nextZoom, offset: nextOffset };
    setZoom(nextZoom);
    setOffset(nextOffset);
  }, []);

  // 渲染成功后（含 sanitizeMermaid 常规渲染与 repairMermaid 激进重试两条路径）测量真实 SVG 进行自适应 contain 适配
  useEffect(() => {
    if (!svgHtml) return;
    const rafId = requestAnimationFrame(() => {
      fitToViewport();
    });
    return () => cancelAnimationFrame(rafId);
  }, [svgHtml, fitToViewport]);

  // 用 ResizeObserver 监听视口容器尺寸变化，全屏切换或容器形变后自动重新适配
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    let lastWidth = container.clientWidth;
    let lastHeight = container.clientHeight;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (Math.abs(width - lastWidth) > 3 || Math.abs(height - lastHeight) > 3) {
          lastWidth = width;
          lastHeight = height;
          requestAnimationFrame(() => {
            fitToViewport();
          });
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [fitToViewport]);

  useEffect(() => {
    setCode(initialCode);
    renderDiagram(initialCode);
  }, [initialCode, renderDiagram]);

  useEffect(() => {
    renderDiagram(code);
  }, [isDark, renderDiagram]);

  // 缩放操作（以视口中心为基准平滑缩放，最大上限提高到 6.0）
  const handleZoomIn = () => {
    const nextZoom = Math.min(stateRef.current.zoom + 0.2, 6.0);
    const ratio = nextZoom / stateRef.current.zoom;
    const nextOffset = {
      x: stateRef.current.offset.x * ratio,
      y: stateRef.current.offset.y * ratio,
    };
    stateRef.current = { zoom: nextZoom, offset: nextOffset };
    setZoom(nextZoom);
    setOffset(nextOffset);
  };

  const handleZoomOut = () => {
    const nextZoom = Math.max(stateRef.current.zoom - 0.2, 0.2);
    const ratio = nextZoom / stateRef.current.zoom;
    const nextOffset = {
      x: stateRef.current.offset.x * ratio,
      y: stateRef.current.offset.y * ratio,
    };
    stateRef.current = { zoom: nextZoom, offset: nextOffset };
    setZoom(nextZoom);
    setOffset(nextOffset);
  };

  const handleZoomReset = () => {
    stateRef.current = { zoom: 1, offset: { x: 0, y: 0 } };
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  // 鼠标拖拽平移开始
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // 仅响应鼠标左键
    e.preventDefault(); // 阻止默认的文字选择

    isDraggingRef.current = true;
    hasMovedRef.current = false;
    setIsDragging(true);

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startOffsetX: stateRef.current.offset.x,
      startOffsetY: stateRef.current.offset.y,
    };
  };

  // 全局鼠标平移与释放监听，避免甩出容器时丢失状态
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasMovedRef.current = true;
      }

      const nextOffset = {
        x: dragStartRef.current.startOffsetX + dx,
        y: dragStartRef.current.startOffsetY + dy,
      };
      stateRef.current.offset = nextOffset;
      setOffset(nextOffset);
    };

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsDragging(false);
    };

    // 如果发生了拖拽位移，捕获拦截后续 click 事件，避免误触发点击行为
    const handleClickCapture = (e: MouseEvent) => {
      if (hasMovedRef.current) {
        e.stopPropagation();
        e.preventDefault();
        hasMovedRef.current = false;
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("click", handleClickCapture, true);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("click", handleClickCapture, true);
    };
  }, []);

  // 滚轮缩放监听：以当前鼠标指针位置为锚点进行精准中心缩放
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault(); // 阻止浏览器外部页面滚动

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const mouseRelX = mouseX - rect.width / 2;
      const mouseRelY = mouseY - rect.height / 2;

      const { zoom: currentZoom, offset: currentOffset } = stateRef.current;
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      const nextZoom = Math.min(Math.max(currentZoom * zoomFactor, 0.2), 6.0);
      if (Math.abs(nextZoom - currentZoom) < 0.001) return;

      const ratio = nextZoom / currentZoom;
      const nextOffset = {
        x: mouseRelX - (mouseRelX - currentOffset.x) * ratio,
        y: mouseRelY - (mouseRelY - currentOffset.y) * ratio,
      };

      stateRef.current = { zoom: nextZoom, offset: nextOffset };
      setZoom(nextZoom);
      setOffset(nextOffset);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // 复制代码
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 容错降级
    }
  };

  // 重新渲染
  const handleRerender = () => {
    setIsEditing(false);
    renderDiagram(code);
  };

  // 导出 SVG
  const handleExportSvg = () => {
    if (!svgHtml) return;
    const blob = new Blob([svgHtml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${displayTitle.replace(/[\s/\\:*?"<>|]/g, "_")}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 导出 PNG（基于克隆真实 viewBox 尺寸与 Data URL 避免 Canvas Tainted）
  const handleExportPng = () => {
    if (!svgHtml || isExporting) return;
    const container = containerRef.current;
    const svgElement = container?.querySelector("svg");
    if (!svgElement) return;

    setIsExporting(true);
    setExportFailed(false);

    const notifyError = () => {
      setIsExporting(false);
      setExportFailed(true);
      setTimeout(() => setExportFailed(false), 2500);
    };

    try {
      // 1. 导出前克隆当前 SVG：把根节点 width/height 设置为 viewBox 的真实宽高，并移除根节点上的 inline style
      const clonedSvg = svgElement.cloneNode(true) as SVGSVGElement;

      let vbWidth = 800;
      let vbHeight = 600;
      const vb = clonedSvg.viewBox?.baseVal;
      if (vb && vb.width > 0 && vb.height > 0) {
        vbWidth = vb.width;
        vbHeight = vb.height;
      } else {
        const vbAttr = clonedSvg.getAttribute("viewBox");
        if (vbAttr) {
          const parts = vbAttr.trim().split(/[\s,]+/).map(Number);
          const w = parts[2];
          const h = parts[3];
          if (parts.length === 4 && typeof w === "number" && w > 0 && typeof h === "number" && h > 0) {
            vbWidth = w;
            vbHeight = h;
          }
        }
      }

      clonedSvg.setAttribute("width", String(vbWidth));
      clonedSvg.setAttribute("height", String(vbHeight));
      clonedSvg.removeAttribute("style");

      // 2. 用 XMLSerializer 序列化，再以 data URL 作为 img.src（data URL 不会污染 canvas，blob URL 会）
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(clonedSvg);
      const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;

      const img = new Image();
      img.onload = () => {
        try {
          // 3. canvas 按 viewBox 宽高 × 2 创建，先按当前主题填背景色再 drawImage
          const canvas = document.createElement("canvas");
          const scale = 2; // 2x 超清导出
          canvas.width = vbWidth * scale;
          canvas.height = vbHeight * scale;

          const ctx = canvas.getContext("2d");
          if (!ctx) {
            notifyError();
            return;
          }

          ctx.fillStyle = isDark ? "#09090b" : "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          // 4. canvas.toBlob 成功后用 a[download] 触发下载，URL 用完再 revoke
          canvas.toBlob((blob) => {
            if (!blob) {
              notifyError();
              return;
            }
            const pngUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = pngUrl;
            a.download = `${displayTitle.replace(/[\s/\\:*?"<>|]/g, "_")}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(pngUrl);
            setIsExporting(false);
          }, "image/png");
        } catch (err) {
          console.error("Canvas 绘制或导出异常:", err);
          notifyError();
        }
      };

      img.onerror = (err) => {
        console.error("SVG 图像转为图片加载失败:", err);
        notifyError();
      };

      img.src = dataUrl;
    } catch (err) {
      console.error("PNG 导出前置准备失败:", err);
      notifyError();
    }
  };

  return (
    <div
      className={cn(
        "my-3.5 w-full rounded-xl border border-zinc-200/90 bg-white/95 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/90 overflow-hidden transition-all",
        isFullscreen &&
          "fixed inset-0 z-50 m-0 flex flex-col rounded-none border-none bg-white/98 dark:bg-zinc-950/98 backdrop-blur-md",
        className
      )}
    >
      {/* 顶部标题栏 & 操作工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 bg-zinc-50/80 px-3.5 py-2 text-zinc-700 dark:border-zinc-800/80 dark:bg-zinc-900/80 dark:text-zinc-300">
        <div className="flex items-center gap-2 min-w-0">
          <Network className="size-4 shrink-0 text-blue-500" />
          <span className="truncate text-xs font-semibold tracking-wide text-zinc-900 dark:text-zinc-100">
            {displayTitle}
          </span>
          <span className="shrink-0 rounded-md bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 dark:bg-blue-950/50 dark:text-blue-400 border border-blue-200/60 dark:border-blue-800/60">
            {typeLabel}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* 模式切换：预览 / 编辑 */}
          <button
            type="button"
            onClick={() => setIsEditing(!isEditing)}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer",
              isEditing
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300"
                : "text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            )}
            title={isEditing ? "返回图表预览" : "编辑 Mermaid 源码"}
          >
            {isEditing ? <Eye className="size-3.5" /> : <Code2 className="size-3.5" />}
            <span>{isEditing ? "预览" : "源码/编辑"}</span>
          </button>

          {/* 缩放控制器（仅在预览状态显示） */}
          {!isEditing && (
            <div className="flex items-center gap-1">
              <div className="flex items-center rounded-md border border-zinc-200/80 bg-white/80 dark:border-zinc-800 dark:bg-zinc-900/80 px-1">
                <button
                  type="button"
                  onClick={handleZoomOut}
                  disabled={zoom <= 0.2}
                  className="p-1 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 disabled:opacity-40 cursor-pointer"
                  title="缩小 (Zoom Out)"
                >
                  <ZoomOut className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleZoomReset}
                  className="px-1 text-[11px] font-mono text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                  title="重置缩放 (100%)"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  disabled={zoom >= 6.0}
                  className="p-1 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 disabled:opacity-40 cursor-pointer"
                  title="放大 (Zoom In)"
                >
                  <ZoomIn className="size-3.5" />
                </button>
              </div>

              {/* 适应窗口按钮 */}
              <button
                type="button"
                onClick={fitToViewport}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors cursor-pointer"
                title="适应窗口 (Fit to Screen)"
              >
                <Scan className="size-3.5" />
                <span>适应窗口</span>
              </button>
            </div>
          )}

          {/* 复制代码 */}
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors cursor-pointer"
            title="复制 Mermaid 源码"
          >
            {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
            <span className={copied ? "text-emerald-600 dark:text-emerald-400 font-medium" : ""}>
              {copied ? "已复制" : "复制代码"}
            </span>
          </button>

          {/* 导出下拉/按钮 */}
          <button
            type="button"
            onClick={handleExportSvg}
            disabled={!svgHtml}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors cursor-pointer disabled:opacity-40"
            title="导出为矢量图 (.svg)"
          >
            <Download className="size-3.5" />
            <span>SVG</span>
          </button>

          <button
            type="button"
            onClick={handleExportPng}
            disabled={!svgHtml || isExporting}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors cursor-pointer disabled:opacity-40",
              exportFailed
                ? "bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400 font-medium"
                : "text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            )}
            title={exportFailed ? "PNG 导出失败" : "导出为高清图片 (.png)"}
          >
            <ImageIcon className="size-3.5" />
            <span>{isExporting ? "导出中..." : exportFailed ? "导出失败" : "PNG"}</span>
          </button>

          {/* 全屏切换 */}
          <button
            type="button"
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="rounded-md p-1.5 text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors cursor-pointer"
            title={isFullscreen ? "退出全屏" : "全屏查看"}
          >
            {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* 主视图区域 */}
      <div
        className={cn(
          "relative w-full overflow-hidden flex items-center justify-center bg-zinc-50/40 dark:bg-zinc-900/30",
          isFullscreen ? "flex-1" : "h-[440px] min-h-[280px] max-h-[560px]"
        )}
      >
        {isEditing ? (
          /* 源码编辑模式 */
          <div className="flex h-full w-full flex-col p-4 bg-zinc-950 font-mono text-xs">
            <div className="mb-2 flex items-center justify-between text-zinc-400">
              <span className="flex items-center gap-1.5 font-medium">
                <FileCode className="size-4 text-blue-400" />
                编辑 Mermaid 源码 (直接修改实时反映)
              </span>
              <button
                type="button"
                onClick={handleRerender}
                className="flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-500 transition-colors cursor-pointer"
              >
                <RefreshCw className="size-3" />
                重新渲染
              </button>
            </div>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="flex-1 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono text-zinc-100 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              rows={12}
              spellCheck={false}
            />
          </div>
        ) : renderError ? (
          /* 语法/渲染错误提示 */
          <div className="flex flex-col items-center justify-center p-6 text-center max-w-md">
            <AlertCircle className="size-9 text-rose-500 mb-2" />
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
              Mermaid 图表解析错误
            </h4>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono break-all mb-4">
              {renderError}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 cursor-pointer"
              >
                检查并编辑源码
              </button>
              <button
                type="button"
                onClick={() => {
                  setCode(initialCode);
                  setZoom(1);
                  setOffset({ x: 0, y: 0 });
                  stateRef.current = { zoom: 1, offset: { x: 0, y: 0 } };
                  renderDiagram(initialCode);
                }}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 cursor-pointer"
              >
                恢复初始代码
              </button>
            </div>
          </div>
        ) : (
          /* 可视化渲染展示 */
          <div
            ref={containerRef}
            data-diagram-viewport="true"
            onMouseDown={handleMouseDown}
            className={cn(
              "w-full h-full overflow-hidden flex items-center justify-center p-6 select-none relative",
              isDragging ? "cursor-grabbing" : "cursor-grab"
            )}
          >
            <div
              className={cn(
                "origin-center select-none flex items-center justify-center [&>svg]:max-w-none [&>svg]:w-full [&>svg]:h-full will-change-transform",
                isDragging ? "transition-none" : "transition-transform duration-100 ease-out"
              )}
              style={{
                width: naturalSize ? `${naturalSize.width}px` : "auto",
                height: naturalSize ? `${naturalSize.height}px` : "auto",
                transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`,
              }}
              dangerouslySetInnerHTML={{ __html: svgHtml }}
            />
          </div>
        )}
      </div>
    </div>
  );
};
