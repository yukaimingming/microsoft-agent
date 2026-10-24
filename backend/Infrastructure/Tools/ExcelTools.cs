using System.ComponentModel;
using System.Text;
using ClosedXML.Excel;
using Microsoft.Extensions.AI;
using MafHarnessDemo.App.Infrastructure.FileStore;

namespace MafHarnessDemo.App.Infrastructure.Tools;

/// <summary>
/// Excel 解析工具——和 PDF 一样，内置 file_access_* 是纯文本语义，
/// 读 .xlsx（本质是 zip 包的 XML）只有乱码。本工具用 ClosedXML 把工作表
/// 内容转成 Markdown 表格文本交给模型分析。
///
/// 路径先经 FilePathNormalizer 归一成 .NET 形态——模型被教成用无冒号路径
/// （E/x.xlsx），直接喂给 File.Exists 会“文件不存在”。
/// </summary>
public sealed class ExcelTools
{
    /// <summary>单次提取的字符上限，防止大表读爆上下文。</summary>
    private const int MaxChars = 32 * 1024;

    private readonly string? _defaultDrive;
    private readonly string? _workspaceRoot;

    public ExcelTools(string? defaultDrive = null, string? workspaceRoot = null)
    {
        _defaultDrive = defaultDrive;
        _workspaceRoot = workspaceRoot;
    }

    [Description("读取 Excel (.xlsx) 文件的工作表内容，转成 Markdown 表格。"
               + "用于分析通道号表、报表、清单等表格数据。.xls 老格式不支持。")]
    public string ReadExcel(
        [Description("Excel 文件路径，任意形态都可以：E:/a/x.xlsx、E:\\a\\x.xlsx、E/a/x.xlsx")] string path,
        [Description("工作表名；省略则读第一个工作表")] string? sheet = null,
        [Description("最多读取多少行数据（不含表头），默认 100")] int maxRows = 100)
    {
        if (string.IsNullOrWhiteSpace(path))
            return "错误：路径不能为空";

        string systemPath;
        try
        {
            systemPath = FilePathNormalizer.ToSystemPath(path, _defaultDrive, _workspaceRoot);
        }
        catch (ArgumentException ex)
        {
            return $"错误：{ex.Message}";
        }

        if (!File.Exists(systemPath))
            return $"错误：文件不存在：{path}";

        var rowsToRead = maxRows <= 0 ? 100 : Math.Min(maxRows, 1000);

        try
        {
            using var workbook = new XLWorkbook(systemPath);

            IXLWorksheet worksheet;
            if (!string.IsNullOrWhiteSpace(sheet))
            {
                if (!workbook.TryGetWorksheet(sheet, out var found))
                    return $"错误：工作表 '{sheet}' 不存在。可用工作表：{string.Join("、", workbook.Worksheets.Select(w => w.Name))}";
                worksheet = found;
            }
            else
            {
                worksheet = workbook.Worksheets.First();
            }

            var usedRange = worksheet.RangeUsed();
            if (usedRange is null)
                return $"工作表 '{worksheet.Name}' 是空的。";

            var totalRows = usedRange.RowCount();
            var builder = new StringBuilder();
            builder.AppendLine($"文件：{path}｜工作表：{worksheet.Name}｜共 {totalRows} 行 × {usedRange.ColumnCount()} 列");
            if (totalRows > rowsToRead + 1)
                builder.AppendLine($"（数据量大，本次只读前 {rowsToRead} 行，可加大 maxRows 或换 sheet）");

            var rowIndex = 0;
            foreach (var row in usedRange.Rows())
            {
                rowIndex++;
                if (rowIndex > rowsToRead + 1) break;

                var cells = row.CellsUsed().Select(c => c.GetString().Replace("|", "\\|").Trim()).ToList();
                if (cells.Count == 0) continue;

                builder.AppendLine("| " + string.Join(" | ", cells) + " |");

                // 第一行当表头，补一道 Markdown 分隔线
                if (rowIndex == 1)
                {
                    builder.AppendLine("|" + string.Join("|", cells.Select(_ => " --- ")) + "|");
                }
            }

            var content = builder.ToString();
            return content.Length > MaxChars ? content[..MaxChars] + "\n……（内容超长已截断）" : content;
        }
        catch (Exception ex)
        {
            return $"错误：Excel 解析失败：{ex.Message}";
        }
    }

    public IEnumerable<AITool> AsAiTools() =>
    [
        AIFunctionFactory.Create(this.ReadExcel),
    ];
}
