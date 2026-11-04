namespace MafHarnessDemo.App.Infrastructure.Diagram;

/// <summary>
/// 支持的 Mermaid 图表类型枚举
/// </summary>
public enum DiagramType
{
    Flowchart,
    Sequence,
    State,
    ClassDiagram,
    ErDiagram,
    Architecture,
    Gantt,
    Mindmap,
    C4,
    GitGraph
}

public static class DiagramTypeExtensions
{
    public static string ToMermaidKeyword(this DiagramType type) => type switch
    {
        DiagramType.Flowchart => "flowchart TD",
        DiagramType.Sequence => "sequenceDiagram",
        DiagramType.State => "stateDiagram-v2",
        DiagramType.ClassDiagram => "classDiagram",
        DiagramType.ErDiagram => "erDiagram",
        DiagramType.Architecture => "architecture-beta",
        DiagramType.Gantt => "gantt",
        DiagramType.Mindmap => "mindmap",
        DiagramType.C4 => "C4Context",
        DiagramType.GitGraph => "gitGraph",
        _ => "flowchart TD"
    };

    public static string ToDisplayName(this DiagramType type) => type switch
    {
        DiagramType.Flowchart => "流程图 (Flowchart)",
        DiagramType.Sequence => "时序图 (Sequence Diagram)",
        DiagramType.State => "状态机图 (State Diagram)",
        DiagramType.ClassDiagram => "类图 (Class Diagram)",
        DiagramType.ErDiagram => "实体关系图 (ER Diagram)",
        DiagramType.Architecture => "架构图 (Architecture Diagram)",
        DiagramType.Gantt => "甘特图 (Gantt)",
        DiagramType.Mindmap => "思维导图 (Mindmap)",
        DiagramType.C4 => "C4 架构图 (C4 Model)",
        DiagramType.GitGraph => "Git 分支图 (Git Graph)",
        _ => "流程图 (Flowchart)"
    };

    public static string ToTypeIdentifier(this DiagramType type) => type switch
    {
        DiagramType.Flowchart => "flowchart",
        DiagramType.Sequence => "sequence",
        DiagramType.State => "state",
        DiagramType.ClassDiagram => "class",
        DiagramType.ErDiagram => "er",
        DiagramType.Architecture => "architecture",
        DiagramType.Gantt => "gantt",
        DiagramType.Mindmap => "mindmap",
        DiagramType.C4 => "c4",
        DiagramType.GitGraph => "gitGraph",
        _ => "flowchart"
    };

    public static DiagramType Parse(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return DiagramType.Flowchart;
        var s = input.Trim().ToLowerInvariant();
        if (s.Contains("sequence") || s.Contains("时序") || s.Contains("序列")) return DiagramType.Sequence;
        if (s.Contains("state") || s.Contains("状态")) return DiagramType.State;
        if (s.Contains("class") || s.Contains("类图")) return DiagramType.ClassDiagram;
        if (s.Contains("er") || s.Contains("实体") || s.Contains("关系")) return DiagramType.ErDiagram;
        if (s.Contains("arch") || s.Contains("架构") || s.Contains("拓扑")) return DiagramType.Architecture;
        if (s.Contains("gantt") || s.Contains("甘特")) return DiagramType.Gantt;
        if (s.Contains("mind") || s.Contains("思维导图") || s.Contains("脑图")) return DiagramType.Mindmap;
        if (s.Contains("c4")) return DiagramType.C4;
        if (s.Contains("git")) return DiagramType.GitGraph;
        return DiagramType.Flowchart;
    }
}
