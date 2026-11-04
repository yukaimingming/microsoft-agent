import { describe, expect, it } from "vitest";
import { sanitizeMermaid, repairMermaid } from "../src/features/chat/mermaid-sanitizer.js";

describe("Mermaid Sanitizer 语法清洗与自动修复测试", () => {
  it("用例 a：清理残留代码围栏、BOM 与首尾空白", () => {
    const rawCode = "\uFEFF```mermaid\nflowchart TD\n  A --> B\n```\n   ";
    const sanitized = sanitizeMermaid(rawCode);
    expect(sanitized).toBe("flowchart TD\n  A --> B");
  });

  it("用例 b：flowchart 中节点 ID 含空格自动清洗为合法 ID，并在全文中保持前后一致", () => {
    const rawCode = `flowchart TD
  D Start(开始节点)
  D Start --> B
  B --> D Start`;
    const sanitized = sanitizeMermaid(rawCode);
    expect(sanitized).toContain("DStart");
    expect(sanitized).not.toContain("D Start");
    expect(sanitized).toContain("DStart --> B");
    expect(sanitized).toContain("B --> DStart");
  });

  it("用例 c：节点标签含特殊字符（冒号、分号、井号、斜杠、括号）自动补双引号包裹", () => {
    const rawCode = `flowchart TD
  A[开始: 每分析]
  B(状态 / 分发; #1)
  C{是否通过 (初审)?}`;
    const sanitized = sanitizeMermaid(rawCode);
    expect(sanitized).toContain('A["开始: 每分析"]');
    expect(sanitized).toContain('B("状态 / 分发; #1")');
    expect(sanitized).toContain('C{"是否通过 (初审)?"}');
  });

  it("用例 d：结构位置全角冒号 '：' 归一化为半角冒号 ':'", () => {
    const sequenceCode = `sequenceDiagram
  Alice->>Bob：你好
  Bob-->>Alice：收到请求`;
    const sanitized = sanitizeMermaid(sequenceCode);
    expect(sanitized).toContain("Alice->>Bob: 你好");
    expect(sanitized).toContain("Bob-->>Alice: 收到请求");
    expect(sanitized).not.toContain("：");
  });

  it("用例 e：清理行内多余反引号与孤立箭头残留", () => {
    const rawCode = `flowchart TD
  \`NodeA\` --> \`NodeB\`
  -->
  NodeB --> NodeC`;
    const sanitized = sanitizeMermaid(rawCode);
    expect(sanitized).toContain("NodeA --> NodeB");
    expect(sanitized).toContain("NodeB --> NodeC");
    expect(sanitized).not.toContain("`");
    // 孤立的单一箭头行应当被移除
    const lines = sanitized.split("\n").map((l) => l.trim());
    expect(lines).not.toContain("-->");
  });

  it("用例 f：典型错误代码真实场景修复 (用户复现用例)", () => {
    const typicalError = `flowchart TD
  D Start(开始: 每分析 - 1)
  A --> B`;
    const sanitized = sanitizeMermaid(typicalError);
    // 节点 ID 中空格被去除，标签含冒号和破折号自动加双引号包裹
    expect(sanitized).toContain('DStart("开始: 每分析 - 1")');
    expect(sanitized).toContain("A --> B");
    expect(sanitized).not.toContain("D Start(");
  });

  it("用例 g：已有双引号包裹的合法代码保持原样，不重复包裹", () => {
    const validCode = `flowchart TD
  A["样本采集 (Collection)"] --> B["样本前处理 & 贴码条"]`;
    const sanitized = sanitizeMermaid(validCode);
    expect(sanitized).toBe(validCode);
  });

  it("用例 h：激进修复 repairMermaid 能补齐未闭合的括号与引号", () => {
    const brokenCode = `flowchart TD
  A[未闭合的标签内容`;
    const repaired = repairMermaid(brokenCode);
    expect(repaired).toContain("]");
    expect(repaired).toContain('A["未闭合的标签内容"]');
  });
});
