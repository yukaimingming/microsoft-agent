/**
 * Mermaid 语法自动清洗与容错修复器
 * 针对 LLM 生成 Mermaid 代码时高频出现的语法瑕疵进行确定性修复，
 * 做到“能修好就正常渲染，修不好才提示”。
 */

interface ShapeDef {
  open: string;
  close: string;
}

// 常见节点形状定界符（双字符优先，避免误匹配）
const SHAPES: ShapeDef[] = [
  { open: "([", close: "])" },
  { open: "[[", close: "]]" },
  { open: "[(", close: ")]" },
  { open: "((", close: "))" },
  { open: "{{", close: "}}" },
  { open: "[/", close: "/]" },
  { open: "[\\", close: "\\]" },
  { open: "[/", close: "\\]" },
  { open: "[\\", close: "/]" },
  { open: ">", close: "]" },
  { open: "[", close: "]" },
  { open: "(", close: ")" },
  { open: "{", close: "}" },
];

// 需要双引号包裹的特殊字符特征（冒号、括号、分号、井号、斜杠、减号、逗号、空格、问号等）
const SPECIAL_CHARS_REGEX = /[:：();#\/\\,\-+\s&|?!=><]/;

// 已知的图表类型声明关键字
const KNOWN_HEADERS = [
  "flowchart",
  "graph",
  "sequencediagram",
  "statediagram",
  "statediagram-v2",
  "classdiagram",
  "erdiagram",
  "architecture-beta",
  "architecture",
  "gantt",
  "mindmap",
  "gitgraph",
  "c4context",
  "c4container",
  "c4component",
  "pie",
  "journey",
  "timeline",
];

// 纯箭头连线识别正则
const IS_STANDALONE_ARROW = /^(\s*[-.=~]+>|\s*<[-.=~]+|\s*[-.=~]{2,}|\s*-->|\s*-\.->|\s*==>|\s*->>|\s*-->>)\s*$/;

/**
 * 判断某行是否为图表声明头部
 */
function isHeaderLine(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  const firstToken = trimmed.split(/[\s\t]+/)[0] || "";
  return KNOWN_HEADERS.includes(firstToken);
}

/**
 * 清理 Markdown 围栏、BOM 和多余首尾空白
 */
function cleanFencesAndBOM(code: string): string {
  if (!code) return "";
  let cleaned = code.replace(/^\uFEFF/, "").replace(/^\uFFFE/, "").trim();

  // 剥离开头的 ```mermaid / ```
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline !== -1) {
      cleaned = cleaned.slice(firstNewline + 1);
    } else {
      cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*/, "");
    }
  }

  // 剥离结尾的 ```
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3).trimEnd();
  }

  return cleaned.trim();
}

/**
 * 对节点标签补齐双引号并安全转义内部双引号
 */
function quoteLabelIfNeeded(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '""';

  // 已由双引号完整包裹
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed;
  }

  // 包含特殊字符或空格，补齐双引号
  if (SPECIAL_CHARS_REGEX.test(trimmed)) {
    const safeContent = trimmed.replace(/"/g, "#quot;");
    return `"${safeContent}"`;
  }

  return trimmed;
}

/**
 * 清洗节点 ID 中的空格与非法字符
 * 例如 "D Start" -> "DStart"
 */
function cleanNodeId(rawId: string): string {
  // 去除所有空白字符
  const noSpace = rawId.replace(/\s+/g, "");
  return noSpace || "Node";
}

/**
 * 尝试从端点字符串中解析出 ID、定界符与标签
 * 关键规则：开定界符必须是端点中最早出现的形状符号
 */
function parseEndpoint(endpointStr: string): {
  id: string;
  shape?: ShapeDef;
  label?: string;
  leadingSpace: string;
  trailingSpace: string;
} {
  const leadingMatch = endpointStr.match(/^(\s*)/);
  const trailingMatch = endpointStr.match(/(\s*)$/);
  const leadingSpace = leadingMatch ? leadingMatch[1] ?? "" : "";
  const trailingSpace = trailingMatch ? trailingMatch[1] ?? "" : "";
  const trimmed = endpointStr.trim();

  // 寻找在 trimmed 中最早出现的开定界符
  let earliestIdx = -1;
  let matchedShape: ShapeDef | null = null;

  for (const shape of SHAPES) {
    const idx = trimmed.indexOf(shape.open);
    if (idx > 0) {
      if (earliestIdx === -1 || idx < earliestIdx) {
        earliestIdx = idx;
        matchedShape = shape;
      }
    }
  }

  if (earliestIdx > 0 && matchedShape) {
    const closeIdx = trimmed.lastIndexOf(matchedShape.close);
    if (closeIdx > earliestIdx) {
      const idPart = trimmed.slice(0, earliestIdx).trim();
      const labelPart = trimmed.slice(earliestIdx + matchedShape.open.length, closeIdx);
      return {
        id: idPart,
        shape: matchedShape,
        label: labelPart,
        leadingSpace,
        trailingSpace,
      };
    }
  }

  // 无完整形状包裹的纯 ID
  return {
    id: trimmed,
    leadingSpace,
    trailingSpace,
  };
}

/**
 * 将一行拆解为连接符与节点端点
 */
function splitLineIntoSegments(line: string): Array<{ isLink: boolean; text: string }> {
  const segments: Array<{ isLink: boolean; text: string }> = [];
  let cur = "";
  let inParen = 0;
  let inBracket = 0;
  let inBrace = 0;
  let inQuote = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    // 处理引号状态
    if (ch === '"' && (i === 0 || line[i - 1] !== "\\")) {
      inQuote = !inQuote;
      cur += ch;
      i++;
      continue;
    }

    if (inQuote) {
      cur += ch;
      i++;
      continue;
    }

    // 括号嵌套深度
    if (ch === "(") inParen++;
    else if (ch === ")" && inParen > 0) inParen--;
    else if (ch === "[") inBracket++;
    else if (ch === "]" && inBracket > 0) inBracket--;
    else if (ch === "{") inBrace++;
    else if (ch === "}" && inBrace > 0) inBrace--;

    // 当且仅当处于顶层时，检测连接符
    if (inParen === 0 && inBracket === 0 && inBrace === 0) {
      // 检查带标签连线，如 -->|text| 或 -.->|text| 或 ==>|text|
      const linkMatch = line.slice(i).match(/^((?:-->|---\s*|--\s+[^\n-]+\s+-->|-\.->|==>|<-->|~~~)(?:\|[^|\n]+\|)?)/);
      if (linkMatch && linkMatch[1]) {
        if (cur) {
          segments.push({ isLink: false, text: cur });
          cur = "";
        }
        segments.push({ isLink: true, text: linkMatch[1] });
        i += linkMatch[1].length;
        continue;
      }
    }

    cur += ch;
    i++;
  }

  if (cur) {
    segments.push({ isLink: false, text: cur });
  }

  return segments;
}

/**
 * 针对 flowchart/graph 进行结构性清洗
 */
function sanitizeFlowchart(lines: string[]): string[] {
  // Pass 1: 扫描所有端点，收集带空格的节点 ID 映射表
  const idReplacementMap = new Map<string, string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%") || isHeaderLine(line)) continue;
    if (
      trimmed.startsWith("subgraph") ||
      trimmed.startsWith("end") ||
      trimmed.startsWith("classDef") ||
      trimmed.startsWith("style") ||
      trimmed.startsWith("linkStyle") ||
      trimmed.startsWith("click")
    ) {
      continue;
    }

    const segments = splitLineIntoSegments(line);
    for (const seg of segments) {
      if (!seg.isLink) {
        const parsed = parseEndpoint(seg.text);
        if (parsed.id && /\s+/.test(parsed.id)) {
          if (!idReplacementMap.has(parsed.id)) {
            idReplacementMap.set(parsed.id, cleanNodeId(parsed.id));
          }
        }
      }
    }
  }

  // Pass 2: 对每行进行重构替换
  const resultLines: string[] = [];

  for (let line of lines) {
    const trimmed = line.trim();

    // 头部行直接保留
    if (isHeaderLine(line)) {
      resultLines.push(line);
      continue;
    }

    // 过滤纯箭头孤立行
    if (IS_STANDALONE_ARROW.test(trimmed)) {
      continue;
    }

    // 保留注释行
    if (trimmed.startsWith("%%")) {
      resultLines.push(line);
      continue;
    }

    // 处理 subgraph
    if (trimmed.startsWith("subgraph")) {
      let subLine = line.replace(/：/g, ":");
      subLine = subLine.replace(/\[\s*([^"\]\n]*?[:\s()#\/][^"\]\n]*?)\s*\]/g, '["$1"]');
      resultLines.push(subLine);
      continue;
    }

    // 特殊指令行直接保留（归一化冒号）
    if (
      trimmed.startsWith("classDef") ||
      trimmed.startsWith("style") ||
      trimmed.startsWith("linkStyle") ||
      trimmed.startsWith("click") ||
      trimmed === "end" ||
      trimmed.startsWith("direction")
    ) {
      resultLines.push(line.replace(/：/g, ":"));
      continue;
    }

    const segments = splitLineIntoSegments(line);
    const reconstructedSegments: string[] = [];

    for (const seg of segments) {
      if (seg.isLink) {
        // 连接符：将连线标签内的全角冒号归一化
        let linkText = seg.text.replace(/：/g, ":");
        reconstructedSegments.push(linkText);
      } else {
        const parsed = parseEndpoint(seg.text);
        let id = parsed.id;

        // 如果 ID 存在已记录的替换映射
        if (idReplacementMap.has(id)) {
          id = idReplacementMap.get(id)!;
        } else if (/\s+/.test(id)) {
          id = cleanNodeId(id);
        }

        if (parsed.shape && parsed.label !== undefined) {
          // 归一化全角冒号
          const normalizedLabel = parsed.label.replace(/：/g, ":");
          const quotedLabel = quoteLabelIfNeeded(normalizedLabel);
          reconstructedSegments.push(
            `${parsed.leadingSpace}${id}${parsed.shape.open}${quotedLabel}${parsed.shape.close}${parsed.trailingSpace}`
          );
        } else {
          // 纯 ID 端点
          reconstructedSegments.push(`${parsed.leadingSpace}${id}${parsed.trailingSpace}`);
        }
      }
    }

    const newLine = reconstructedSegments.join("");
    resultLines.push(newLine);
  }

  return resultLines;
}

/**
 * 针对时序图 (sequenceDiagram) 的常规修复
 */
function sanitizeSequence(lines: string[]): string[] {
  const result: string[] = [];
  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%") || isHeaderLine(line)) {
      result.push(line);
      continue;
    }

    // 结构位置的全角冒号归一化为半角冒号
    // 1. 箭头消息：Alice->>Bob：你好 -> Alice->>Bob: 你好
    let fixed = line.replace(/((?:->>|-->>|->|-->|-x|--x)\s*[^：:\n]+?)：/g, "$1: ");

    // 2. participant A as 别名：描述 -> participant A as 别名: 描述
    fixed = fixed.replace(/(participant|actor)\s+([^\n：]+?)：/g, "$1 $2: ");

    // 3. Note over / Note left of / Note right of
    fixed = fixed.replace(/(Note\s+(?:over|left of|right of)\s+[^\n：]+?)：/g, "$1: ");

    result.push(fixed);
  }
  return result;
}

/**
 * 常规修复入口：导出函数 sanitizeMermaid
 * 覆盖：
 * a. 残留的 ```mermaid / ``` 围栏、BOM、首尾空白
 * b. flowchart/graph 里节点 ID 含空格或非法字符（例如 "D Start(..." 变成 "DStart(...)"）
 * c. 节点标签含 括号/冒号/分号/井号/斜杠 等特殊字符但没用双引号包裹 → 自动补双引号
 * d. 结构位置的全角冒号 "：" 归一化为半角冒号
 * e. 行内多余的反引号、孤立的箭头残留
 */
export function sanitizeMermaid(code: string): string {
  if (!code || typeof code !== "string") return "";

  // 1. 清理代码围栏、BOM、首尾空白
  let cleaned = cleanFencesAndBOM(code);
  if (!cleaned) return "";

  // 2. 清理行内多余的反引号（如 `NodeA` -> NodeA），保留反引号围栏外的多余反引号
  cleaned = cleaned.replace(/`([^`\n]+)`/g, "$1").replace(/`/g, "");

  const rawLines = cleaned.split(/\r?\n/);
  const firstNonEmptyLine = rawLines.find((l) => l.trim().length > 0 && !l.trim().startsWith("%%")) || "";
  const firstToken = firstNonEmptyLine.trim().split(/[\s\t(]+/)[0]?.toLowerCase() || "";

  let processedLines: string[];

  if (firstToken === "flowchart" || firstToken === "graph" || !firstToken) {
    processedLines = sanitizeFlowchart(rawLines);
  } else if (firstToken === "sequencediagram") {
    processedLines = sanitizeSequence(rawLines);
  } else {
    // 状态图、类图、甘特图等通用处理
    processedLines = rawLines
      .filter((l) => !IS_STANDALONE_ARROW.test(l.trim()))
      .map((l) => (isHeaderLine(l) ? l : l.replace(/：/g, ":")));
  }

  // 3. 如果缺少合法图表类型声明头部，自动补充默认头部
  const finalCheckFirstLine = processedLines.find((l) => l.trim().length > 0 && !l.trim().startsWith("%%")) || "";
  const finalFirstToken = finalCheckFirstLine.trim().split(/[\s\t(]+/)[0]?.toLowerCase() || "";

  if (!KNOWN_HEADERS.includes(finalFirstToken)) {
    const allText = processedLines.join("\n");
    if (allText.includes("->>") || allText.includes("participant")) {
      processedLines.unshift("sequenceDiagram");
    } else {
      processedLines.unshift("flowchart TD");
    }
  }

  return processedLines.join("\n").trim();
}

/**
 * 激进重试版修复：导出函数 repairMermaid
 * 在常规修复的基础上执行深度结构修补：
 * 1. 括号与引号强行配平闭合
 * 2. 剔除无效破损行
 * 3. 严格兜底合法头部
 */
export function repairMermaid(code: string): string {
  if (!code || typeof code !== "string") return "flowchart TD\n  Start[\"开始\"] --> End[\"结束\"]";

  // 预先修复行尾未闭合的括号与标签
  const rawCleaned = cleanFencesAndBOM(code);
  const rawLines = rawCleaned.split(/\r?\n/);
  const preRepairedLines: string[] = [];

  for (let line of rawLines) {
    let l = line;
    // 针对 A[未闭合内容 这种未闭合标签进行自动闭合
    const unclosedBracket = l.match(/^(\s*[a-zA-Z0-9_\s]+)\[([^\]\n]+)$/);
    if (unclosedBracket && unclosedBracket[1] !== undefined && unclosedBracket[2] !== undefined) {
      l = `${unclosedBracket[1]}["${unclosedBracket[2].trim()}"]`;
    }
    const unclosedParen = l.match(/^(\s*[a-zA-Z0-9_\s]+)\(([^)\n]+)$/);
    if (unclosedParen && unclosedParen[1] !== undefined && unclosedParen[2] !== undefined) {
      l = `${unclosedParen[1]}("${unclosedParen[2].trim()}")`;
    }
    const unclosedBrace = l.match(/^(\s*[a-zA-Z0-9_\s]+)\{([^}\n]+)$/);
    if (unclosedBrace && unclosedBrace[1] !== undefined && unclosedBrace[2] !== undefined) {
      l = `${unclosedBrace[1]}("{"${unclosedBrace[2].trim()}"}")`;
    }
    preRepairedLines.push(l);
  }

  // 过一遍常规修复
  const sanitized = sanitizeMermaid(preRepairedLines.join("\n"));
  const lines = sanitized.split("\n");
  const repairedLines: string[] = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("%%") || isHeaderLine(line)) {
      repairedLines.push(line);
      continue;
    }

    // 剔除破损的孤立连线
    if (/^[-.=~]+>$/.test(trimmed) || /^<[-.=~]+$/.test(trimmed)) {
      continue;
    }

    // 括号与引号强行配平
    let openBrackets = 0;
    let openParens = 0;
    let openBraces = 0;
    let quoteCount = 0;

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && (i === 0 || line[i - 1] !== "\\")) {
        quoteCount++;
      } else if (c === "[") openBrackets++;
      else if (c === "]") openBrackets = Math.max(0, openBrackets - 1);
      else if (c === "(") openParens++;
      else if (c === ")") openParens = Math.max(0, openParens - 1);
      else if (c === "{") openBraces++;
      else if (c === "}") openBraces = Math.max(0, openBraces - 1);
    }

    if (quoteCount % 2 !== 0) {
      line += '"';
    }
    while (openBraces > 0) {
      line += "}";
      openBraces--;
    }
    while (openParens > 0) {
      line += ")";
      openParens--;
    }
    while (openBrackets > 0) {
      line += "]";
      openBrackets--;
    }

    repairedLines.push(line);
  }

  // 保证至少有合法头部
  const firstValidLine = repairedLines.find((l) => !l.trim().startsWith("%%")) || "";
  const firstToken = firstValidLine.trim().split(/[\s\t]+/)[0]?.toLowerCase() || "";
  if (!KNOWN_HEADERS.includes(firstToken)) {
    repairedLines.unshift("flowchart TD");
  }

  return repairedLines.join("\n").trim();
}
