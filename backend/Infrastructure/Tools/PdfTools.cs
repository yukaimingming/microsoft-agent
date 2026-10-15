using System.ComponentModel;
using System.Text;
using Microsoft.Extensions.AI;
using MafHarnessDemo.App.Infrastructure.FileStore;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;

namespace MafHarnessDemo.App.Infrastructure.Tools;

/// <summary>
/// PDF 解析工具——补上 Harness 内置文件能力的短板。
///
/// 内置的 file_access_* 全是纯文本语义，读 PDF 只会拿到二进制乱码
/// （模型实测会报告"无法解析其文本内容"）。本工具用 PdfPig 把 PDF
/// 提取成文本后交给模型分析。
///
/// 路径先经 FilePathNormalizer 归一成 .NET 形态——模型被教成用无冒号路径
/// （E/x.pdf），直接喂给 File.Exists 会"文件不存在"。
/// </summary>
public sealed class PdfTools
{
    /// <summary>单次提取的字符上限，防止一次读爆上下文窗口。</summary>
    private const int MaxChars = 32 * 1024;

    private readonly string _defaultDrive;

    public PdfTools(string defaultDrive = "D") => _defaultDrive = defaultDrive;

    [Description("提取 PDF 文件的文本内容，用于分析 PDF 文档（协议、报告、手册等）。"
               + "扫描版图片型 PDF 提取不出文字，会明确告诉你。")]
    public string ReadPdf(
        [Description("PDF 文件路径，任意盘符都可以，如 E:/仪器协议文档/协议.pdf")] string path,
        [Description("最多提取前几页，默认 20；页数多时分批读")] int maxPages = 20)
    {
        if (string.IsNullOrWhiteSpace(path))
            return "错误：路径不能为空";

        string systemPath;
        try
        {
            systemPath = FilePathNormalizer.ToSystemPath(path, _defaultDrive);
        }
        catch (ArgumentException ex)
        {
            return $"错误：{ex.Message}";
        }

        if (!File.Exists(systemPath))
            return $"错误：文件不存在：{path}";

        var pagesToRead = maxPages <= 0 ? 20 : Math.Min(maxPages, 200);

        try
        {
            using var document = PdfDocument.Open(systemPath);
            var totalPages = document.NumberOfPages;

            var builder = new StringBuilder();
            var extracted = 0;
            var emptyPages = 0;

            foreach (var page in document.GetPages())
            {
                if (extracted >= pagesToRead) break;
                extracted++;

                var text = page.Text;
                if (string.IsNullOrWhiteSpace(text))
                {
                    emptyPages++;
                    continue;
                }

                builder.AppendLine($"── 第 {page.Number} 页 ──");
                builder.AppendLine(text.Trim());
            }

            if (builder.Length == 0)
            {
                return emptyPages > 0
                    ? $"错误：{path} 共 {totalPages} 页，但提取不到任何文字——这是扫描版/图片型 PDF，"
                      + "需要 OCR（不在本工具能力范围内）。"
                    : $"错误：{path} 提取不到文本内容。";
            }

            var content = builder.ToString();
            var truncated = content.Length > MaxChars;
            if (truncated) content = content[..MaxChars];

            var header = $"文件：{path}｜总页数 {totalPages}｜本次提取 {extracted} 页";
            if (totalPages > extracted) header += $"（还有 {totalPages - extracted} 页未读，可加大 maxPages 或分段）";
            if (truncated) header += $"｜内容超长已截断至 {MaxChars / 1024} KB";

            return header + "\n" + content;
        }
        catch (Exception ex)
        {
            return $"错误：PDF 解析失败：{ex.Message}";
        }
    }

    /// <summary>交给 Agent 的工具。MAF 会从 [Description] 生成工具说明。</summary>
    public IEnumerable<AITool> AsAiTools() =>
    [
        AIFunctionFactory.Create(this.ReadPdf),
    ];
}
