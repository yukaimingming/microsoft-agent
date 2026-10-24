using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MafHarness.Web.Models;

namespace MafHarness.Web.Services;

/// <summary>
/// 个人微信 ClawBot iLink 协议核心服务。
/// 对接腾讯官方 iLink Bot 网关 (https://ilinkai.weixin.qq.com)：
/// 1. 获取登录二维码 (/ilink/bot/get_bot_qrcode?bot_type=3)
/// 2. 长轮询扫码状态 (/ilink/bot/get_qrcode_status?qrcode=...)
/// 3. 持久化 Bot 凭据并启动后台消息长轮询 (/ilink/bot/getupdates)
/// 4. 桥接个人微信消息至本地 MAF Personal Agent 并回传回复 (/ilink/bot/sendmessage)
/// 5. 支持微信原生“正在输入...”状态提示 (/ilink/bot/getconfig & /ilink/bot/sendtyping)
/// </summary>
public sealed class WeChatIlinkService : IDisposable
{
    private const string DefaultIlinkBaseUrl = "https://ilinkai.weixin.qq.com";
    private const string IlinkAppId = "bot";
    // 2.4.6 -> (2 << 16) | (4 << 8) | 6 = 132102，避免手机微信端报“请升级接口版本”
    private const string IlinkClientVersion = "132102";
    private const string ChannelVersion = "2.4.6";

    private readonly MafAgentManager _agentManager;
    private readonly WorkbenchService _workbenchService;
    private readonly WorkspaceService _workspaceService;
    private readonly ILogger<WeChatIlinkService> _logger;
    private readonly HttpClient _httpClient;
    private readonly string _credentialsPath;
    private readonly object _lock = new();

    private WeChatClawbotCredentials? _credentials;
    private CancellationTokenSource? _longPollCts;
    private Task? _longPollTask;
    private bool _longPollActive;
    private string? _lastError;

    // 当前二维码会话状态追踪与后台自动监听（即使关闭前端弹窗直接扫截图也能自动完成绑定）
    private string? _activeQrCodeToken;
    private string _activeQrCodeStatus = "disconnected";
    private CancellationTokenSource? _qrWatcherCts;
    private readonly SemaphoreSlim _qrPollLock = new(1, 1);
    private readonly ConcurrentDictionary<string, string> _typingTickets = new();

    public WeChatIlinkService(
        MafAgentManager agentManager,
        WorkbenchService workbenchService,
        WorkspaceService workspaceService,
        ILogger<WeChatIlinkService> logger)
    {
        _agentManager = agentManager;
        _workbenchService = workbenchService;
        _workspaceService = workspaceService;
        _logger = logger;

        _httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(45)
        };

        var dataDir = Path.Combine(AppContext.BaseDirectory, ".data");
        Directory.CreateDirectory(dataDir);
        _credentialsPath = Path.Combine(dataDir, "wechat_clawbot.json");

        LoadCredentials();
        if (_credentials != null && !string.IsNullOrWhiteSpace(_credentials.BotToken))
        {
            _activeQrCodeStatus = "confirmed";
            StartLongPollLoop();
        }
    }

    /// <summary>
    /// 获取当前 ClawBot 连接状态
    /// </summary>
    public WeChatConnectionStatusData GetConnectionStatus()
    {
        lock (_lock)
        {
            var isConnected = _credentials != null && !string.IsNullOrWhiteSpace(_credentials.BotToken);
            return new WeChatConnectionStatusData
            {
                Connected = isConnected,
                Status = isConnected ? "connected" : _activeQrCodeStatus,
                IlinkBotId = _credentials?.IlinkBotId,
                IlinkUserId = _credentials?.IlinkUserId,
                BaseUrl = _credentials?.BaseUrl ?? DefaultIlinkBaseUrl,
                ConnectedAt = _credentials?.ConnectedAt,
                LastMessageAt = _credentials?.LastMessageAt,
                MessageCount = _credentials?.MessageCount ?? 0,
                LongPollActive = _longPollActive,
                LastError = _lastError
            };
        }
    }

    /// <summary>
    /// 调用 iLink 协议获取个人微信 ClawBot 绑定二维码
    /// </summary>
    public async Task<WeChatQrCodeData> GetQrCodeAsync(CancellationToken ct = default)
    {
        var url = $"{DefaultIlinkBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        ApplyCommonHeaders(req);

        using var resp = await _httpClient.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();

        var json = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var qrcode = root.TryGetProperty("qrcode", out var qrProp) ? qrProp.GetString() ?? string.Empty : string.Empty;
        var qrcodeImgContent = root.TryGetProperty("qrcode_img_content", out var imgProp) ? imgProp.GetString() : null;

        if (string.IsNullOrWhiteSpace(qrcode))
        {
            throw new InvalidOperationException($"从 iLink 获取二维码失败: {json}");
        }

        // 如果未返回 qrcode_img_content，则按官方格式构造扫描地址
        var scanTargetUrl = !string.IsNullOrWhiteSpace(qrcodeImgContent)
            ? qrcodeImgContent!
            : $"{DefaultIlinkBaseUrl}/ilink/bot/get_qrcode_status?qrcode={Uri.EscapeDataString(qrcode)}";

        var qrImageUrl = $"https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=10&data={Uri.EscapeDataString(scanTargetUrl)}";

        // 预拉取二维码图片转 Base64，确保前端弹窗秒开且不受外网图片加载波动影响
        string? qrBase64 = null;
        try
        {
            using var imgCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            imgCts.CancelAfter(TimeSpan.FromSeconds(6));
            var imgBytes = await _httpClient.GetByteArrayAsync(qrImageUrl, imgCts.Token);
            if (imgBytes.Length > 0)
            {
                qrBase64 = "data:image/png;base64," + Convert.ToBase64String(imgBytes);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug("预拉取二维码 Base64 跳过，前端将直接使用 qrcode_url: {Error}", ex.Message);
        }

        lock (_lock)
        {
            _activeQrCodeToken = qrcode;
            _activeQrCodeStatus = "wait";
            _lastError = null;
            StartQrWatcherLoopInternal(qrcode);
        }

        _logger.LogInformation("已生成微信 ClawBot 登录二维码并启动后台扫码监听: token={Token}", qrcode);

        return new WeChatQrCodeData
        {
            QrCode = qrcode,
            QrCodeUrl = qrImageUrl,
            QrCodeImgContent = scanTargetUrl,
            QrCodeBase64 = qrBase64
        };
    }

    /// <summary>
    /// 轮询二维码扫描状态（对接 /ilink/bot/get_qrcode_status）
    /// </summary>
    public async Task<WeChatQrCodeStatusData> PollQrCodeStatusAsync(string qrcodeToken, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(qrcodeToken))
        {
            throw new ArgumentException("qrcode 不能为空", nameof(qrcodeToken));
        }

        // 若该二维码刚好已经确认登录，直接返回已保存的凭据
        lock (_lock)
        {
            if (_credentials != null &&
                !string.IsNullOrWhiteSpace(_credentials.BotToken) &&
                _activeQrCodeToken == qrcodeToken &&
                _activeQrCodeStatus == "confirmed")
            {
                return new WeChatQrCodeStatusData
                {
                    Status = "confirmed",
                    BaseUrl = _credentials.BaseUrl,
                    Credentials = new WeChatCredentialsDto
                    {
                        BotToken = _credentials.BotToken,
                        IlinkBotId = _credentials.IlinkBotId,
                        IlinkUserId = _credentials.IlinkUserId
                    }
                };
            }
        }

        await _qrPollLock.WaitAsync(ct);
        try
        {
            // 进入锁后再次检查是否已被后台监听协程更新为 confirmed / expired
            lock (_lock)
            {
                if (_credentials != null &&
                    !string.IsNullOrWhiteSpace(_credentials.BotToken) &&
                    _activeQrCodeToken == qrcodeToken &&
                    _activeQrCodeStatus == "confirmed")
                {
                    return new WeChatQrCodeStatusData
                    {
                        Status = "confirmed",
                        BaseUrl = _credentials.BaseUrl,
                        Credentials = new WeChatCredentialsDto
                        {
                            BotToken = _credentials.BotToken,
                            IlinkBotId = _credentials.IlinkBotId,
                            IlinkUserId = _credentials.IlinkUserId
                        }
                    };
                }
                if (_activeQrCodeToken == qrcodeToken && _activeQrCodeStatus == "expired")
                {
                    return new WeChatQrCodeStatusData
                    {
                        Status = "expired",
                        BaseUrl = DefaultIlinkBaseUrl
                    };
                }
            }

            var url = $"{DefaultIlinkBaseUrl}/ilink/bot/get_qrcode_status?qrcode={Uri.EscapeDataString(qrcodeToken)}";
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            ApplyCommonHeaders(req);

            // iLink get_qrcode_status 为长轮询接口（无状态变化时服务端约挂起 35 秒），
            // 这里设置 15 秒轮询窗口：若 15 秒内用户未扫码，优雅返回当前状态（wait/scaned），前端无缝发起下一轮轮询
            using var pollCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            pollCts.CancelAfter(TimeSpan.FromSeconds(15));

            try
            {
                using var resp = await _httpClient.SendAsync(req, pollCts.Token);
                resp.EnsureSuccessStatusCode();

                var json = await resp.Content.ReadAsStringAsync(pollCts.Token);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                var ret = root.TryGetProperty("ret", out var retProp) && retProp.TryGetInt32(out var r) ? r : 0;
                var status = root.TryGetProperty("status", out var statusProp) ? statusProp.GetString() ?? "wait" : "wait";

                if (ret == -14 || string.Equals(status, "expired", StringComparison.OrdinalIgnoreCase))
                {
                    lock (_lock)
                    {
                        if (_activeQrCodeToken == qrcodeToken) _activeQrCodeStatus = "expired";
                    }
                    return new WeChatQrCodeStatusData
                    {
                        Status = "expired",
                        BaseUrl = DefaultIlinkBaseUrl
                    };
                }

                // 兼容 status = "scaned" / "scanned"
                if (string.Equals(status, "scanned", StringComparison.OrdinalIgnoreCase))
                {
                    status = "scaned";
                }

                if (string.Equals(status, "confirmed", StringComparison.OrdinalIgnoreCase))
                {
                    var botToken = ExtractString(root, "bot_token") ?? string.Empty;
                    var ilinkBotId = ExtractString(root, "ilink_bot_id") ?? ExtractString(root, "bot_id") ?? string.Empty;
                    var ilinkUserId = ExtractString(root, "ilink_user_id") ?? ExtractString(root, "user_id") ?? ExtractString(root, "account_id") ?? string.Empty;
                    var baseUrl = ExtractString(root, "baseurl") ?? ExtractString(root, "base_url") ?? DefaultIlinkBaseUrl;

                    if (string.IsNullOrWhiteSpace(baseUrl))
                    {
                        baseUrl = DefaultIlinkBaseUrl;
                    }

                    var creds = new WeChatClawbotCredentials
                    {
                        BotToken = botToken,
                        IlinkBotId = ilinkBotId,
                        IlinkUserId = ilinkUserId,
                        BaseUrl = baseUrl.TrimEnd('/'),
                        ConnectedAt = DateTime.UtcNow.ToString("o"),
                        GetUpdatesBuf = string.Empty
                    };

                    lock (_lock)
                    {
                        _credentials = creds;
                        _activeQrCodeStatus = "confirmed";
                        _lastError = null;
                        SaveCredentials();
                    }

                    _logger.LogInformation("微信 ClawBot 扫码授权成功！bot_id={BotId}, user_id={UserId}", ilinkBotId, ilinkUserId);
                    StartLongPollLoop();

                    return new WeChatQrCodeStatusData
                    {
                        Status = "confirmed",
                        BaseUrl = creds.BaseUrl,
                        Credentials = new WeChatCredentialsDto
                        {
                            BotToken = creds.BotToken,
                            IlinkBotId = creds.IlinkBotId,
                            IlinkUserId = creds.IlinkUserId
                        }
                    };
                }

                lock (_lock)
                {
                    if (_activeQrCodeToken == qrcodeToken)
                    {
                        _activeQrCodeStatus = status;
                    }
                }

                return new WeChatQrCodeStatusData
                {
                    Status = status,
                    BaseUrl = DefaultIlinkBaseUrl
                };
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // 15 秒长轮询窗口到期但用户尚未点击或扫码，返回当前等待状态
                string currentStatus;
                lock (_lock)
                {
                    currentStatus = _activeQrCodeToken == qrcodeToken &&
                                    (_activeQrCodeStatus == "scaned" || _activeQrCodeStatus == "wait")
                        ? _activeQrCodeStatus
                        : "wait";
                }

                return new WeChatQrCodeStatusData
                {
                    Status = currentStatus,
                    BaseUrl = DefaultIlinkBaseUrl
                };
            }
        }
        finally
        {
            _qrPollLock.Release();
        }
    }

    private void StartQrWatcherLoopInternal(string qrcodeToken)
    {
        if (_qrWatcherCts != null)
        {
            try
            {
                _qrWatcherCts.Cancel();
                _qrWatcherCts.Dispose();
            }
            catch { }
        }

        _qrWatcherCts = new CancellationTokenSource(TimeSpan.FromMinutes(6));
        var ct = _qrWatcherCts.Token;

        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    var res = await PollQrCodeStatusAsync(qrcodeToken, ct);
                    if (res.Status is "confirmed" or "expired")
                    {
                        break;
                    }
                    await Task.Delay(500, ct);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch
                {
                    await Task.Delay(2000, ct);
                }
            }
        }, CancellationToken.None);
    }

    /// <summary>
    /// 重置微信 IM 通道并停止后台长轮询
    /// </summary>
    public string ResetChannel(string? requestedChannelId)
    {
        string channelId;
        lock (_lock)
        {
            channelId = !string.IsNullOrWhiteSpace(requestedChannelId)
                ? requestedChannelId!
                : (_credentials?.IlinkBotId ?? _activeQrCodeToken ?? "default_channel");

            StopLongPollLoopInternal();
            _credentials = null;
            _activeQrCodeToken = null;
            _activeQrCodeStatus = "disconnected";
            _lastError = null;

            try
            {
                if (File.Exists(_credentialsPath))
                {
                    File.Delete(_credentialsPath);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning("删除微信 ClawBot 凭据文件失败: {Error}", ex.Message);
            }
        }

        _logger.LogInformation("已重置微信 ClawBot IM 通道: {ChannelId}", channelId);
        return channelId;
    }

    private void StartLongPollLoop()
    {
        lock (_lock)
        {
            StopLongPollLoopInternal();
            if (_credentials == null || string.IsNullOrWhiteSpace(_credentials.BotToken))
            {
                return;
            }

            _longPollCts = new CancellationTokenSource();
            var token = _longPollCts.Token;
            _longPollActive = true;
            _longPollTask = Task.Run(() => RunLongPollLoopAsync(token), CancellationToken.None);
        }
    }

    private void StopLongPollLoopInternal()
    {
        _longPollActive = false;
        if (_longPollCts != null)
        {
            try
            {
                _longPollCts.Cancel();
                _longPollCts.Dispose();
            }
            catch { }
            _longPollCts = null;
        }
    }

    /// <summary>
    /// 后台持续长轮询 iLink /ilink/bot/getupdates 接收个人微信消息并调用本地 Agent 回复
    /// </summary>
    private async Task RunLongPollLoopAsync(CancellationToken ct)
    {
        _logger.LogInformation("微信 ClawBot iLink 长轮询消息通道已启动");

        while (!ct.IsCancellationRequested)
        {
            WeChatClawbotCredentials? creds;
            lock (_lock)
            {
                creds = _credentials;
            }

            if (creds == null || string.IsNullOrWhiteSpace(creds.BotToken))
            {
                break;
            }

            try
            {
                var baseUrl = string.IsNullOrWhiteSpace(creds.BaseUrl) ? DefaultIlinkBaseUrl : creds.BaseUrl.TrimEnd('/');
                var url = $"{baseUrl}/ilink/bot/getupdates";

                var payload = new
                {
                    get_updates_buf = creds.GetUpdatesBuf ?? string.Empty,
                    base_info = new
                    {
                        channel_version = ChannelVersion
                    }
                };

                using var req = new HttpRequestMessage(HttpMethod.Post, url)
                {
                    Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json")
                };
                ApplyAuthHeaders(req, creds.BotToken);

                using var pollCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                pollCts.CancelAfter(TimeSpan.FromSeconds(40));

                using var resp = await _httpClient.SendAsync(req, pollCts.Token);
                resp.EnsureSuccessStatusCode();

                var json = await resp.Content.ReadAsStringAsync(pollCts.Token);
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                var ret = root.TryGetProperty("ret", out var retProp) && retProp.TryGetInt32(out var r) ? r : 0;
                if (ret == -14)
                {
                    _logger.LogWarning("微信 ClawBot bot_token 已过期 (ret=-14)，停止长轮询");
                    lock (_lock)
                    {
                        _lastError = "登录凭证已过期，请重新扫码连接";
                        _longPollActive = false;
                        _credentials = null;
                        _activeQrCodeStatus = "expired";
                        SaveCredentials();
                    }
                    break;
                }

                if (root.TryGetProperty("get_updates_buf", out var bufProp) && bufProp.ValueKind == JsonValueKind.String)
                {
                    var newBuf = bufProp.GetString();
                    if (!string.IsNullOrEmpty(newBuf) && newBuf != creds.GetUpdatesBuf)
                    {
                        lock (_lock)
                        {
                            if (_credentials != null)
                            {
                                _credentials.GetUpdatesBuf = newBuf;
                                SaveCredentials();
                            }
                        }
                    }
                }

                if (root.TryGetProperty("msgs", out var msgsProp) && msgsProp.ValueKind == JsonValueKind.Array)
                {
                    foreach (var msgEl in msgsProp.EnumerateArray())
                    {
                        await HandleInboundMessageAsync(creds, msgEl.Clone(), ct);
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (OperationCanceledException)
            {
                // 单次 40s 长轮询超时无新消息，立即进入下一轮
            }
            catch (Exception ex)
            {
                _logger.LogWarning("微信 ClawBot getupdates 轮询异常: {Error}", ex.Message);
                lock (_lock)
                {
                    _lastError = ex.Message;
                }
                await Task.Delay(TimeSpan.FromSeconds(3), ct);
            }
        }

        lock (_lock)
        {
            _longPollActive = false;
        }
        _logger.LogInformation("微信 ClawBot iLink 长轮询消息通道已退出");
    }

    private async Task HandleInboundMessageAsync(
        WeChatClawbotCredentials creds,
        JsonElement msgEl,
        CancellationToken ct)
    {
        try
        {
            var fromUserId = msgEl.TryGetProperty("from_user_id", out var fromProp) ? fromProp.GetString() ?? string.Empty : string.Empty;
            var contextToken = msgEl.TryGetProperty("context_token", out var ctxProp) ? ctxProp.GetString() ?? string.Empty : string.Empty;
            var messageType = msgEl.TryGetProperty("message_type", out var mtProp) && mtProp.TryGetInt32(out var mt) ? mt : 1;

            // 忽略 Bot 自己发出的消息
            if (messageType == 2 ||
                string.IsNullOrWhiteSpace(fromUserId) ||
                string.Equals(fromUserId, creds.IlinkBotId, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            // 提取文本内容
            var textBuilder = new StringBuilder();
            if (msgEl.TryGetProperty("item_list", out var itemsProp) && itemsProp.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in itemsProp.EnumerateArray())
                {
                    var itemType = item.TryGetProperty("type", out var tProp) && tProp.TryGetInt32(out var t) ? t : 0;
                    if (itemType == 1 && item.TryGetProperty("text_item", out var textItem) &&
                        textItem.TryGetProperty("text", out var textVal))
                    {
                        textBuilder.Append(textVal.GetString());
                    }
                    else if (item.TryGetProperty("voice_item", out var voiceItem) &&
                             voiceItem.TryGetProperty("text", out var voiceText))
                    {
                        textBuilder.Append(voiceText.GetString());
                    }
                }
            }

            var userText = textBuilder.ToString().Trim();
            if (string.IsNullOrWhiteSpace(userText))
            {
                return;
            }

            _logger.LogInformation("收到微信 ClawBot 消息 [From={From}]: {Text}", fromUserId, userText);

            lock (_lock)
            {
                if (_credentials != null)
                {
                    if (string.IsNullOrWhiteSpace(_credentials.IlinkUserId))
                    {
                        _credentials.IlinkUserId = fromUserId;
                    }
                    _credentials.LastMessageAt = DateTime.UtcNow.ToString("o");
                    _credentials.MessageCount++;
                    SaveCredentials();
                }
            }

            // 触发手机微信端“对方正在输入...”提示
            _ = SendTypingIndicatorAsync(creds, fromUserId, isTyping: true, ct);

            // 使用独立会话 ID 调用本地 MAF Personal Agent
            var threadId = "wechat-clawbot-session";
            var replyText = await _agentManager.ExecuteTextPromptAsync(threadId, userText, ct);

            // 同步保存至工作台历史会话，方便在 Web 界面直接查看微信对话记录
            SyncWeChatConversationToWorkbench(threadId, userText, replyText);

            // 发送回复至个人微信
            await SendWeChatMessageAsync(creds, fromUserId, contextToken, replyText, ct);

            // 结束“正在输入...”提示
            _ = SendTypingIndicatorAsync(creds, fromUserId, isTyping: false, ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "处理微信 ClawBot 入站消息失败");
        }
    }

    private async Task SendWeChatMessageAsync(
        WeChatClawbotCredentials creds,
        string toUserId,
        string contextToken,
        string text,
        CancellationToken ct)
    {
        var baseUrl = string.IsNullOrWhiteSpace(creds.BaseUrl) ? DefaultIlinkBaseUrl : creds.BaseUrl.TrimEnd('/');
        var url = $"{baseUrl}/ilink/bot/sendmessage";

        var payload = new
        {
            msg = new
            {
                from_user_id = "",
                to_user_id = toUserId,
                client_id = "maf-" + Guid.NewGuid().ToString("N")[..16],
                message_type = 2,
                message_state = 2,
                context_token = contextToken,
                item_list = new[]
                {
                    new
                    {
                        type = 1,
                        text_item = new
                        {
                            text
                        }
                    }
                }
            },
            base_info = new
            {
                channel_version = ChannelVersion
            }
        };

        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json")
        };
        ApplyAuthHeaders(req, creds.BotToken);

        using var resp = await _httpClient.SendAsync(req, ct);
        var respJson = await resp.Content.ReadAsStringAsync(ct);
        _logger.LogInformation("微信 ClawBot sendmessage 响应: {Response}", respJson);
    }

    private async Task SendTypingIndicatorAsync(
        WeChatClawbotCredentials creds,
        string userId,
        bool isTyping,
        CancellationToken ct)
    {
        try
        {
            var baseUrl = string.IsNullOrWhiteSpace(creds.BaseUrl) ? DefaultIlinkBaseUrl : creds.BaseUrl.TrimEnd('/');
            if (!_typingTickets.TryGetValue(userId, out var ticket) || string.IsNullOrWhiteSpace(ticket))
            {
                var configUrl = $"{baseUrl}/ilink/bot/getconfig";
                var configPayload = new
                {
                    ilink_user_id = userId,
                    base_info = new { channel_version = ChannelVersion }
                };
                using var configReq = new HttpRequestMessage(HttpMethod.Post, configUrl)
                {
                    Content = new StringContent(JsonSerializer.Serialize(configPayload), Encoding.UTF8, "application/json")
                };
                ApplyAuthHeaders(configReq, creds.BotToken);
                using var configResp = await _httpClient.SendAsync(configReq, ct);
                if (configResp.IsSuccessStatusCode)
                {
                    var configJson = await configResp.Content.ReadAsStringAsync(ct);
                    using var doc = JsonDocument.Parse(configJson);
                    if (doc.RootElement.TryGetProperty("typing_ticket", out var ticketProp))
                    {
                        ticket = ticketProp.GetString();
                        if (!string.IsNullOrWhiteSpace(ticket))
                        {
                            _typingTickets[userId] = ticket!;
                        }
                    }
                }
            }

            if (string.IsNullOrWhiteSpace(ticket)) return;

            var typingUrl = $"{baseUrl}/ilink/bot/sendtyping";
            var typingPayload = new
            {
                ilink_user_id = userId,
                to_user_id = userId,
                typing_ticket = ticket,
                status = isTyping ? 1 : 2,
                command = isTyping ? 1 : 2,
                base_info = new { channel_version = ChannelVersion }
            };
            using var typingReq = new HttpRequestMessage(HttpMethod.Post, typingUrl)
            {
                Content = new StringContent(JsonSerializer.Serialize(typingPayload), Encoding.UTF8, "application/json")
            };
            ApplyAuthHeaders(typingReq, creds.BotToken);
            using var _ = await _httpClient.SendAsync(typingReq, ct);
        }
        catch
        {
            // typing 状态仅作体验增强，异常静默忽略
        }
    }

    private void SyncWeChatConversationToWorkbench(string threadId, string userText, string assistantText)
    {
        try
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var existingObj = _workbenchService.LoadSessionState(threadId);
            var messages = new List<object>();

            if (existingObj is JsonElement existingEl &&
                existingEl.TryGetProperty("messages", out var oldMsgs) &&
                oldMsgs.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in oldMsgs.EnumerateArray())
                {
                    messages.Add(item.Clone());
                }
            }

            messages.Add(new
            {
                id = "wx-u-" + Guid.NewGuid().ToString("N")[..8],
                role = "user",
                content = $"[微信 ClawBot] {userText}",
                createdAt = now
            });
            messages.Add(new
            {
                id = "wx-a-" + Guid.NewGuid().ToString("N")[..8],
                role = "assistant",
                content = assistantText,
                createdAt = now + 1
            });

            var sessionState = new
            {
                threadId,
                workspaceRoot = _workspaceService.CurrentWorkspaceRoot,
                messages,
                activities = Array.Empty<object>(),
                run = new
                {
                    status = "completed",
                    runId = "wx-run-" + now,
                    threadId,
                    startedAt = now,
                    endedAt = now + 1,
                    interrupts = Array.Empty<object>()
                },
                pendingDecisions = new Dictionary<string, object>()
            };

            _workbenchService.SaveSessionState(threadId, sessionState);
        }
        catch (Exception ex)
        {
            _logger.LogDebug("同步微信会话至工作台跳过: {Error}", ex.Message);
        }
    }

    private static void ApplyCommonHeaders(HttpRequestMessage req)
    {
        req.Headers.TryAddWithoutValidation("iLink-App-Id", IlinkAppId);
        req.Headers.TryAddWithoutValidation("iLink-App-ClientVersion", IlinkClientVersion);
        req.Headers.TryAddWithoutValidation("X-WECHAT-UIN", GenerateRandomWeChatUin());
    }

    private static void ApplyAuthHeaders(HttpRequestMessage req, string botToken)
    {
        ApplyCommonHeaders(req);
        req.Headers.TryAddWithoutValidation("AuthorizationType", "ilink_bot_token");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", botToken);
    }

    private static string GenerateRandomWeChatUin()
    {
        var uint32Val = RandomNumberGenerator.GetInt32(100_000_000, int.MaxValue);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(uint32Val.ToString()));
    }

    private static string? ExtractString(JsonElement root, string propName)
    {
        if (root.TryGetProperty(propName, out var prop) && prop.ValueKind == JsonValueKind.String)
        {
            return prop.GetString();
        }
        if (root.TryGetProperty("credentials", out var creds) && creds.ValueKind == JsonValueKind.Object &&
            creds.TryGetProperty(propName, out var credProp) && credProp.ValueKind == JsonValueKind.String)
        {
            return credProp.GetString();
        }
        if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
        {
            if (data.TryGetProperty(propName, out var dataProp) && dataProp.ValueKind == JsonValueKind.String)
            {
                return dataProp.GetString();
            }
            if (data.TryGetProperty("credentials", out var nestedCreds) && nestedCreds.ValueKind == JsonValueKind.Object &&
                nestedCreds.TryGetProperty(propName, out var nestedProp) && nestedProp.ValueKind == JsonValueKind.String)
            {
                return nestedProp.GetString();
            }
        }
        return null;
    }

    private void LoadCredentials()
    {
        if (!File.Exists(_credentialsPath)) return;
        try
        {
            var json = File.ReadAllText(_credentialsPath);
            _credentials = JsonSerializer.Deserialize<WeChatClawbotCredentials>(json);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("加载微信 ClawBot 凭据失败: {Error}", ex.Message);
        }
    }

    private void SaveCredentials()
    {
        try
        {
            if (_credentials == null)
            {
                if (File.Exists(_credentialsPath)) File.Delete(_credentialsPath);
                return;
            }
            var json = JsonSerializer.Serialize(_credentials, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(_credentialsPath, json, Encoding.UTF8);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("保存微信 ClawBot 凭据失败: {Error}", ex.Message);
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            StopLongPollLoopInternal();
        }
        _httpClient.Dispose();
    }
}
