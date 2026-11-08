using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MafHarness.Web.Models;

namespace MafHarness.Web.Services;

/// <summary>
/// 订阅登录（OAuth）服务：厂商参数全部来自 <see cref="OAuthProviders"/> 注册表（数据驱动），
/// 支持两种流程：
///
/// - 回环授权码（OpenAI / Anthropic / Grok / Google）：生成 PKCE（或 client_secret）并启动
///   本地回环 HTTP 监听 → 浏览器完成授权回调 → 用 code 换 token。
/// - RFC 8628 设备码（GitHub Copilot / Qwen / Kimi）：申请设备码返回给前端展示，
///   后台按 interval 轮询令牌端点直到用户在授权页确认。
///
/// 令牌交换成功后的账号信息解析、刷新、下游调用准备（<see cref="PrepareForCallAsync"/>）
/// 同样按注册表分派。若 start 时带了 providerId 则登录成功立即落到该厂商（access token
/// 存入现有 ApiKey 字段）；新建厂商流程由保存接口携带 oauthLoginId 后取 <see cref="TakeTokens"/>。
/// </summary>
public sealed class OAuthService
{
    private readonly ILogger<OAuthService> _logger;
    private readonly ProviderService _providerService;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ConcurrentDictionary<string, PendingLogin> _logins = new(StringComparer.Ordinal);

    /// <summary>支持的订阅登录厂商 id 列表（与前端卡片目录一致，来自注册表）。</summary>
    public static readonly IReadOnlyList<string> SupportedTypes = OAuthProviders.Ids;

    /// <summary>回环流程浏览器授权超时。</summary>
    private static readonly TimeSpan LoginTimeout = TimeSpan.FromMinutes(5);
    /// <summary>设备码流程轮询上限（以厂商返回的 expires_in 为准，最长 15 分钟）。</summary>
    private static readonly long DeviceMaxPollSeconds = 15 * 60;
    /// <summary>登录记录在内存中保留的最长时间（之后清理，status 返回 missing）。</summary>
    private static readonly TimeSpan RecordTtl = TimeSpan.FromMinutes(30);
    /// <summary>下游调用前 access token 剩余寿命低于该值则先刷新。</summary>
    private static readonly TimeSpan RefreshAhead = TimeSpan.FromMinutes(5);

    /// <summary>优先尝试的本地回环端口（Codex CLI 注册端口段），全部占用则随机。</summary>
    private static readonly int[] PreferredPorts = [1455, 1456, 1457, 1458, 1459, 1460];

    private static readonly IReadOnlyDictionary<string, string> EmptyHeaders =
        new Dictionary<string, string>();

    public OAuthService(ILogger<OAuthService> logger, ProviderService providerService, IHttpClientFactory httpClientFactory)
    {
        _logger = logger;
        _providerService = providerService;
        _httpClientFactory = httpClientFactory;
    }

    /// <summary>一次订阅登录会话（浏览器授权 → 换令牌 → 落库前的暂存）。</summary>
    public sealed class PendingLogin
    {
        public string State { get; }
        public string Type { get; }
        public string? ProviderId { get; }
        public OAuthFlow Flow { get; }

        // 回环流程字段（设备码流程为 null）
        public string? Verifier { get; init; }
        public string? RedirectUri { get; init; }
        public string? AuthorizeUrl { get; init; }

        // 设备码流程字段（回环流程为 null）
        public string? DeviceCode { get; init; }
        public string? UserCode { get; init; }
        public string? VerificationUri { get; init; }
        public string? VerificationUriComplete { get; init; }
        public DateTimeOffset DeviceExpiresAt { get; init; }
        public int IntervalSeconds { get; init; }

        public LoopbackCallbackServer? Server { get; set; }

        public string Status { get; set; } = "pending"; // pending | success | error | expired
        public string? AccessToken { get; set; }
        public string? RefreshToken { get; set; }
        public string? ExpiresAtIso { get; set; }
        public string? AccountEmail { get; set; }
        public string? PlanName { get; set; }
        public string? Error { get; set; }
        /// <summary>成功后已直接落到哪个厂商（start 时指定 providerId 的流程）。</summary>
        public string? AppliedProviderId { get; set; }

        public PendingLogin(string state, string type, string? providerId, OAuthFlow flow)
        {
            State = state;
            Type = type;
            ProviderId = providerId;
            Flow = flow;
        }
    }

    /// <summary>下游调用准备结果：解析后的密钥 + 必须附加的头 + 模型列表路径 + 屏蔽原因。</summary>
    public sealed record CallPrep(
        string? ApiKey,
        IReadOnlyDictionary<string, string> ExtraHeaders,
        string? ModelsPathOverride,
        string? BlockedMessage);

    /// <summary>
    /// 发起一次订阅登录。按注册表分派：回环授权码（PKCE / client_secret）或设备码流程。
    /// </summary>
    /// <param name="type">注册表中的厂商 id（openai / anthropic / grok / google / github-copilot / qwen / kimi）</param>
    /// <param name="providerId">可选；传入且存在时，登录成功后令牌直接落到该厂商</param>
    public async Task<PendingLogin> StartAsync(string type, string? providerId)
    {
        var d = OAuthProviders.Get(type);
        if (d == null) throw new IOException($"未知的订阅登录类型: {type}");
        // 兜底防护：凭据未配置注入（如 Google）绝不拿空 client_id 去请求授权方
        var credentialHint = OAuthProviders.GetCredentialMissingMessage(type);
        if (credentialHint != null) throw new IOException(credentialHint);
        var state = RandomBase64Url(32);
        var login = d.IsLoopback ? StartLoopback(d, state, providerId) : await StartDeviceAsync(d, state, providerId);
        _logins[state] = login;

        // 记录保留一段时间供前端查询状态，之后清理（status 返回 missing）
        _ = Task.Run(async () =>
        {
            await Task.Delay(RecordTtl);
            _logins.TryRemove(state, out _);
        });

        _logger.LogInformation("订阅登录会话已启动: type={Type}, flow={Flow}, port={Port}, providerId={ProviderId}, state={State}",
            type, d.Flow, login.RedirectUri != null ? new Uri(login.RedirectUri).Port : 0, providerId, Abbreviate(state));
        return login;
    }

    // ==================================================================
    // 回环授权码流程（OpenAI / Anthropic / Grok / Google）
    // ==================================================================

    private PendingLogin StartLoopback(OAuthProviderDescriptor d, string state, string? providerId)
    {
        var verifier = d.Flow == OAuthFlow.LoopbackPkce ? RandomBase64Url(32) : null;
        var challenge = verifier != null ? S256Challenge(verifier) : null;
        var port = AllocatePort();
        var redirectUri = $"http://{d.CallbackHost}:{port}{d.CallbackPath}";
        var authorizeUrl = BuildAuthorizeUrl(d, redirectUri, challenge, state);

        var login = new PendingLogin(state, d.Id, providerId, d.Flow)
        {
            Verifier = verifier,
            RedirectUri = redirectUri,
            AuthorizeUrl = authorizeUrl,
        };

        var server = new LoopbackCallbackServer(port, target => HandleLoopbackCallbackAsync(login, target));
        server.Start();
        login.Server = server;

        // 超时自动清理：标记过期 + 停掉回调监听
        _ = Task.Run(async () =>
        {
            await Task.Delay(LoginTimeout);
            if (login.Status == "pending")
            {
                login.Status = "expired";
                login.Error = $"登录超时（{LoginTimeout.TotalMinutes:0} 分钟未完成授权），请重新发起登录";
            }
            StopListener(login);
        });
        return login;
    }

    /// <summary>回环回调入口：把请求目标（/path?query）交给登录会话处理，返回 HTML 提示页。</summary>
    private async Task<string> HandleLoopbackCallbackAsync(PendingLogin login, string rawTarget)
    {
        // 只处理预期的回调路径：favicon / 预连接等杂项请求原样回普通页面，不影响登录状态
        var queryIndex = rawTarget.IndexOf('?');
        var path = queryIndex >= 0 ? rawTarget[..queryIndex] : rawTarget;
        var rawQuery = queryIndex >= 0 ? rawTarget[(queryIndex + 1)..] : "";
        var expectedPath = login.RedirectUri != null ? new Uri(login.RedirectUri).AbsolutePath : "/";
        if (!string.Equals(path, expectedPath, StringComparison.OrdinalIgnoreCase))
        {
            return htmlPage(false, "等待授权", "请返回应用发起的授权页完成登录");
        }

        if (login.Status != "pending")
        {
            return htmlPage(false, "会话已失效",
                login.Error ?? "该登录会话已结束，请返回应用重新发起登录");
        }

        var d = OAuthProviders.Get(login.Type);
        if (d == null) return htmlPage(false, "登录失败", $"未知的订阅登录类型: {login.Type}");
        var parameters = ParseQuery(rawQuery);

        if (parameters.TryGetValue("error", out var err) && !string.IsNullOrWhiteSpace(err))
        {
            var desc = parameters.TryGetValue("error_description", out var desc2) ? desc2 : "";
            var message = $"授权方返回错误: {err}{(string.IsNullOrWhiteSpace(desc) ? "" : $"（{desc}）")}";
            login.Status = "error";
            login.Error = message;
            StopListenerLater(login);
            _logger.LogWarning("订阅登录被授权方拒绝: type={Type}, error={Error}", login.Type, err);
            return htmlPage(false, "登录失败", message);
        }

        var code = parameters.TryGetValue("code", out var c) ? c : null;
        if (string.IsNullOrWhiteSpace(code))
        {
            var message = "回调缺少授权码（code 参数为空）";
            login.Status = "error";
            login.Error = message;
            StopListenerLater(login);
            return htmlPage(false, "登录失败", message);
        }
        var stateParam = parameters.TryGetValue("state", out var s) ? s : null;
        // Anthropic 回调会把 code 与 state 以 # 连接后放进 code 参数（code#state）
        if (code.Contains('#'))
        {
            var idx = code.IndexOf('#');
            var statePart = code[(idx + 1)..];
            if (string.IsNullOrWhiteSpace(stateParam)) stateParam = statePart;
            code = code[..idx];
        }
        if (!string.IsNullOrWhiteSpace(stateParam) && stateParam != login.State)
        {
            var message = "state 校验失败（可能的 CSRF），已终止登录";
            login.Status = "error";
            login.Error = message;
            StopListenerLater(login);
            _logger.LogWarning("订阅登录 state 校验失败: type={Type}", login.Type);
            return htmlPage(false, "登录失败", message);
        }

        try
        {
            var token = await ExchangeLoopbackCodeAsync(d, code, login);
            await CompleteLoginAsync(login, token);
            return htmlPage(true, "登录成功",
                "账号：" + (login.AccountEmail ?? "未知") + (login.PlanName != null ? $" · {login.PlanName}" : ""));
        }
        catch (Exception e)
        {
            var message = $"授权码换取令牌失败: {e.Message}";
            login.Status = "error";
            login.Error = message;
            StopListenerLater(login);
            _logger.LogWarning(e, "订阅登录令牌交换失败: type={Type}", login.Type);
            return htmlPage(false, "登录失败", message);
        }
    }

    /// <summary>令牌拿到后的公共收尾：解析账号信息 → 必要时落到厂商 → 标记成功。</summary>
    private async Task CompleteLoginAsync(PendingLogin login, JsonElement token)
    {
        await FillAccountInfoAsync(login, token);
        if (!string.IsNullOrWhiteSpace(login.ProviderId) && _providerService.Get(login.ProviderId!) != null)
        {
            _providerService.ApplyOAuthToken(login.ProviderId!, login.Type, login.AccessToken,
                login.RefreshToken, login.ExpiresAtIso, login.AccountEmail, login.PlanName);
            login.AppliedProviderId = login.ProviderId;
            _logger.LogInformation("订阅登录成功并已落到厂商: type={Type}, providerId={ProviderId}, account={Account}",
                login.Type, login.ProviderId, login.AccountEmail);
        }
        else
        {
            _logger.LogInformation("订阅登录成功（待保存时落库）: type={Type}, account={Account}",
                login.Type, login.AccountEmail);
        }
    }

    /// <summary>回环流程：用授权码换令牌（按注册表分派 form / json、PKCE / client_secret）。</summary>
    private async Task<JsonElement> ExchangeLoopbackCodeAsync(OAuthProviderDescriptor d, string code, PendingLogin login)
    {
        if (d.JsonExchange)
        {
            var body = new Dictionary<string, object>
            {
                ["grant_type"] = "authorization_code",
                ["code"] = code,
                ["client_id"] = d.ClientId,
                ["redirect_uri"] = login.RedirectUri!,
            };
            if (d.Id == "anthropic") body["state"] = login.State;
            if (login.Verifier != null) body["code_verifier"] = login.Verifier;
            if (d.ClientSecret != null) body["client_secret"] = d.ClientSecret;
            return await PostJsonAsync(d.TokenUrl, body, d.UserAgent);
        }
        var form = "grant_type=authorization_code"
                   + "&code=" + UrlEncode(code)
                   + "&client_id=" + UrlEncode(d.ClientId)
                   + "&redirect_uri=" + UrlEncode(login.RedirectUri!);
        if (login.Verifier != null) form += "&code_verifier=" + UrlEncode(login.Verifier);
        if (d.ClientSecret != null) form += "&client_secret=" + UrlEncode(d.ClientSecret);
        return await PostFormAsync(d.TokenUrl, form, d.UserAgent);
    }

    // ==================================================================
    // RFC 8628 设备码流程（GitHub Copilot / Qwen / Kimi）
    // ==================================================================

    private async Task<PendingLogin> StartDeviceAsync(OAuthProviderDescriptor d, string state, string? providerId)
    {
        var device = await RequestDeviceCodeAsync(d);
        var deviceCode = JsonStr(device, "device_code");
        if (string.IsNullOrWhiteSpace(deviceCode)) throw new IOException("设备码响应缺少 device_code");
        var expiresIn = JsonLong(device, "expires_in");
        var interval = JsonLong(device, "interval");

        var login = new PendingLogin(state, d.Id, providerId, d.Flow)
        {
            DeviceCode = deviceCode,
            UserCode = JsonStr(device, "user_code"),
            VerificationUri = JsonStr(device, "verification_uri"),
            VerificationUriComplete = JsonStr(device, "verification_uri_complete"),
            DeviceExpiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn ?? DeviceMaxPollSeconds),
            IntervalSeconds = interval is > 0 ? (int)interval.Value : 5,
        };

        // 轮询循环：按 interval 自调度，直到拿到令牌 / 过期 / 出错
        _ = Task.Run(() => PollDeviceTokenLoopAsync(d, login));

        // 兜底过期标记（轮询任务自身也会判断 deadline）
        var timeoutSeconds = Math.Min(expiresIn ?? DeviceMaxPollSeconds, DeviceMaxPollSeconds) + 30;
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(timeoutSeconds));
            if (login.Status == "pending")
            {
                login.Status = "expired";
                login.Error = "设备码已过期，请重新发起登录";
            }
        });
        return login;
    }

    private async Task PollDeviceTokenLoopAsync(OAuthProviderDescriptor d, PendingLogin login)
    {
        while (login.Status == "pending")
        {
            if (DateTimeOffset.UtcNow >= login.DeviceExpiresAt)
            {
                login.Status = "expired";
                login.Error = "设备码已过期，请重新发起登录";
                return;
            }
            try
            {
                var token = await PollDeviceTokenAsync(d, login.DeviceCode!);
                if (token.HasValue)
                {
                    await CompleteLoginAsync(login, token.Value);
                    return;
                }
                // authorization_pending / slow_down：继续按 interval 等待
            }
            catch (Exception e)
            {
                login.Status = "error";
                login.Error = $"设备码登录失败: {e.Message}";
                _logger.LogWarning(e, "订阅登录设备码轮询失败: type={Type}", d.Id);
                return;
            }
            await Task.Delay(TimeSpan.FromSeconds(login.IntervalSeconds));
        }
    }

    /// <summary>设备码申请（厂商端点，请求体风格按注册表分派）。</summary>
    private async Task<JsonElement> RequestDeviceCodeAsync(OAuthProviderDescriptor d)
    {
        HttpRequestMessage req;
        if (d.DeviceRequestJson)
        {
            var body = new Dictionary<string, object> { ["client_id"] = d.ClientId };
            if (d.Scope != null) body["scope"] = d.Scope;
            req = BuildPostRequest(d.DeviceCodeUrl!, "application/json", JsonSerializer.Serialize(body), d.UserAgent);
        }
        else
        {
            var form = "client_id=" + UrlEncode(d.ClientId);
            if (d.Scope != null) form += "&scope=" + UrlEncode(d.Scope);
            req = BuildPostRequest(d.DeviceCodeUrl!, "application/x-www-form-urlencoded", form, d.UserAgent);
        }
        using var client = _httpClientFactory.CreateClient("oauth-token");
        client.Timeout = TimeSpan.FromSeconds(20);
        using var resp = await client.SendAsync(req);
        var bodyText = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode)
        {
            throw new IOException($"申请设备码失败 HTTP {(int)resp.StatusCode} {Abbreviate(bodyText)}");
        }
        using var doc = JsonDocument.Parse(bodyText);
        var root = doc.RootElement.Clone();
        if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String)
        {
            var errorDesc = JsonStr(root, "error_description");
            throw new IOException($"申请设备码被拒绝: {error.GetString()}{(string.IsNullOrWhiteSpace(errorDesc) ? "" : $"（{errorDesc}）")}");
        }
        return root;
    }

    /// <summary>
    /// 设备码轮询一次。返回令牌响应；authorization_pending / slow_down 返回 null 继续等；
    /// 其他错误抛 IOException。
    /// </summary>
    private async Task<JsonElement?> PollDeviceTokenAsync(OAuthProviderDescriptor d, string deviceCode)
    {
        HttpRequestMessage req;
        if (d.JsonExchange)
        {
            var body = new Dictionary<string, object>
            {
                ["client_id"] = d.ClientId,
                ["device_code"] = deviceCode,
                ["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code",
            };
            req = BuildPostRequest(d.TokenUrl, "application/json", JsonSerializer.Serialize(body), d.UserAgent);
        }
        else
        {
            var form = "grant_type=urn:ietf:params:oauth:grant-type:device_code"
                       + "&client_id=" + UrlEncode(d.ClientId)
                       + "&device_code=" + UrlEncode(deviceCode);
            req = BuildPostRequest(d.TokenUrl, "application/x-www-form-urlencoded", form, d.UserAgent);
        }
        using var client = _httpClientFactory.CreateClient("oauth-token");
        client.Timeout = TimeSpan.FromSeconds(20);
        using var resp = await client.SendAsync(req);
        var bodyText = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(bodyText);
        var root = doc.RootElement.Clone();
        if (root.TryGetProperty("access_token", out var at) && at.ValueKind == JsonValueKind.String)
        {
            return root;
        }
        var error = JsonStr(root, "error");
        if (error == null && (int)resp.StatusCode == 200)
        {
            throw new IOException("令牌响应缺少 access_token");
        }
        if (error is "authorization_pending" or "slow_down")
        {
            return null;
        }
        throw new IOException(JsonStr(root, "error_description") ?? error ?? $"HTTP {(int)resp.StatusCode}");
    }

    // ==================================================================
    // 登录状态查询 / 令牌消费 / 刷新 / 退出
    // ==================================================================

    /// <summary>登录状态快照（供前端轮询）。返回 null 表示会话不存在/已被清理。</summary>
    public Dictionary<string, object>? GetStatus(string? state)
    {
        if (state == null || !_logins.TryGetValue(state, out var login)) return null;
        var d = OAuthProviders.Get(login.Type);
        var snapshot = new Dictionary<string, object>
        {
            ["status"] = login.Status,
            ["type"] = login.Type,
            ["flow"] = d is { IsLoopback: true } ? "loopback" : "device",
            ["loginId"] = login.State,
        };
        if (login.AppliedProviderId != null) snapshot["providerId"] = login.AppliedProviderId;
        if (login.AccountEmail != null) snapshot["accountEmail"] = login.AccountEmail;
        if (login.PlanName != null) snapshot["planName"] = login.PlanName;
        if (login.ExpiresAtIso != null) snapshot["tokenExpiresAt"] = login.ExpiresAtIso;
        if (login.UserCode != null)
        {
            snapshot["userCode"] = login.UserCode;
            snapshot["verificationUri"] = login.VerificationUri;
            snapshot["verificationUriComplete"] = login.VerificationUriComplete;
            snapshot["expiresInSeconds"] = Math.Max(0, (long)(login.DeviceExpiresAt - DateTimeOffset.UtcNow).TotalSeconds);
            snapshot["intervalSeconds"] = login.IntervalSeconds;
        }
        if (login.Error != null) snapshot["message"] = login.Error;
        return snapshot;
    }

    /// <summary>
    /// 取走一次登录换到的令牌（保存新厂商时消费）。取走后即清除，
    /// 防止重复消费；失败/未完成登录返回 null。
    /// </summary>
    public Dictionary<string, object?>? TakeTokens(string? loginId)
    {
        if (loginId == null || !_logins.TryGetValue(loginId, out var login)) return null;
        if (login.Status != "success" || login.AccessToken == null) return null;
        return new Dictionary<string, object?>
        {
            ["oauthProvider"] = login.Type,
            ["accessToken"] = login.AccessToken,
            ["refreshToken"] = login.RefreshToken,
            ["expiresAt"] = login.ExpiresAtIso,
            ["accountEmail"] = login.AccountEmail,
            ["planName"] = login.PlanName,
        };
    }

    /// <summary>
    /// 下游调用准备：按厂商解析「此刻应该用的密钥」与必须附加的头。
    /// - 短时令牌（Qwen / Kimi）或派生令牌（Copilot）：过期前自动刷新并落库；
    /// - 协议特殊的厂商（Google / Anthropic 原生协议）：返回 BlockedMessage，调用方应直接拒绝；
    /// - 其余：原样返回 apiKey。
    /// </summary>
    public async Task<CallPrep> PrepareForCallAsync(ProviderConfig? cfg, CancellationToken cancellationToken = default)
    {
        if (cfg == null || cfg.AuthMode != "oauth" || string.IsNullOrWhiteSpace(cfg.OauthProvider))
        {
            return new CallPrep(cfg?.ApiKey, EmptyHeaders, null, null);
        }
        var d = OAuthProviders.Get(cfg.OauthProvider);
        if (d == null) return new CallPrep(cfg.ApiKey, EmptyHeaders, null, null);
        if (d.OpenaiBaseUrl == null)
        {
            return new CallPrep(cfg.ApiKey, d.ExtraHeaders, d.ModelsPathOverride,
                $"该厂商为「{d.Title}」订阅登录，令牌仅适用于其专有协议（{d.Note}）。");
        }
        var key = cfg.ApiKey;
        if ((d.DynamicBearer || d.ShortLivedToken) && !string.IsNullOrWhiteSpace(cfg.Id))
        {
            key = await EnsureFreshAccessTokenAsync(cfg, d);
        }
        return new CallPrep(key, d.ExtraHeaders, d.ModelsPathOverride, null);
    }

    /// <summary>短时/派生令牌的到期自动刷新：返回最新可用密钥（刷新失败时退回旧密钥）。</summary>
    private async Task<string> EnsureFreshAccessTokenAsync(ProviderConfig cfg, OAuthProviderDescriptor d)
    {
        var stale = true;
        if (!string.IsNullOrWhiteSpace(cfg.TokenExpiresAt)
            && DateTimeOffset.TryParse(cfg.TokenExpiresAt, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var expiresAt))
        {
            stale = expiresAt.UtcDateTime - DateTime.UtcNow < RefreshAhead;
        }
        if (!stale) return cfg.ApiKey;
        _logger.LogInformation("订阅令牌即将过期，自动刷新: providerId={ProviderId}, type={Type}", cfg.Id, d.Id);
        var result = await RefreshForProviderAsync(cfg.Id);
        if (result.TryGetValue("ok", out var ok) && ok is true)
        {
            var updated = _providerService.Get(cfg.Id);
            if (!string.IsNullOrWhiteSpace(updated?.ApiKey)) return updated!.ApiKey;
        }
        else
        {
            _logger.LogWarning("订阅令牌自动刷新失败，沿用旧令牌尝试调用: {Message}",
                result.TryGetValue("message", out var m) ? m?.ToString() : null);
        }
        return cfg.ApiKey;
    }

    /// <summary>用已保存的 refresh_token 换新 access token 并落库。</summary>
    public async Task<Dictionary<string, object>> RefreshForProviderAsync(string providerId)
    {
        var cfg = _providerService.Get(providerId);
        if (cfg == null) return Fail("提供商不存在");
        if (cfg.AuthMode != "oauth")
            return Fail("该厂商未使用订阅登录，无需刷新令牌");
        var d = OAuthProviders.Get(cfg.OauthProvider);
        if (d == null)
            return Fail($"未知的订阅登录类型: {cfg.OauthProvider}");
        var refreshToken = cfg.RefreshToken;
        if (string.IsNullOrWhiteSpace(refreshToken))
            return Fail("没有可用的刷新令牌，请重新打开浏览器登录");
        try
        {
            string accessToken;
            var newRefresh = refreshToken;
            long fallbackExpiresIn = 3600;
            if (d.Id == "github-copilot")
            {
                // Copilot：GitHub 令牌长效，用它重新换取约 30 分钟有效的 Copilot Bearer
                var derived = await DeriveCopilotBearerAsync(refreshToken);
                accessToken = JsonStr(derived, "token") ?? throw new IOException("Copilot 令牌响应缺少 token");
                var expiresAtSec = JsonLong(derived, "expires_at");
                var refreshIn = JsonLong(derived, "refresh_in");
                long ttl = refreshIn is > 0 ? refreshIn.Value
                    : expiresAtSec.HasValue ? Math.Max(60, expiresAtSec.Value - DateTimeOffset.UtcNow.ToUnixTimeSeconds())
                    : 1500;
                fallbackExpiresIn = ttl;
            }
            else
            {
                var token = await RefreshRequestAsync(d, refreshToken);
                accessToken = JsonStr(token, "access_token") ?? throw new IOException("令牌响应缺少 access_token");
                // 刷新令牌轮换（Anthropic 等）：响应里带新 refresh_token 时必须替换旧值
                var maybeRefresh = JsonStr(token, "refresh_token");
                if (!string.IsNullOrWhiteSpace(maybeRefresh)) newRefresh = maybeRefresh!;
                var expiresIn = JsonLong(token, "expires_in");
                if (expiresIn.HasValue) fallbackExpiresIn = expiresIn.Value;
            }
            var expiresAt = DateTimeOffset.UtcNow.AddSeconds(fallbackExpiresIn).ToString("o");
            // 刷新响应不含账号信息，沿用已有账号字段
            _providerService.ApplyOAuthToken(providerId, d.Id, accessToken,
                newRefresh, expiresAt, cfg.AccountEmail, cfg.PlanName);
            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["provider"] = ProviderService.ToPublic(_providerService.Get(providerId)!),
            };
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "刷新订阅令牌失败: providerId={ProviderId}, type={Type}", providerId, d.Id);
            return Fail($"刷新令牌失败: {e.Message}");
        }
    }

    /// <summary>刷新请求（按注册表分派 form / json）。</summary>
    private async Task<JsonElement> RefreshRequestAsync(OAuthProviderDescriptor d, string refreshToken)
    {
        if (d.JsonExchange)
        {
            var body = new Dictionary<string, object>
            {
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = refreshToken,
                ["client_id"] = d.ClientId,
            };
            return await PostJsonAsync(d.TokenUrl, body, d.UserAgent);
        }
        var form = "grant_type=refresh_token"
                   + "&refresh_token=" + UrlEncode(refreshToken)
                   + "&client_id=" + UrlEncode(d.ClientId);
        if (d.Id == "openai") form += "&scope=" + UrlEncode(d.Scope ?? "");
        return await PostFormAsync(d.TokenUrl, form, d.UserAgent);
    }

    /// <summary>退出订阅登录：清除令牌与账号信息，回退 API Key 模式。非订阅登录厂商直接拒绝，避免误清密钥。</summary>
    public Dictionary<string, object> Logout(string providerId)
    {
        var cfg = _providerService.Get(providerId);
        if (cfg == null) return Fail("提供商不存在");
        if (cfg.AuthMode != "oauth")
            return Fail("该厂商未使用订阅登录，无需退出");
        _providerService.ClearOAuth(providerId);
        return new Dictionary<string, object>
        {
            ["ok"] = true,
            ["provider"] = ProviderService.ToPublic(_providerService.Get(providerId)!),
        };
    }

    private static Dictionary<string, object> Fail(string message) => new() { ["ok"] = false, ["message"] = message };

    // ==================================================================
    // 令牌请求辅助
    // ==================================================================

    private static HttpRequestMessage BuildPostRequest(string url, string contentType, string payload, string? userAgent = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Content = new StringContent(payload, Encoding.UTF8, contentType);
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        // 部分厂商（如 Qwen 的阿里云 WAF）会拦截不带 User-Agent 的请求，按注册表声明带官方 CLI 身份
        req.Headers.TryAddWithoutValidation("User-Agent", userAgent ?? "MafHarness-OAuth/1.0");
        return req;
    }

    private async Task<JsonElement> PostFormAsync(string url, string form, string? userAgent = null)
    {
        using var req = BuildPostRequest(url, "application/x-www-form-urlencoded", form, userAgent);
        return await ExecuteTokenRequestAsync(req);
    }

    private async Task<JsonElement> PostJsonAsync(string url, Dictionary<string, object> body, string? userAgent = null)
    {
        using var req = BuildPostRequest(url, "application/json", JsonSerializer.Serialize(body), userAgent);
        return await ExecuteTokenRequestAsync(req);
    }

    private async Task<JsonElement> ExecuteTokenRequestAsync(HttpRequestMessage req)
    {
        using var client = _httpClientFactory.CreateClient("oauth-token");
        client.Timeout = TimeSpan.FromSeconds(20);
        using var resp = await client.SendAsync(req);
        var body = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode)
        {
            throw new IOException($"HTTP {(int)resp.StatusCode} {Abbreviate(body)}");
        }
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (root.TryGetProperty("error", out var error))
        {
            var errorDesc = root.TryGetProperty("error_description", out var ed) ? ed.GetString() : null;
            throw new IOException($"{error.GetString()}{(string.IsNullOrWhiteSpace(errorDesc) ? "" : $"（{errorDesc}）")}");
        }
        return root.Clone();
    }

    // ==================================================================
    // 账号信息解析（按厂商分派）
    // ==================================================================

    /// <summary>从令牌响应里解析账号信息（邮箱/套餐）与过期时间，写入登录会话。</summary>
    private async Task FillAccountInfoAsync(PendingLogin login, JsonElement token)
    {
        var d = OAuthProviders.Get(login.Type);
        var userInfoAgent = d?.UserAgent;
        login.RefreshToken = JsonStr(token, "refresh_token");
        var expiresIn = JsonLong(token, "expires_in");

        switch (login.Type)
        {
            case "anthropic":
            {
                // Claude 令牌响应自带 account 与 organization
                login.AccessToken = JsonStr(token, "access_token");
                if (token.TryGetProperty("account", out var account) &&
                    account.ValueKind == JsonValueKind.Object &&
                    account.TryGetProperty("email_address", out var email) &&
                    email.ValueKind == JsonValueKind.String)
                {
                    login.AccountEmail = email.GetString();
                }
                var orgName = token.TryGetProperty("organization", out var org) &&
                              org.ValueKind == JsonValueKind.Object &&
                              org.TryGetProperty("name", out var name) &&
                              name.ValueKind == JsonValueKind.String
                    ? name.GetString()
                    : null;
                login.PlanName = string.IsNullOrWhiteSpace(orgName) ? "Claude 订阅" : orgName;
                break;
            }
            case "github-copilot":
            {
                // GitHub 令牌长效，存入 refreshToken；用它在调用时换取短时 Copilot Bearer
                var githubToken = JsonStr(token, "access_token");
                login.RefreshToken = githubToken;
                var derived = await DeriveCopilotBearerAsync(githubToken ?? "");
                login.AccessToken = JsonStr(derived, "token");
                if (string.IsNullOrWhiteSpace(login.AccessToken))
                {
                    throw new InvalidOperationException("换取 Copilot Bearer 失败（copilot_internal/v2/token 无 token 字段）");
                }
                var expiresAtSec = JsonLong(derived, "expires_at");
                var refreshIn = JsonLong(derived, "refresh_in");
                long ttl = refreshIn is > 0 ? refreshIn.Value
                    : expiresAtSec.HasValue ? Math.Max(60, expiresAtSec.Value - DateTimeOffset.UtcNow.ToUnixTimeSeconds())
                    : 1500;
                login.ExpiresAtIso = DateTimeOffset.UtcNow.AddSeconds(ttl).ToString("o");
                await FillCopilotAccountAsync(login, githubToken ?? "");
                login.PlanName ??= "GitHub Copilot";
                login.Status = "success";
                return; // ExpiresAtIso 已单独处理
            }
            case "grok":
            {
                login.AccessToken = JsonStr(token, "access_token");
                var email = await IdTokenEmailAsync(token);
                if (email == null)
                {
                    var info = await FetchJsonWithBearerAsync("https://auth.x.ai/oauth2/userinfo", login.AccessToken, userInfoAgent);
                    email = info.HasValue ? FirstNonNullText(info.Value, "email", "name") : null;
                }
                login.AccountEmail = email;
                login.PlanName = "Grok 订阅（SuperGrok / X Premium+）";
                break;
            }
            case "google":
            {
                login.AccessToken = JsonStr(token, "access_token");
                var info = await FetchJsonWithBearerAsync("https://www.googleapis.com/oauth2/v3/userinfo", login.AccessToken, userInfoAgent);
                login.AccountEmail = info.HasValue ? FirstNonNullText(info.Value, "email", "name") : null;
                login.PlanName = await GooglePlanNameAsync(login.AccessToken);
                break;
            }
            case "qwen":
            {
                login.AccessToken = JsonStr(token, "access_token");
                var info = await FetchJsonWithBearerAsync("https://auth.qwen.ai/api/oauth/userinfo", login.AccessToken, userInfoAgent);
                login.AccountEmail = info.HasValue ? FirstNonNullText(info.Value, "email", "name") : null;
                var memberType = info.HasValue ? JsonStr(info.Value, "member_type") : null;
                login.PlanName = QwenPlanName(memberType);
                break;
            }
            case "kimi":
            {
                login.AccessToken = JsonStr(token, "access_token");
                login.PlanName = "Kimi Code 会员";
                break;
            }
            default:
            {
                // openai：解 id_token JWT 拿 email 与 chatgpt_plan_type
                login.AccessToken = JsonStr(token, "access_token");
                if (token.TryGetProperty("id_token", out var idToken) && idToken.ValueKind == JsonValueKind.String)
                {
                    try
                    {
                        var parts = idToken.GetString()?.Split('.');
                        if (parts is { Length: >= 2 })
                        {
                            var payload = Base64Url.DecodeFromChars(parts[1]);
                            using var claims = JsonDocument.Parse(payload);
                            if (claims.RootElement.TryGetProperty("email", out var email) &&
                                email.ValueKind == JsonValueKind.String)
                            {
                                login.AccountEmail = email.GetString();
                            }
                            if (claims.RootElement.TryGetProperty("https://api.openai.com/auth", out var auth) &&
                                auth.ValueKind == JsonValueKind.Object &&
                                auth.TryGetProperty("chatgpt_plan_type", out var plan) &&
                                plan.ValueKind == JsonValueKind.String)
                            {
                                login.PlanName = ChatGptPlanName(plan.GetString());
                            }
                        }
                    }
                    catch (Exception e)
                    {
                        _logger.LogWarning(e, "解析 id_token 失败，套餐信息不可用");
                    }
                }
                login.PlanName ??= "ChatGPT 订阅";
                break;
            }
        }

        login.ExpiresAtIso ??= DateTimeOffset.UtcNow
            .AddSeconds(expiresIn ?? 3600)
            .ToString("o");
        login.Status = "success";
    }

    /// <summary>Copilot：用 GitHub 令牌换短时 Copilot Bearer（api.githubcopilot.com 的调用凭证）。</summary>
    private async Task<JsonElement> DeriveCopilotBearerAsync(string githubToken)
    {
        try
        {
            using var client = _httpClientFactory.CreateClient("oauth-token");
            client.Timeout = TimeSpan.FromSeconds(15);
            using var req = new HttpRequestMessage(HttpMethod.Get, "https://api.github.com/copilot_internal/v2/token");
            req.Headers.Authorization = new AuthenticationHeaderValue("token", githubToken);
            req.Headers.TryAddWithoutValidation("editor-version", "vscode/1.99.0");
            req.Headers.TryAddWithoutValidation("editor-plugin-version", "copilot-chat/0.26.7");
            req.Headers.TryAddWithoutValidation("user-agent", "GitHubCopilotChat/0.26.7");
            req.Headers.TryAddWithoutValidation("x-github-api-version", "2025-04-01");
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            using var resp = await client.SendAsync(req);
            var body = await resp.Content.ReadAsStringAsync();
            if (!resp.IsSuccessStatusCode)
            {
                throw new IOException($"HTTP {(int)resp.StatusCode} {Abbreviate(body)}");
            }
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.Clone();
        }
        catch (Exception e)
        {
            throw new InvalidOperationException($"换取 Copilot Bearer 失败: {e.Message}", e);
        }
    }

    /// <summary>Copilot 账号信息：GitHub 用户 + 订阅档位。失败不阻塞登录。</summary>
    private async Task FillCopilotAccountAsync(PendingLogin login, string githubToken)
    {
        try
        {
            var user = await FetchJsonWithAuthorizationAsync("https://api.github.com/user", "token " + githubToken,
                new Dictionary<string, string> { ["x-github-api-version"] = "2025-04-01" });
            if (user.HasValue)
            {
                var email = JsonStr(user.Value, "email");
                var loginName = JsonStr(user.Value, "login");
                login.AccountEmail = !string.IsNullOrWhiteSpace(email) ? email : loginName;
            }
            var plan = await FetchJsonWithAuthorizationAsync("https://api.github.com/copilot_internal/user", "token " + githubToken,
                new Dictionary<string, string> { ["x-github-api-version"] = "2025-04-01" });
            if (plan.HasValue)
            {
                login.PlanName = CopilotPlanName(JsonStr(plan.Value, "copilot_plan"));
            }
        }
        catch (Exception e)
        {
            _logger.LogWarning("获取 Copilot 账号信息失败（不影响登录）: {Message}", e.Message);
        }
    }

    private static string CopilotPlanName(string? plan) => plan switch
    {
        null => "GitHub Copilot",
        "free" => "Copilot Free",
        "pro" => "Copilot Pro",
        "pro_plus" or "pro+" => "Copilot Pro+",
        "business" => "Copilot Business",
        "enterprise" => "Copilot Enterprise",
        _ => $"GitHub Copilot ({plan})",
    };

    private static string QwenPlanName(string? memberType)
    {
        if (string.IsNullOrWhiteSpace(memberType)) return "Qwen 订阅";
        return memberType switch
        {
            "plus" => "Qwen Plus 订阅",
            "pro" => "Qwen Pro 订阅",
            "free" => "Qwen 免费账号",
            _ => $"Qwen 订阅 ({memberType})",
        };
    }

    /// <summary>Google：Code Assist 档位（loadCodeAssist）；失败回退「Google 账号」。</summary>
    private async Task<string> GooglePlanNameAsync(string? accessToken)
    {
        try
        {
            var payload = JsonSerializer.Serialize(new
            {
                metadata = new
                {
                    ideType = "IDE_UNSPECIFIED",
                    platform = "PLATFORM_UNSPECIFIED",
                    pluginType = "GEMINI",
                },
            });
            using var client = _httpClientFactory.CreateClient("oauth-token");
            client.Timeout = TimeSpan.FromSeconds(15);
            using var req = new HttpRequestMessage(HttpMethod.Post, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            req.Content = new StringContent(payload, Encoding.UTF8, "application/json");
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            using var resp = await client.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("loadCodeAssist 查询套餐失败: HTTP {Status}", (int)resp.StatusCode);
                return "Google 账号";
            }
            var body = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            string? tier = null;
            if (root.TryGetProperty("currentTier", out var tierEl) && tierEl.ValueKind == JsonValueKind.Object)
            {
                tier = JsonStr(tierEl, "id") ?? JsonStr(tierEl, "tierId");
            }
            if (tier == null) return "Google 账号";
            return tier switch
            {
                "free-tier" => "Gemini Code Assist 免费档",
                "legacy-tier" => "Gemini Code Assist (Legacy)",
                "standard-tier" => "Gemini Code Assist Standard",
                _ => $"Gemini Code Assist ({tier})",
            };
        }
        catch (Exception e)
        {
            _logger.LogWarning("查询 Code Assist 套餐失败（不影响登录）: {Message}", e.Message);
            return "Google 账号";
        }
    }

    /// <summary>用 Bearer 令牌 GET 一个 JSON 端点（失败返回 null，不抛异常）。</summary>
    private Task<JsonElement?> FetchJsonWithBearerAsync(string url, string? bearerToken, string? userAgent = null) =>
        FetchJsonWithAuthorizationAsync(url, "Bearer " + bearerToken, new Dictionary<string, string>(), userAgent);

    private async Task<JsonElement?> FetchJsonWithAuthorizationAsync(
        string url, string authorization, IReadOnlyDictionary<string, string> extraHeaders, string? userAgent = null)
    {
        try
        {
            using var client = _httpClientFactory.CreateClient("oauth-token");
            client.Timeout = TimeSpan.FromSeconds(15);
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            req.Headers.TryAddWithoutValidation("Authorization", authorization);
            req.Headers.TryAddWithoutValidation("User-Agent", userAgent ?? "MafHarness-OAuth/1.0");
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            foreach (var (name, value) in extraHeaders)
            {
                req.Headers.TryAddWithoutValidation(name, value);
            }
            using var resp = await client.SendAsync(req);
            if (!resp.IsSuccessStatusCode) return null;
            var body = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.Clone();
        }
        catch (Exception e)
        {
            _logger.LogWarning("GET {Url} 失败: {Message}", url, e.Message);
            return null;
        }
    }

    private static string? FirstNonNullText(JsonElement node, params string[] fields)
    {
        foreach (var field in fields)
        {
            var value = JsonStr(node, field);
            if (!string.IsNullOrWhiteSpace(value)) return value;
        }
        return null;
    }

    /// <summary>解析 id_token JWT 的 payload（不验签，仅展示用）：取 email。</summary>
    private async Task<string?> IdTokenEmailAsync(JsonElement token)
    {
        if (!token.TryGetProperty("id_token", out var idToken) || idToken.ValueKind != JsonValueKind.String) return null;
        try
        {
            var parts = idToken.GetString()?.Split('.');
            if (parts is { Length: >= 2 })
            {
                var payload = Base64Url.DecodeFromChars(parts[1]);
                using var claims = JsonDocument.Parse(payload);
                return JsonStr(claims.RootElement, "email");
            }
        }
        catch (Exception e)
        {
            _logger.LogWarning("解析 id_token 失败: {Message}", e.Message);
        }
        return null;
    }

    private static string ChatGptPlanName(string? planType) => planType switch
    {
        null => "ChatGPT 订阅",
        "free" => "ChatGPT Free",
        "plus" => "ChatGPT Plus",
        "pro" => "ChatGPT Pro",
        "team" => "ChatGPT Team",
        "enterprise" => "ChatGPT Enterprise",
        "edu" => "ChatGPT Edu",
        _ => $"ChatGPT 订阅 ({planType})",
    };

    private void StopListenerLater(PendingLogin login)
    {
        // 回调响应写完后延迟关闭，保证浏览器能收到页面
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(1));
            StopListener(login);
        });
    }

    private void StopListener(PendingLogin login)
    {
        try
        {
            login.Server?.Stop();
        }
        catch { }
        login.Server = null;
    }

    // ==================================================================
    // URL / PKCE / 回环监听辅助
    // ==================================================================

    private static string BuildAuthorizeUrl(OAuthProviderDescriptor d, string redirectUri, string? challenge, string state)
    {
        var sb = new StringBuilder();
        sb.Append(d.AuthorizeUrl)
          .Append("?response_type=code")
          .Append("&client_id=").Append(UrlEncode(d.ClientId))
          .Append("&redirect_uri=").Append(UrlEncode(redirectUri));
        if (d.Scope != null) sb.Append("&scope=").Append(UrlEncode(d.Scope));
        if (challenge != null)
        {
            sb.Append("&code_challenge=").Append(UrlEncode(challenge))
              .Append("&code_challenge_method=S256");
        }
        sb.Append("&state=").Append(UrlEncode(state));
        if (!string.IsNullOrWhiteSpace(d.ExtraAuthorizeParams))
        {
            sb.Append('&').Append(d.ExtraAuthorizeParams);
        }
        // Grok 与官方 Grok Build 一致，授权请求带随机 nonce
        if (d.Id == "grok")
        {
            sb.Append("&nonce=").Append(UrlEncode(Guid.NewGuid().ToString()));
        }
        return sb.ToString();
    }

    private static int AllocatePort()
    {
        foreach (var p in PreferredPorts)
        {
            try
            {
                // 直接尝试绑定回环端口检查占用（例如 Codex CLI 正在运行则换下一个）
                using var probe = new TcpListener(IPAddress.Loopback, p);
                probe.Start();
                probe.Stop();
                return p;
            }
            catch
            {
                // 端口被占用，尝试下一个
            }
        }
        // 全部占用则由系统分配随机可用端口
        var sock = new TcpListener(IPAddress.Loopback, 0);
        sock.Start();
        var port = ((IPEndPoint)sock.LocalEndpoint).Port;
        sock.Stop();
        return port;
    }

    private static string RandomBase64Url(int numBytes)
    {
        var buf = RandomNumberGenerator.GetBytes(numBytes);
        return Base64Url.EncodeToString(buf);
    }

    private static string S256Challenge(string verifier)
    {
        var digest = SHA256.HashData(Encoding.ASCII.GetBytes(verifier));
        return Base64Url.EncodeToString(digest);
    }

    private static string UrlEncode(string value) => Uri.EscapeDataString(value);

    private static Dictionary<string, string> ParseQuery(string? rawQuery)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(rawQuery)) return result;
        var query = rawQuery!.StartsWith('?') ? rawQuery[1..] : rawQuery;
        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            if (eq < 0)
            {
                result.TryAdd(Uri.UnescapeDataString(pair), "");
            }
            else
            {
                result[Uri.UnescapeDataString(pair[..eq])] = Uri.UnescapeDataString(pair[(eq + 1)..]);
            }
        }
        return result;
    }

    private static string? JsonStr(JsonElement el, string name) =>
        el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static long? JsonLong(JsonElement el, string name) =>
        el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var l) ? l : null;

    private static string Abbreviate(string? s)
    {
        if (s == null) return "";
        return s.Length <= 10 ? s : s[..10] + "…";
    }

    private static string EscapeHtml(string? text)
    {
        if (text == null) return "";
        return text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
            .Replace("\"", "&quot;");
    }

    /// <summary>回调页面：授权完成后浏览器里看到的提示页（自动尝试关闭）。</summary>
    private static string htmlPage(bool success, string title, string detail)
    {
        var color = success ? "#34d399" : "#fb7185";
        return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>" + title
               + " - Microsoft agent</title><style>"
               + "body{font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;display:flex;"
               + "min-height:100vh;align-items:center;justify-content:center;background:#101013;color:#f4f4f5;margin:0}"
               + ".card{max-width:460px;padding:36px 40px;border-radius:16px;border:1px solid rgba(255,255,255,.12);"
               + "background:#17171b;text-align:center}h1{font-size:18px;margin:0 0 12px;color:" + color + "}"
               + "p{font-size:13px;color:#a1a1aa;line-height:1.7;word-break:break-all;margin:6px 0}</style></head><body>"
               + "<div class=\"card\"><h1>" + (success ? "✅ " : "❌ ") + EscapeHtml(title) + "</h1>"
               + "<p>" + EscapeHtml(detail) + "</p>"
               + "<p>本页面由本地服务临时启动，稍后会自动尝试关闭，请返回应用查看登录状态。</p></div>"
               + "<script>setTimeout(function(){window.close()},2000)</script></body></html>";
    }

    /// <summary>
    /// 本地回环回调服务器：直接以 <see cref="TcpListener"/> 实现。HttpListener 只有
    /// localhost 前缀免 URL ACL，而 Grok / Google 官方客户端要求回调 host 固定
    /// 127.0.0.1，故统一改为自实现的最小 HTTP 服务（绑定回环、处理一次 GET、
    /// 返回提示页后关闭连接），任意端口与 host 均无需管理员权限。
    /// </summary>
    public sealed class LoopbackCallbackServer
    {
        private readonly TcpListener _listener;
        private readonly Func<string, Task<string>> _handler;
        private volatile bool _stopped;

        public LoopbackCallbackServer(int port, Func<string, Task<string>> handler)
        {
            _listener = new TcpListener(IPAddress.Loopback, port);
            _handler = handler;
        }

        public void Start()
        {
            _listener.Start();
            _ = Task.Run(AcceptLoopAsync);
        }

        private async Task AcceptLoopAsync()
        {
            while (!_stopped)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync();
                }
                catch
                {
                    break; // 监听已停止（超时清理/完成收尾），正常退出
                }
                _ = Task.Run(() => HandleClientAsync(client));
            }
        }

        private async Task HandleClientAsync(TcpClient client)
        {
            try
            {
                using var _ = client;
                var stream = client.GetStream();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                var buffer = new byte[8192];
                var request = new StringBuilder();
                while (request.Length < 32 * 1024)
                {
                    var read = await stream.ReadAsync(buffer, timeout.Token);
                    if (read == 0) break;
                    request.Append(Encoding.UTF8.GetString(buffer, 0, read));
                    if (request.ToString().Contains("\r\n\r\n", StringComparison.Ordinal)) break;
                }
                // 请求行：GET /path?query HTTP/1.1
                var target = "";
                var firstLine = request.ToString().Split("\r\n").FirstOrDefault() ?? "";
                if (firstLine.StartsWith("GET ", StringComparison.OrdinalIgnoreCase))
                {
                    var parts = firstLine.Split(' ');
                    if (parts.Length >= 2) target = parts[1];
                }
                string html;
                try
                {
                    html = await _handler(target);
                }
                catch
                {
                    html = htmlPage(false, "登录失败", "回调处理异常，请返回应用重试");
                }
                var body = Encoding.UTF8.GetBytes(html);
                var head = Encoding.ASCII.GetBytes(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                    + "Content-Length: " + body.Length + "\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(head, timeout.Token);
                await stream.WriteAsync(body, timeout.Token);
                await stream.FlushAsync(timeout.Token);
            }
            catch
            {
                // 连接中断（浏览器取消/超时）无需处理
            }
        }

        public void Stop()
        {
            _stopped = true;
            try
            {
                _listener.Stop();
            }
            catch { }
        }
    }
}
