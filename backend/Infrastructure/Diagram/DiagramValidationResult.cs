using System.Text.Json.Serialization;

namespace MafHarnessDemo.App.Infrastructure.Diagram;

/// <summary>
/// 图表代码语法校验结果
/// </summary>
public sealed class DiagramValidationResult
{
    [JsonPropertyName("isValid")]
    public bool IsValid { get; set; } = true;

    [JsonPropertyName("errorMessage")]
    public string? ErrorMessage { get; set; }

    [JsonPropertyName("warnings")]
    public List<string> Warnings { get; set; } = [];
}
