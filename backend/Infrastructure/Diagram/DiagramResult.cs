using System.Text.Json.Serialization;

namespace MafHarnessDemo.App.Infrastructure.Diagram;

/// <summary>
/// 图表生成与操作返回结果
/// </summary>
public sealed class DiagramResult
{
    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("description")]
    public string Description { get; set; } = string.Empty;

    [JsonPropertyName("mermaidCode")]
    public string MermaidCode { get; set; } = string.Empty;

    [JsonPropertyName("validationResult")]
    public DiagramValidationResult ValidationResult { get; set; } = new();
}
