import { describe, expect, it } from "vitest";
import { computeFileDiff } from "../src/diff.js";

describe("computeFileDiff", () => {
  it("全新文件：所有行记为新增", () => {
    const diff = computeFileDiff(null, "a\nb\nc");
    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(0);
    expect(diff.patch).toContain("+a");
    expect(diff.patch).toContain("@@");
  });

  it("删除文件：所有行记为删除", () => {
    const diff = computeFileDiff("a\nb", null);
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(2);
    expect(diff.patch).toContain("-a");
    expect(diff.patch).toContain("-b");
  });

  it("无变化：零差异且 patch 为空", () => {
    const diff = computeFileDiff("same\nlines", "same\nlines");
    expect(diff.additions).toBe(0);
    expect(diff.deletions).toBe(0);
    expect(diff.patch).toBe("");
    expect(diff.truncated).toBe(false);
  });

  it("局部修改：只统计变化的行并保留上下文", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const before = long.join("\n");
    const after = long.map((l, i) => (i === 9 ? "line10-changed" : l)).join("\n");
    const diff = computeFileDiff(before, after);
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.patch).toContain("-line10");
    expect(diff.patch).toContain("+line10-changed");
    // 上下文行以空格为前缀
    expect(diff.patch).toContain(" line9");
    // 距离变更超过 3 行上下文的内容不进 patch
    expect(diff.patch).not.toContain("line20");
  });

  it("同时有新增与删除：分别计数", () => {
    const before = "keep\nremove-a\nremove-b\nkeep2";
    const after = "keep\nadd-a\nadd-b\nadd-c\nkeep2";
    const diff = computeFileDiff(before, after);
    expect(diff.additions).toBe(3);
    expect(diff.deletions).toBe(2);
  });

  it("超大规模文本退化为整段替换，统计仍准确", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old-${i}`).join("\n");
    const after = Array.from({ length: 2500 }, (_, i) => `new-${i}`).join("\n");
    const diff = computeFileDiff(before, after);
    expect(diff.deletions).toBe(3000);
    expect(diff.additions).toBe(2500);
  });

  it("patch 超过行数上限时截断并标记", () => {
    const before = Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n");
    const after = Array.from({ length: 300 }, (_, i) => `changed-${i}`).join("\n");
    const diff = computeFileDiff(before, after, 50);
    expect(diff.truncated).toBe(true);
    expect(diff.patch.split("\n").length).toBeLessThanOrEqual(50);
    // 统计不受截断影响
    expect(diff.additions).toBe(300);
    expect(diff.deletions).toBe(300);
  });
});
