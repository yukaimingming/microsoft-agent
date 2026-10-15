using Microsoft.Extensions.AI;
using OpenAI;
using System.ClientModel;
using System.ClientModel.Primitives;
using System.Net.Http.Headers;
using System.Text;

namespace MafHarnessDemo.App.Configuration;

/// <summary>
/// LLM 接入配置。刻意做成「任何 OpenAI 兼容网关都能用」的形状：
/// 换 DeepSeek / 通义千问 / GLM / 本地 Ollama / OpenAI 官方，只改 appsettings.json
/// 里的 EndPoint + ApiKey + ModelId 三个字段，代码一行不动。
/// </summary>
public sealed class LlmOptions
{
    public const string SectionName = "Llm";

    /// <summary>网关密钥。留空时会回退读环境变量 MAF_HARNESS_LLM_API_KEY。</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>网关地址，必须以 /v1 结尾。OpenAI 官方是 https://api.openai.com/v1。</summary>
    public string EndPoint { get; set; } = "https://api.deepseek.com/v1";

    /// <summary>模型 Id，必须和网关控制台里的名字逐字符一致。</summary>
    public string ModelId { get; set; } = "deepseek-chat";

    /// <summary>是否把 prompt 和 completion 原文写进 trace。默认关，需要调试链路时再打开。</summary>
    public bool EnableSensitiveTelemetry { get; set; }

    /// <summary>
    /// 返回 <see cref="IChatClient"/> 而不是具体 Agent。
    /// Program.cs 是唯一组装的地方，Agent 定义在 Infrastructure/Agents 里消费它。
    /// </summary>
    public IChatClient CreateChatClient()
    {
        var key = string.IsNullOrWhiteSpace(ApiKey)
            ? Environment.GetEnvironmentVariable("MAF_HARNESS_LLM_API_KEY") ?? string.Empty
            : ApiKey;

        if (string.IsNullOrWhiteSpace(key))
            throw new InvalidOperationException(
                "未配置 Llm:ApiKey。请填 src/MafHarnessDemo.App/appsettings.json，"
                + "或设置环境变量 MAF_HARNESS_LLM_API_KEY。");

        var client = new OpenAIClient(
            new ApiKeyCredential(key),
            new OpenAIClientOptions
            {
                Endpoint = new Uri(EndPoint),
                // SSE 修补：兼容网关的流式响应里，tool call 参数增量 chunk 的 "type"
                // 是空字符串（"type":""），OpenAI SDK 严格解析直接抛
                // "Unknown ChatToolCallKind value"。SseFixupHandler 在响应流上按行
                // 把 "type":"" 修补成 "type":"function"，流式即可正常解析——
                // 不需要降级到非流式，打字机效果保留。
                Transport = new HttpClientPipelineTransport(new HttpClient(new SseFixupHandler())),
            });

        return client.GetChatClient(ModelId).AsIChatClient().AsBuilder()
            .UseOpenTelemetry(configure: o => o.EnableSensitiveData = EnableSensitiveTelemetry)
            .Use(static inner => new ReasoningHistoryStripper(inner))
            .Build();
    }
}

/// <summary>
/// 出站净化：把请求消息里的 <see cref="TextReasoningContent"/> 剥掉再发给网关。
///
/// 思考内容一旦开始显示，MAF 的 AgentSession 会把含思考的助手消息存进历史、
/// 下一轮原样回传；而 DeepSeek 风格 API 明确禁止请求 messages 里带
/// reasoning_content（报 400）。所以在管道最外层把思考剥掉——
/// 思考只用于屏幕展示，不进请求。
/// </summary>
internal sealed class ReasoningHistoryStripper(IChatClient inner) : DelegatingChatClient(inner)
{
    public override Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        => base.GetResponseAsync(Strip(messages), options, cancellationToken);

    public override IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        => base.GetStreamingResponseAsync(Strip(messages), options, cancellationToken);

    private static List<ChatMessage> Strip(IEnumerable<ChatMessage> messages) =>
        messages.Select(m => m.Contents.OfType<TextReasoningContent>().Any()
            ? new ChatMessage(m.Role, [.. m.Contents.Where(c => c is not TextReasoningContent)])
                {
                    AuthorName = m.AuthorName,
                    CreatedAt = m.CreatedAt,
                    MessageId = m.MessageId,
                    AdditionalProperties = m.AdditionalProperties,
                }
            : m).ToList();
}

/// <summary>
/// 诊断/修补 handler：对流式（SSE）响应按行修补空 type 的 tool call chunk。
/// 只碰 chat/completions 的响应；非流式和其他请求原样透传。
/// </summary>
internal sealed class SseFixupHandler : DelegatingHandler
{
    public SseFixupHandler() : base(new HttpClientHandler())
    {
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var response = await base.SendAsync(request, cancellationToken);

        var isChatCompletions = request.RequestUri?.AbsolutePath.Contains("chat/completions") == true;
        var isStream = request.Content is not null
                       && await request.Content.ReadAsStringAsync(cancellationToken) is { } body
                       && body.Contains("\"stream\":true", StringComparison.Ordinal);

        if (isChatCompletions && isStream && response.Content is not null)
        {
            var original = await response.Content.ReadAsStreamAsync(cancellationToken);
            response.Content = new StreamContent(new SseFixupStream(original));
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("text/event-stream");
        }

        return response;
    }
}

/// <summary>
/// SSE 修补流：按行（\n 边界）读上游，把每行里的 "type":"" 换成
/// "type":"function" 后交给下游。SSE 的 data: 行是完整 JSON，按行替换安全；
/// 跨行的 JSON 分片不存在，所以行缓冲不会破坏数据。
/// </summary>
internal sealed class SseFixupStream : Stream
{
    private readonly Stream _inner;
    private readonly MemoryStream _pending = new(); // 修补后的待读输出
    private readonly byte[] _lineBuffer = new byte[256 * 1024];
    private int _lineLength;
    private bool _innerDone;

    public SseFixupStream(Stream inner) => _inner = inner;

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    public override int Read(byte[] buffer, int offset, int count) =>
        ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        while (_pending.Length == 0 || _pending.Position == _pending.Length)
        {
            if (_innerDone) return 0;

            _pending.SetLength(0);
            _pending.Position = 0;

            var chunk = new byte[8192];
            var read = await _inner.ReadAsync(chunk, cancellationToken);
            if (read == 0)
            {
                _innerDone = true;
                // 上游结束：冲刷残余的半行（理论上 SSE 以 \n\n 结尾，这里只是保险）
                if (_lineLength > 0)
                {
                    EmitLine(_lineBuffer.AsSpan(0, _lineLength));
                    _lineLength = 0;
                }

                if (_pending.Length == 0) return 0;
                continue;
            }

            var span = chunk.AsSpan(0, read);
            var start = 0;
            for (var i = 0; i < span.Length; i++)
            {
                if (span[i] != (byte)'\n') continue;

                var lineLength = i - start + 1;
                if (_lineLength + lineLength > _lineBuffer.Length)
                {
                    // 单行超长（不该发生）：原样透传已缓冲部分，避免丢失
                    EmitRaw(_lineBuffer.AsMemory(0, _lineLength));
                    EmitRaw(chunk.AsMemory(start, lineLength));
                }
                else
                {
                    span.Slice(start, lineLength).CopyTo(_lineBuffer.AsSpan(_lineLength));
                    _lineLength += lineLength;
                    EmitLine(_lineBuffer.AsSpan(0, _lineLength));
                    _lineLength = 0;
                }

                start = i + 1;
            }

            if (start < span.Length)
            {
                span.Slice(start).CopyTo(_lineBuffer.AsSpan(_lineLength));
                _lineLength += span.Length - start;
            }
        }

        return _pending.Read(buffer.Span);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _inner.Dispose();
            _pending.Dispose();
        }

        base.Dispose(disposing);
    }

    private void EmitLine(ReadOnlySpan<byte> line)
    {
        var text = Encoding.UTF8.GetString(line);
        if (text.Contains("\"type\":\"\"", StringComparison.Ordinal))
        {
            text = text.Replace("\"type\":\"\"", "\"type\":\"function\"", StringComparison.Ordinal);
        }

        EmitRaw(Encoding.UTF8.GetBytes(text));
    }

    private void EmitRaw(ReadOnlyMemory<byte> data)
    {
        if (data.IsEmpty) return;
        var position = _pending.Position;
        _pending.Position = _pending.Length;
        _pending.Write(data.Span);
        _pending.Position = position;
    }
}
