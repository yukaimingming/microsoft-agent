using System.Text.RegularExpressions;

namespace MafHarnessDemo.App.Infrastructure.Diagram;

/// <summary>
/// Mermaid 图表语法与安全校验器
/// 提供确定性的语法结构检查、闭合检查以及防 XSS/注入安全防护。
/// </summary>
public static class DiagramValidator
{
    private static readonly HashSet<string> ValidHeaderKeywords = new(StringComparer.OrdinalIgnoreCase)
    {
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
        "timeline"
    };

    private static readonly (string Open, string Close)[] Shapes =
    [
        ("([", "])"),
        ("[[", "]]"),
        ("[(", ")]"),
        ("((", "))"),
        ("{{", "}}"),
        ("[/", "/]"),
        (@"[\", @"\]"),
        ("[/", @"\]"),
        (@"[\", "/]"),
        (">", "]"),
        ("[", "]"),
        ("(", ")"),
        ("{", "}")
    ];

    private static readonly Regex SpecialCharsRegex = new(@"[:：();#\/\\,\-+\s&|?!=><]", RegexOptions.Compiled);
    private static readonly Regex ChineseCharRegex = new(@"[\u4e00-\u9fa5]", RegexOptions.Compiled);

    private static readonly string[] DangerousPatterns =
    [
        "<script",
        "javascript:",
        "onerror=",
        "onload=",
        "<iframe",
        "<embed",
        "<object",
        "data:text/html"
    ];

    /// <summary>
    /// 清理代码围栏、BOM 和多余首尾空字符
    /// </summary>
    public static string SanitizeAndClean(string rawMermaidCode)
    {
        if (string.IsNullOrWhiteSpace(rawMermaidCode))
            return string.Empty;

        var cleaned = rawMermaidCode.Trim();

        // 去除 Markdown ```mermaid 代码围栏
        if (cleaned.StartsWith("```", StringComparison.Ordinal))
        {
            var firstLineEnd = cleaned.IndexOf('\n');
            if (firstLineEnd != -1)
            {
                cleaned = cleaned[(firstLineEnd + 1)..];
            }
            else
            {
                cleaned = cleaned.TrimStart('`');
            }
        }

        if (cleaned.EndsWith("```", StringComparison.Ordinal))
        {
            cleaned = cleaned[..^3].TrimEnd();
        }

        // 统一行尾为 \n 并清理每行末尾空格
        var lines = cleaned.Split(["\r\n", "\r", "\n"], StringSplitOptions.None)
                           .Select(l => l.TrimEnd());

        return string.Join("\n", lines).Trim();
    }

    /// <summary>
    /// 对 Mermaid 源码进行全面语法与安全校验
    /// </summary>
    public static DiagramValidationResult Validate(string mermaidCode)
    {
        var result = new DiagramValidationResult();
        var code = SanitizeAndClean(mermaidCode);

        if (string.IsNullOrWhiteSpace(code))
        {
            result.IsValid = false;
            result.ErrorMessage = "Mermaid 图表代码不能为空。";
            return result;
        }

        // 1. 安全防护检查：拦截潜在 XSS 或脚本注入
        foreach (var dangerous in DangerousPatterns)
        {
            if (code.Contains(dangerous, StringComparison.OrdinalIgnoreCase))
            {
                result.IsValid = false;
                result.ErrorMessage = $"检测到潜在的安全威胁字符 '{dangerous}'，已拒绝渲染。";
                return result;
            }
        }

        // 2. 检查有效头部声明（忽略开头的注释行 %%）
        var lines = code.Split('\n', StringSplitOptions.RemoveEmptyEntries)
                        .Select(l => l.Trim())
                        .Where(l => !l.StartsWith("%%", StringComparison.Ordinal))
                        .ToList();

        if (lines.Count == 0)
        {
            result.IsValid = false;
            result.ErrorMessage = "图表代码缺少有效内容。";
            return result;
        }

        var headerLine = lines[0];
        var firstToken = headerLine.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();

        if (!ValidHeaderKeywords.Contains(firstToken))
        {
            result.IsValid = false;
            result.ErrorMessage = $"未识别的 Mermaid 图表类型声明: '{headerLine}'。支持 flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram 等。";
            return result;
        }

        // 3. 括号平衡性检查
        var openBrackets = 0;   // []
        var openParens = 0;     // ()
        var openBraces = 0;     // {}
        var inQuotes = false;

        for (var i = 0; i < code.Length; i++)
        {
            var ch = code[i];

            if (ch == '"' && (i == 0 || code[i - 1] != '\\'))
            {
                inQuotes = !inQuotes;
                continue;
            }

            // 引号内部的括号不参与计算
            if (inQuotes) continue;

            switch (ch)
            {
                case '[': openBrackets++; break;
                case ']': openBrackets--; break;
                case '(': openParens++; break;
                case ')': openParens--; break;
                case '{': openBraces++; break;
                case '}': openBraces--; break;
            }

            if (openBrackets < 0)
            {
                result.IsValid = false;
                result.ErrorMessage = "方括号 ']' 闭合多于开放括号，语法不匹配。";
                return result;
            }
            if (openParens < 0)
            {
                result.IsValid = false;
                result.ErrorMessage = "圆括号 ')' 闭合多于开放括号，语法不匹配。";
                return result;
            }
            if (openBraces < 0)
            {
                result.IsValid = false;
                result.ErrorMessage = "花括号 '}' 闭合多于开放括号，语法不匹配。";
                return result;
            }
        }

        if (openBrackets != 0)
        {
            result.IsValid = false;
            result.ErrorMessage = $"存在未闭合的方括号 '[' (未匹配数量: {openBrackets})。";
            return result;
        }

        if (openParens != 0)
        {
            result.IsValid = false;
            result.ErrorMessage = $"存在未闭合的圆括号 '(' (未匹配数量: {openParens})。";
            return result;
        }

        if (openBraces != 0)
        {
            result.IsValid = false;
            result.ErrorMessage = $"存在未闭合的花括号 '{{' (未匹配数量: {openBraces})。";
            return result;
        }

        if (inQuotes)
        {
            result.Warnings.Add("存在未配对的双引号，可能会影响图表标签渲染。");
        }

        // 4. 节点 ID 空格与中文检测，以及标签特殊字符的双引号包裹检测
        CheckNodeIdsAndLabels(code, result);
        if (!result.IsValid)
        {
            return result;
        }

        result.IsValid = true;
        return result;
    }

    /// <summary>
    /// 校验节点 ID 中是否包含空格或中文，以及标签含特殊字符是否缺少双引号
    /// </summary>
    private static void CheckNodeIdsAndLabels(string code, DiagramValidationResult result)
    {
        var lines = code.Split('\n');
        var firstValidLine = lines.FirstOrDefault(l => !string.IsNullOrWhiteSpace(l) && !l.TrimStart().StartsWith("%%"));
        if (firstValidLine == null) return;

        var firstToken = firstValidLine.Trim().Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();
        if (firstToken != "flowchart" && firstToken != "graph") return;

        foreach (var rawLine in lines)
        {
            var line = rawLine.Trim();
            if (string.IsNullOrWhiteSpace(line) ||
                line.StartsWith("%%") ||
                line.StartsWith("subgraph") ||
                line == "end" ||
                line.StartsWith("classDef") ||
                line.StartsWith("style") ||
                line.StartsWith("linkStyle") ||
                line.StartsWith("click") ||
                line.StartsWith("direction"))
            {
                continue;
            }

            var token0 = line.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();
            if (ValidHeaderKeywords.Contains(token0))
            {
                continue;
            }

            var endpoints = ExtractEndpointsFromLine(line);
            foreach (var ep in endpoints)
            {
                var (id, shape, label) = ParseEndpoint(ep);
                if (string.IsNullOrWhiteSpace(id)) continue;

                // 检测节点 ID 含空格或中文
                if (id.Any(char.IsWhiteSpace) || ChineseCharRegex.IsMatch(id))
                {
                    result.IsValid = false;
                    result.ErrorMessage = $"节点 ID '{id}' 包含空格或中文字符。节点 ID 只允许英文字母、数字和下划线，禁止出现空格和中文。请将中文描述放入标签中。";
                    return;
                }

                // 检测标签含特殊字符但未加双引号
                if (shape.HasValue && label != null)
                {
                    var trimmedLabel = label.Trim();
                    var isQuoted = trimmedLabel.StartsWith('"') && trimmedLabel.EndsWith('"') && trimmedLabel.Length >= 2;
                    if (!isQuoted && SpecialCharsRegex.IsMatch(trimmedLabel))
                    {
                        result.IsValid = false;
                        result.ErrorMessage = $"节点 '{id}' 的标签文本 '{trimmedLabel}' 包含特殊字符但未加双引号包裹。所有包含特殊字符的标签文本必须使用双引号包裹，例如：{id}[\"{trimmedLabel}\"]。";
                        return;
                    }
                }
            }
        }
    }

    /// <summary>
    /// 对不合规的 Mermaid 代码执行自动语法修复
    /// </summary>
    public static string Repair(string rawMermaidCode)
    {
        var cleaned = SanitizeAndClean(rawMermaidCode);
        if (string.IsNullOrWhiteSpace(cleaned)) return string.Empty;

        // 全角冒号归一化为半角冒号
        cleaned = cleaned.Replace("：", ":");

        var lines = cleaned.Split('\n');
        var firstValid = lines.FirstOrDefault(l => !string.IsNullOrWhiteSpace(l) && !l.TrimStart().StartsWith("%%"));
        if (firstValid == null) return cleaned;

        var firstToken = firstValid.Trim().Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();
        if (firstToken != "flowchart" && firstToken != "graph")
        {
            return cleaned;
        }

        // Pass 1: 收集带空格或中文的节点 ID 映射
        var idMap = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var line in lines)
        {
            var trimmed = line.Trim();
            if (string.IsNullOrWhiteSpace(trimmed) || trimmed.StartsWith("%%"))
                continue;

            var t0 = trimmed.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();
            if (ValidHeaderKeywords.Contains(t0)) continue;

            var endpoints = ExtractEndpointsFromLine(trimmed);
            foreach (var ep in endpoints)
            {
                var (id, _, _) = ParseEndpoint(ep);
                if (!string.IsNullOrWhiteSpace(id) && (id.Any(char.IsWhiteSpace) || ChineseCharRegex.IsMatch(id)))
                {
                    if (!idMap.ContainsKey(id))
                    {
                        var cleanId = new string(id.Where(c => !char.IsWhiteSpace(c) && !ChineseCharRegex.IsMatch(c.ToString())).ToArray());
                        if (string.IsNullOrWhiteSpace(cleanId)) cleanId = "Node";
                        idMap[id] = cleanId;
                    }
                }
            }
        }

        // Pass 2: 重构每一行
        var resultLines = new List<string>();
        foreach (var rawLine in lines)
        {
            var trimmed = rawLine.Trim();
            if (string.IsNullOrWhiteSpace(trimmed) || trimmed.StartsWith("%%"))
            {
                resultLines.Add(rawLine);
                continue;
            }

            var t0 = trimmed.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();
            if (ValidHeaderKeywords.Contains(t0))
            {
                resultLines.Add(rawLine);
                continue;
            }

            var lineToProcess = rawLine;
            var endpoints = ExtractEndpointsFromLine(lineToProcess);
            foreach (var ep in endpoints)
            {
                var (id, shape, label) = ParseEndpoint(ep);
                if (string.IsNullOrWhiteSpace(id)) continue;

                var newId = idMap.TryGetValue(id, out var mapped)
                    ? mapped
                    : new string(id.Where(c => !char.IsWhiteSpace(c) && !ChineseCharRegex.IsMatch(c.ToString())).ToArray());
                if (string.IsNullOrWhiteSpace(newId)) newId = "Node";

                if (shape.HasValue && label != null)
                {
                    var trimmedLabel = label.Trim();
                    var isQuoted = trimmedLabel.StartsWith('"') && trimmedLabel.EndsWith('"') && trimmedLabel.Length >= 2;
                    var newLabel = isQuoted ? trimmedLabel : $"\"{trimmedLabel.Replace("\"", "#quot;")}\"";
                    var originalEp = ep.Trim();
                    var replacement = $"{newId}{shape.Value.Open}{newLabel}{shape.Value.Close}";
                    lineToProcess = lineToProcess.Replace(originalEp, replacement);
                }
                else if (idMap.ContainsKey(id))
                {
                    lineToProcess = lineToProcess.Replace(id, newId);
                }
            }

            resultLines.Add(lineToProcess);
        }

        return string.Join("\n", resultLines);
    }

    private static List<string> ExtractEndpointsFromLine(string line)
    {
        var endpoints = new List<string>();
        var cur = new System.Text.StringBuilder();
        var inParen = 0;
        var inBracket = 0;
        var inBrace = 0;
        var inQuote = false;
        var i = 0;

        while (i < line.Length)
        {
            var ch = line[i];
            if (ch == '"' && (i == 0 || line[i - 1] != '\\'))
            {
                inQuote = !inQuote;
                cur.Append(ch);
                i++;
                continue;
            }

            if (inQuote)
            {
                cur.Append(ch);
                i++;
                continue;
            }

            if (ch == '(') inParen++;
            else if (ch == ')' && inParen > 0) inParen--;
            else if (ch == '[') inBracket++;
            else if (ch == ']' && inBracket > 0) inBracket--;
            else if (ch == '{') inBrace++;
            else if (ch == '}' && inBrace > 0) inBrace--;

            if (inParen == 0 && inBracket == 0 && inBrace == 0)
            {
                var remaining = line[i..];
                var match = Regex.Match(remaining, @"^((?:-->|---\s*|--\s+[^\n-]+\s+-->|-\.->|==>|<-->|~~~)(?:\|[^|\n]+\|)?|[-.=~]{2,}>?)");
                if (match.Success && match.Index == 0)
                {
                    if (cur.Length > 0)
                    {
                        endpoints.Add(cur.ToString().Trim());
                        cur.Clear();
                    }
                    i += match.Length;
                    continue;
                }
            }

            cur.Append(ch);
            i++;
        }

        if (cur.Length > 0)
        {
            endpoints.Add(cur.ToString().Trim());
        }

        return endpoints;
    }

    private static (string Id, (string Open, string Close)? Shape, string? Label) ParseEndpoint(string endpoint)
    {
        var trimmed = endpoint.Trim();
        var earliestIdx = -1;
        (string Open, string Close)? matchedShape = null;

        foreach (var shape in Shapes)
        {
            var idx = trimmed.IndexOf(shape.Open, StringComparison.Ordinal);
            if (idx > 0 && (earliestIdx == -1 || idx < earliestIdx))
            {
                earliestIdx = idx;
                matchedShape = shape;
            }
        }

        if (earliestIdx > 0 && matchedShape.HasValue)
        {
            var closeIdx = trimmed.LastIndexOf(matchedShape.Value.Close, StringComparison.Ordinal);
            if (closeIdx > earliestIdx)
            {
                var id = trimmed[..earliestIdx].Trim();
                var label = trimmed[(earliestIdx + matchedShape.Value.Open.Length)..closeIdx];
                return (id, matchedShape, label);
            }
        }

        return (trimmed, null, null);
    }
}
