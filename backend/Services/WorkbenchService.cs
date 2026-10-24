using System.Text.Json;
using MafHarness.Web.Models;

namespace MafHarness.Web.Services;

public sealed class WorkbenchService
{
    private readonly string _storageDir;
    private readonly string _indexPath;
    private readonly string _sessionsDir;

    private static readonly System.Text.Encoding Utf8NoBom = new System.Text.UTF8Encoding(false);

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
        WorkbenchIndex index = new();
        if (File.Exists(_indexPath))
        {
            try
            {
                var content = File.ReadAllText(_indexPath);
                index = JsonSerializer.Deserialize<WorkbenchIndex>(content) ?? new WorkbenchIndex();
            }
            catch { }
        }

        // 强保证：自动同步磁盘上的所有真实历史会话，彻底剔除磁盘已不存在的幽灵记录
        try
        {
            var existingMap = index.Sessions
                .Where(s => !s.Id.StartsWith("test-", StringComparison.OrdinalIgnoreCase) && !s.Id.StartsWith("verify-", StringComparison.OrdinalIgnoreCase))
                .ToDictionary(s => s.Id, s => s, StringComparer.OrdinalIgnoreCase);

            if (Directory.Exists(_sessionsDir))
            {
                var sessionFiles = Directory.GetFiles(_sessionsDir, "*.json");
                var validDiskIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var file in sessionFiles)
                {
                    var fname = Path.GetFileNameWithoutExtension(file);
                    if (fname.StartsWith("test-", StringComparison.OrdinalIgnoreCase) || fname.StartsWith("verify-", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    validDiskIds.Add(fname);

                    try
                    {
                        var json = File.ReadAllText(file);
                        using var doc = JsonDocument.Parse(json);
                        var root = doc.RootElement;
                        var title = "新对话";
                        long createdAt = 0;
                        long updatedAt = 0;
                        int msgCount = 0;

                        if (root.TryGetProperty("messages", out var msgs) && msgs.ValueKind == JsonValueKind.Array)
                        {
                            msgCount = msgs.GetArrayLength();
                            foreach (var m in msgs.EnumerateArray())
                            {
                                if (createdAt == 0 && m.TryGetProperty("createdAt", out var ca) && ca.TryGetInt64(out var caVal))
                                    createdAt = caVal;
                                if (m.TryGetProperty("createdAt", out var ua) && ua.TryGetInt64(out var uaVal) && uaVal > updatedAt)
                                    updatedAt = uaVal;
                                if (title == "新对话" && m.TryGetProperty("role", out var role) && role.GetString() == "user"
                                    && m.TryGetProperty("content", out var c) && !string.IsNullOrWhiteSpace(c.GetString()))
                                {
                                    var text = c.GetString()!.Trim();
                                    title = text.Length > 24 ? text.Substring(0, 24) + "…" : text;
                                }
                            }
                        }

                        var fileTime = new DateTimeOffset(File.GetLastWriteTimeUtc(file)).ToUnixTimeMilliseconds();
                        if (createdAt == 0) createdAt = fileTime;
                        if (updatedAt == 0) updatedAt = fileTime;

                        var wsRoot = "";
                        if (root.TryGetProperty("workspaceRoot", out var wsProp) && wsProp.ValueKind == JsonValueKind.String)
                        {
                            wsRoot = wsProp.GetString() ?? "";
                        }

                        if (existingMap.TryGetValue(fname, out var existingSummary))
                        {
                            existingSummary.MessageCount = msgCount;
                            if (string.IsNullOrEmpty(existingSummary.Title) || existingSummary.Title == "新对话") existingSummary.Title = title;
                            if (existingSummary.CreatedAt == 0) existingSummary.CreatedAt = createdAt;
                            if (existingSummary.UpdatedAt == 0) existingSummary.UpdatedAt = updatedAt;
                            if (string.IsNullOrEmpty(existingSummary.WorkspaceRoot)) existingSummary.WorkspaceRoot = wsRoot;
                        }
                        else
                        {
                            existingMap[fname] = new SessionSummary
                            {
                                Id = fname,
                                Title = title,
                                WorkspaceRoot = wsRoot,
                                CreatedAt = createdAt,
                                UpdatedAt = updatedAt,
                                MessageCount = msgCount,
                            };
                        }
                    }
                    catch { }
                }

                // 剔除幽灵会话
                foreach (var id in existingMap.Keys.ToList())
                {
                    if (!validDiskIds.Contains(id))
                    {
                        existingMap.Remove(id);
                    }
                }
            }

            index.Sessions = existingMap.Values.OrderByDescending(s => s.UpdatedAt).ToList();
        }
        catch { }

        return index;
    }

    public void SaveIndex(WorkbenchIndex index)
    {
        try
        {
            var validDiskIds = Directory.Exists(_sessionsDir)
                ? new HashSet<string>(Directory.GetFiles(_sessionsDir, "*.json").Select(Path.GetFileNameWithoutExtension)!, StringComparer.OrdinalIgnoreCase)
                : new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            var current = LoadIndex();
            var incomingMap = index.Sessions
                .Where(s => validDiskIds.Contains(s.Id) && !s.Id.StartsWith("test-", StringComparison.OrdinalIgnoreCase) && !s.Id.StartsWith("verify-", StringComparison.OrdinalIgnoreCase))
                .ToDictionary(s => s.Id, StringComparer.OrdinalIgnoreCase);

            var merged = new List<SessionSummary>();
            foreach (var s in index.Sessions)
            {
                if (!validDiskIds.Contains(s.Id) || s.Id.StartsWith("test-", StringComparison.OrdinalIgnoreCase) || s.Id.StartsWith("verify-", StringComparison.OrdinalIgnoreCase)) continue;
                merged.Add(s);
            }
            foreach (var s in current.Sessions)
            {
                if (validDiskIds.Contains(s.Id) && !incomingMap.ContainsKey(s.Id))
                {
                    merged.Add(s);
                }
            }

            index.Sessions = merged.OrderByDescending(s => s.UpdatedAt).ToList();
            File.WriteAllText(_indexPath, JsonSerializer.Serialize(index, new JsonSerializerOptions { WriteIndented = true }), Utf8NoBom);
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
            File.WriteAllText(path, JsonSerializer.Serialize(state), Utf8NoBom);
        }
        catch { }
    }

    public void DeleteSessionState(string threadId)
    {
        try
        {
            var path = Path.Combine(_sessionsDir, $"{Sanitize(threadId)}.json");
            if (File.Exists(path)) File.Delete(path);

            // 从索引文件中一并移除该会话
            var index = LoadIndex();
            index.Sessions = index.Sessions.Where(s => !string.Equals(s.Id, threadId, StringComparison.OrdinalIgnoreCase)).ToList();
            File.WriteAllText(_indexPath, JsonSerializer.Serialize(index, new JsonSerializerOptions { WriteIndented = true }), Utf8NoBom);
        }
        catch { }
    }

    private static string Sanitize(string id) =>
        string.Concat(id.Select(c => char.IsLetterOrDigit(c) || c == '-' || c == '_' ? c : '_'));
}
