using System.Text.Json.Serialization;

namespace MafHarness.Web.Models;

public static class AguiEventType
{
    public const string RUN_STARTED = "RUN_STARTED";
    public const string RUN_FINISHED = "RUN_FINISHED";
    public const string RUN_ERROR = "RUN_ERROR";

    public const string TEXT_MESSAGE_START = "TEXT_MESSAGE_START";
    public const string TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT";
    public const string TEXT_MESSAGE_END = "TEXT_MESSAGE_END";

    public const string REASONING_MESSAGE_START = "REASONING_MESSAGE_START";
    public const string REASONING_MESSAGE_CONTENT = "REASONING_MESSAGE_CONTENT";
    public const string REASONING_MESSAGE_END = "REASONING_MESSAGE_END";

    public const string CUSTOM = "CUSTOM";
    public const string CUSTOM_ACTIVITY = "deepagent:activity";
    public const string CUSTOM_RUN_SNAPSHOT = "deepagent:run-snapshot";
    public const string CUSTOM_PROCESS_MESSAGE = "deepagent:process-message";
}

public sealed class RunAgentInput
{
    [JsonPropertyName("threadId")]
    public string ThreadId { get; set; } = string.Empty;

    [JsonPropertyName("runId")]
    public string RunId { get; set; } = string.Empty;

    [JsonPropertyName("messages")]
    public List<AguiMessage> Messages { get; set; } = [];

    [JsonPropertyName("forwardedProps")]
    public Dictionary<string, object?>? ForwardedProps { get; set; }

    [JsonPropertyName("resume")]
    public List<ResumeEntry>? Resume { get; set; }
}

public sealed class ResumeEntry
{
    [JsonPropertyName("interruptId")]
    public string InterruptId { get; set; } = string.Empty;

    [JsonPropertyName("action")]
    public string? Action { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "resolved"; // resolved or rejected

    [JsonPropertyName("payload")]
    public object? Payload { get; set; }
}

public sealed class AguiMessage
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("role")]
    public string Role { get; set; } = "user";

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("attachments")]
    public List<object>? Attachments { get; set; }

    public string GetTextContent() => Content ?? string.Empty;
}

public sealed class RunSnapshot
{
    [JsonPropertyName("status")]
    public string Status { get; set; } = "running"; // running, waiting_approval, completed, failed

    [JsonPropertyName("runId")]
    public string RunId { get; set; } = string.Empty;

    [JsonPropertyName("threadId")]
    public string ThreadId { get; set; } = string.Empty;

    [JsonPropertyName("startedAt")]
    public long StartedAt { get; set; }

    [JsonPropertyName("endedAt")]
    public long? EndedAt { get; set; }

    [JsonPropertyName("durationMs")]
    public long? DurationMs { get; set; }

    [JsonPropertyName("progressNote")]
    public string? ProgressNote { get; set; }

    [JsonPropertyName("interrupts")]
    public List<InterruptItem> Interrupts { get; set; } = [];

    [JsonPropertyName("usage")]
    public RunUsage? Usage { get; set; }
}

public sealed class RunUsage
{
    [JsonPropertyName("inputTokens")]
    public int? InputTokens { get; set; }

    [JsonPropertyName("outputTokens")]
    public int? OutputTokens { get; set; }
}

public sealed class InterruptItem
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("kind")]
    public string Kind { get; set; } = "tool_approval";

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("input")]
    public object? Input { get; set; }

    public InterruptItem() { }
    public InterruptItem(string id, string kind, string name, object? input)
    {
        Id = id;
        Kind = kind;
        Name = name;
        Input = input;
    }
}

public sealed class Activity
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("kind")]
    public string Kind { get; set; } = "tool"; // tool, file, todo, subagent, approval

    [JsonPropertyName("status")]
    public string Status { get; set; } = "running"; // running, completed, failed, waiting_approval

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("subtitle")]
    public string? Subtitle { get; set; }

    [JsonPropertyName("startedAt")]
    public long StartedAt { get; set; }

    [JsonPropertyName("endedAt")]
    public long EndedAt { get; set; }

    [JsonPropertyName("durationMs")]
    public long DurationMs { get; set; }

    [JsonPropertyName("runId")]
    public string? RunId { get; set; }

    [JsonPropertyName("detail")]
    public object? Detail { get; set; }

    public Activity() { }
    public Activity(string id, string kind, string status, string title, long startedAt)
    {
        Id = id;
        Kind = kind;
        Status = status;
        Title = title;
        StartedAt = startedAt;
    }
}

public sealed class ToolDetail
{
    [JsonPropertyName("name")]
    public string Name { get; set; }

    [JsonPropertyName("input")]
    public object? Input { get; set; }

    [JsonPropertyName("output")]
    public object? Output { get; set; }

    [JsonPropertyName("truncated")]
    public bool Truncated { get; set; }

    public ToolDetail(string name, object? input)
    {
        Name = name;
        Input = input;
    }
}

public sealed class FileDetail
{
    [JsonPropertyName("path")]
    public string Path { get; set; }

    [JsonPropertyName("operation")]
    public string Operation { get; set; } // read, write, edit, delete, list, glob, grep

    [JsonPropertyName("diff")]
    public FileDiff? Diff { get; set; }

    public FileDetail(string path, string operation)
    {
        Path = path;
        Operation = operation;
    }
}

public sealed class TodoDetail
{
    [JsonPropertyName("items")]
    public List<TodoItem> Items { get; set; } = [];

    [JsonPropertyName("completed")]
    public int Completed { get; set; }

    [JsonPropertyName("total")]
    public int Total { get; set; }

    public TodoDetail(List<TodoItem> items, int completed, int total)
    {
        Items = items;
        Completed = completed;
        Total = total;
    }
}

public sealed class TodoItem
{
    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; set; } = "pending"; // pending or completed

    public TodoItem() { }
    public TodoItem(string content, string status)
    {
        Content = content;
        Status = status;
    }
}

public sealed class SubagentDetail
{
    [JsonPropertyName("agent")]
    public string Agent { get; set; }

    [JsonPropertyName("task")]
    public string Task { get; set; }

    [JsonPropertyName("resultSummary")]
    public string? ResultSummary { get; set; }

    public SubagentDetail(string agent, string task)
    {
        Agent = agent;
        Task = task;
    }
}

public sealed class ApprovalDetail
{
    [JsonPropertyName("toolName")]
    public string ToolName { get; set; }

    [JsonPropertyName("arguments")]
    public object? Arguments { get; set; }

    [JsonPropertyName("reason")]
    public string? Reason { get; set; }

    public ApprovalDetail(string toolName, object? arguments, string? reason)
    {
        ToolName = toolName;
        Arguments = arguments;
        Reason = reason;
    }
}

public sealed class FileDiff
{
    [JsonPropertyName("path")]
    public string Path { get; set; }

    [JsonPropertyName("operation")]
    public string Operation { get; set; } // created, modified

    [JsonPropertyName("additions")]
    public int Additions { get; set; }

    [JsonPropertyName("deletions")]
    public int Deletions { get; set; }

    [JsonPropertyName("patch")]
    public string? Patch { get; set; }

    [JsonPropertyName("truncated")]
    public bool Truncated { get; set; }

    [JsonPropertyName("beforeContent")]
    public string? BeforeContent { get; set; }

    [JsonPropertyName("afterContent")]
    public string? AfterContent { get; set; }

    [JsonPropertyName("hunks")]
    public List<DiffHunk> Hunks { get; set; } = [];

    public FileDiff(string path, string operation, int additions, int deletions)
    {
        Path = path;
        Operation = operation;
        Additions = additions;
        Deletions = deletions;
    }

    public sealed class DiffHunk
    {
        [JsonPropertyName("header")]
        public string Header { get; set; }

        [JsonPropertyName("lines")]
        public List<DiffLine> Lines { get; set; }

        public DiffHunk(string header, List<DiffLine> lines)
        {
            Header = header;
            Lines = lines;
        }
    }

    public sealed class DiffLine
    {
        [JsonPropertyName("type")]
        public string Type { get; set; } // add, delete, normal

        [JsonPropertyName("text")]
        public string Text { get; set; }

        [JsonPropertyName("oldLineNumber")]
        public int? OldLineNumber { get; set; }

        [JsonPropertyName("newLineNumber")]
        public int? NewLineNumber { get; set; }

        public DiffLine(string type, string text, int? oldLineNumber, int? newLineNumber)
        {
            Type = type;
            Text = text;
            OldLineNumber = oldLineNumber;
            NewLineNumber = newLineNumber;
        }
    }
}

public sealed class ProviderConfig
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("baseUrl")]
    public string BaseUrl { get; set; } = string.Empty;

    [JsonPropertyName("apiKey")]
    public string ApiKey { get; set; } = string.Empty;

    [JsonPropertyName("defaultModel")]
    public string DefaultModel { get; set; } = string.Empty;

    [JsonPropertyName("models")]
    public List<string> Models { get; set; } = [];

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;
}

public sealed class PublicProvider
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("baseUrl")]
    public string BaseUrl { get; set; } = string.Empty;

    [JsonPropertyName("defaultModel")]
    public string DefaultModel { get; set; } = string.Empty;

    [JsonPropertyName("models")]
    public List<string> Models { get; set; } = [];

    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; }

    [JsonPropertyName("hasApiKey")]
    public bool HasApiKey { get; set; }

    [JsonPropertyName("apiKeyMasked")]
    public string ApiKeyMasked { get; set; } = string.Empty;
}

public sealed class ProviderInput
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("baseUrl")]
    public string? BaseUrl { get; set; }

    [JsonPropertyName("apiKey")]
    public string? ApiKey { get; set; }

    [JsonPropertyName("defaultModel")]
    public string? DefaultModel { get; set; }

    [JsonPropertyName("models")]
    public List<string>? Models { get; set; }

    [JsonPropertyName("enabled")]
    public bool? Enabled { get; set; }
}

public sealed class WorkbenchIndex
{
    [JsonPropertyName("version")]
    public int Version { get; set; } = 1;

    [JsonPropertyName("sessions")]
    public List<SessionSummary> Sessions { get; set; } = [];

    [JsonPropertyName("customWorkspaces")]
    public List<string> CustomWorkspaces { get; set; } = [];

    [JsonPropertyName("activeSessionId")]
    public string ActiveSessionId { get; set; } = string.Empty;

    [JsonPropertyName("currentWorkspace")]
    public string? CurrentWorkspace { get; set; }
}

public sealed class SessionSummary
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;

    [JsonPropertyName("title")]
    public string Title { get; set; } = string.Empty;

    [JsonPropertyName("workspaceRoot")]
    public string WorkspaceRoot { get; set; } = string.Empty;

    [JsonPropertyName("createdAt")]
    public long CreatedAt { get; set; }

    [JsonPropertyName("updatedAt")]
    public long UpdatedAt { get; set; }
}
