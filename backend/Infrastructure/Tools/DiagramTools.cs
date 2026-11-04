using System.ComponentModel;
using Microsoft.Extensions.AI;
using MafHarnessDemo.App.Infrastructure.Diagram;

namespace MafHarnessDemo.App.Infrastructure.Tools;

/// <summary>
/// MAF Agent 图表生成与校验工具集
/// 提供 generate_diagram 与 validate_diagram，让 Agent 具备自然语言绘图、图表修改与语法校验能力。
/// </summary>
public sealed class DiagramTools
{
    private readonly IDiagramGenerator _generator;

    public DiagramTools(IDiagramGenerator generator)
    {
        _generator = generator;
    }

    [Description("根据自然语言需求自动生成或修改 Mermaid 图表（支持流程图、时序图、状态机图、类图、ER图、架构图等）。"
               + "可根据已有源码 sourceCode 进行增量修改或扩展。返回包含 Mermaid 源码和校验状态的图表结果。")]
    public async Task<DiagramResult> generate_diagram(
        [Description("图表类型：flowchart(流程图), sequence(时序图), state(状态机图), class(类图), er(ER图), architecture(架构图), gantt(甘特图), mindmap(思维导图) 等")] string type,
        [Description("图表的自然语言需求或修改说明（例如：绘制医院 LIS 与 MT8000 的通信时序图；或者：在现有时序图中增加数据库节点）")] string description,
        [Description("已有的 Mermaid 源码（如果是在原图基础上修改或扩展，请传入此参数；若是从零开始生成则传 null 或留空）")] string? sourceCode = null,
        CancellationToken cancellationToken = default)
    {
        return await _generator.GenerateAsync(type, description, sourceCode, cancellationToken);
    }

    [Description("校验给定的 Mermaid 代码语法正确性与安全性。")]
    public DiagramValidationResult validate_diagram(
        [Description("待校验的 Mermaid 代码源码")] string mermaidCode)
    {
        return _generator.Validate(mermaidCode);
    }

    public IEnumerable<AITool> AsAiTools() =>
    [
        AIFunctionFactory.Create(this.generate_diagram, nameof(generate_diagram)),
        AIFunctionFactory.Create(this.validate_diagram, nameof(validate_diagram)),
    ];
}
