using System.Text.Json;
using MafHarness.Web.Models;

namespace MafHarness.Web.Services;

public sealed class WorkbenchService
{
    private readonly string _storageDir;
    private readonly string _indexPath;
    private readonly string _sessionsDir;

    public WorkbenchService()
    {
        _storageDir = Path.Combine(AppContext.BaseDirectory, ".data");
        _indexPath = Path.Combine(_storageDir, "workbench.json");
        _sessionsDir = Path.Combine(_storageDir, "workbench_sessions");

        Directory.CreateDirectory(_storageDir);
        Directory.CreateDirectory(_sessionsDir);
    }

    public WorkbenchIndex LoadIndex()
    {
        if (File.Exists(_indexPath))
        {
            try
            {
                var content = File.ReadAllText(_indexPath);
                var index = JsonSerializer.Deserialize<WorkbenchIndex>(content);
                if (index != null) return index;
            }
            catch { }
        }
        return new WorkbenchIndex();
    }

    public void SaveIndex(WorkbenchIndex index)
    {
        try
        {
            File.WriteAllText(_indexPath, JsonSerializer.Serialize(index, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }

    public object? LoadSessionState(string threadId)
    {
        var path = Path.Combine(_sessionsDir, $"{Sanitize(threadId)}.json");
        if (File.Exists(path))
        {
            try
            {
                return JsonSerializer.Deserialize<object>(File.ReadAllText(path));
            }
            catch { }
        }
        return null;
    }

    public void SaveSessionState(string threadId, object state)
    {
        try
        {
            var path = Path.Combine(_sessionsDir, $"{Sanitize(threadId)}.json");
            File.WriteAllText(path, JsonSerializer.Serialize(state));
        }
        catch { }
    }

    public void DeleteSessionState(string threadId)
    {
        try
        {
            var path = Path.Combine(_sessionsDir, $"{Sanitize(threadId)}.json");
            if (File.Exists(path)) File.Delete(path);
        }
        catch { }
    }

    private static string Sanitize(string id) =>
        string.Concat(id.Select(c => char.IsLetterOrDigit(c) || c == '-' || c == '_' ? c : '_'));
}
