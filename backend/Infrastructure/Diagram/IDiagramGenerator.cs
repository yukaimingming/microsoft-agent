namespace MafHarnessDemo.App.Infrastructure.Diagram;

/// <summary>
/// 图表生成与校验核心服务接口
/// </summary>
public interface IDiagramGenerator
{
    /// <summary>
    /// 根据自然语言需求与可选的已有源码，生成或修改 Mermaid 图表
    /// </summary>
    Task<DiagramResult> GenerateAsync(
        string type,
        string description,
        string? sourceCode = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// 校验给定的 Mermaid 代码语法与安全性
    /// </summary>
    DiagramValidationResult Validate(string mermaidCode);
}
