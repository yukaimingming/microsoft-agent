namespace MafHarnessDemo.App.Infrastructure.FileStore;

/// <summary>一次成功写入的旧内容与新内容；旧内容为空引用代表新建文件。</summary>
public sealed record FileChange(string Path, string? Before, string After);
