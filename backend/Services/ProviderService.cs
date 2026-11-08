using System.Text.Json;
using MafHarness.Web.Models;

namespace MafHarness.Web.Services;

public sealed class ProviderService
{
    private readonly string _storagePath;
    private readonly List<ProviderConfig> _providers = [];
    private readonly HttpClient _httpClient = new() { Timeout = TimeSpan.FromSeconds(10) };

    public ProviderService(IConfiguration configuration)
    {
        var dataDir = Path.Combine(AppContext.BaseDirectory, ".data");
        Directory.CreateDirectory(dataDir);
        _storagePath = Path.Combine(dataDir, "providers.json");

        Load();

        if (_providers.Count == 0)
        {
            var defaultKey = configuration["Llm:ApiKey"] ?? string.Empty;
            var defaultUrl = configuration["Llm:EndPoint"] ?? "https://discovery-api.intern-ai.org.cn/v1";
            var defaultModel = configuration["Llm:ModelId"] ?? "Atria-Dawn-Preview";

            _providers.Add(new ProviderConfig
            {
                Id = "atria-default",
                Type = "openai-compatible",
                Name = "Atria (官方预设)",
                Label = "Atria (官方预设)",
                BaseUrl = defaultUrl,
                ApiKey = defaultKey,
                DefaultModel = defaultModel,
                Models = [defaultModel, "Agents-A1", "deepseek-chat", "deepseek-reasoner"],
                Enabled = true
            });
            Save();
        }
        else
        {
            // 修复历史数据可能缺失 Label 的问题
            bool updated = false;
            foreach (var p in _providers)
            {
                if (string.IsNullOrWhiteSpace(p.Label) && !string.IsNullOrWhiteSpace(p.Name))
                {
                    p.Label = p.Name;
                    updated = true;
                }
                else if (string.IsNullOrWhiteSpace(p.Name) && !string.IsNullOrWhiteSpace(p.Label))
                {
                    p.Name = p.Label;
                    updated = true;
                }
            }
            if (updated) Save();
        }
    }

    public List<ProviderConfig> List() => [.. _providers];

    public ProviderConfig? Get(string id) => _providers.FirstOrDefault(p => p.Id == id);

    public ProviderConfig? GetActive(string? providerId)
    {
        if (!string.IsNullOrWhiteSpace(providerId))
        {
            var found = Get(providerId);
            if (found != null && found.Enabled) return found;
        }
        return _providers.FirstOrDefault(p => p.Enabled);
    }

    public ProviderConfig Create(ProviderInput input)
    {
        var id = "p-" + Guid.NewGuid().ToString("N")[..8];
        var displayName = input.Label ?? input.Name ?? "自定义提供商";
        var config = new ProviderConfig
        {
            Id = id,
            Type = input.Type ?? "openai-compatible",
            Name = displayName,
            Label = displayName,
            BaseUrl = input.BaseUrl ?? "https://api.openai.com/v1",
            ApiKey = input.ApiKey ?? string.Empty,
            DefaultModel = input.DefaultModel ?? "gpt-4o",
            Models = input.Models ?? (input.DefaultModel != null ? [input.DefaultModel] : ["gpt-4o"]),
            Enabled = input.Enabled ?? true,
            Reasoning = input.Reasoning,
            AuthMode = input.AuthMode == "oauth" ? "oauth" : "api-key",
            CreatedAt = DateTime.UtcNow.ToString("o"),
            UpdatedAt = DateTime.UtcNow.ToString("o")
        };
        _providers.Add(config);
        Save();
        return config;
    }

    public ProviderConfig? Update(string id, ProviderInput input)
    {
        var p = Get(id);
        if (p == null) return null;

        var displayName = input.Label ?? input.Name;
        if (displayName != null)
        {
            p.Label = displayName;
            p.Name = displayName;
        }
        if (input.Type != null) p.Type = input.Type;
        if (input.BaseUrl != null) p.BaseUrl = input.BaseUrl;
        if (input.ApiKey != null) p.ApiKey = input.ApiKey;
        if (input.DefaultModel != null) p.DefaultModel = input.DefaultModel;
        if (input.Models != null) p.Models = input.Models;
        if (input.Enabled.HasValue) p.Enabled = input.Enabled.Value;
        if (input.Reasoning != null) p.Reasoning = input.Reasoning;
        if (input.AuthMode != null)
        {
            p.AuthMode = input.AuthMode == "oauth" ? "oauth" : "api-key";
        }
        p.UpdatedAt = DateTime.UtcNow.ToString("o");

        Save();
        return p;
    }

    /// <summary>
    /// 把一次订阅登录（OAuth）拿到的令牌与账号信息落到指定厂商上：
    /// access token 直接写入现有 ApiKey 字段，下游 OpenAI 客户端调用链零改动。
    /// </summary>
    public ProviderConfig? ApplyOAuthToken(
        string id, string? oauthProvider, string? accessToken, string? refreshToken,
        string? tokenExpiresAt, string? accountEmail, string? planName)
    {
        var existing = Get(id);
        if (existing == null) return null;
        existing.ApiKey = accessToken ?? string.Empty;
        existing.RefreshToken = refreshToken;
        existing.TokenExpiresAt = tokenExpiresAt;
        existing.AccountEmail = accountEmail;
        existing.PlanName = planName;
        existing.OauthProvider = oauthProvider;
        existing.AuthMode = "oauth";
        existing.UpdatedAt = DateTime.UtcNow.ToString("o");

        Save();
        return existing;
    }

    /// <summary>清除订阅登录态：清空令牌与账号信息并回退为 API Key 模式。</summary>
    public ProviderConfig? ClearOAuth(string id)
    {
        var existing = Get(id);
        if (existing == null) return null;
        existing.ApiKey = string.Empty;
        existing.RefreshToken = null;
        existing.TokenExpiresAt = null;
        existing.AccountEmail = null;
        existing.PlanName = null;
        existing.OauthProvider = null;
        existing.AuthMode = "api-key";
        existing.UpdatedAt = DateTime.UtcNow.ToString("o");

        Save();
        return existing;
    }

    public bool Remove(string id)
    {
        var count = _providers.RemoveAll(p => p.Id == id);
        if (count > 0)
        {
            Save();
            return true;
        }
        return false;
    }

    /// <summary>
    /// 探测远程模型列表。
    /// </summary>
    /// <param name="prep">订阅登录厂商的调用准备（密钥/附加头/模型路径），由控制器用
    /// OAuthService.PrepareForCallAsync 生成；API Key 厂商传 null</param>
    public async Task<Dictionary<string, object>> FetchModelsAsync(ProviderConfig provider, OAuthService.CallPrep? prep = null)
    {
        var result = new Dictionary<string, object>();
        var apiKey = provider.ApiKey;
        var extraHeaders = (IReadOnlyDictionary<string, string>)new Dictionary<string, string>();
        if (prep != null)
        {
            // 协议不兼容的订阅厂商（Google / Anthropic 原生协议）：不假装支持，直接返回屏蔽原因
            if (prep.BlockedMessage != null)
            {
                return new Dictionary<string, object>
                {
                    ["ok"] = false,
                    ["errorKind"] = "unsupported",
                    ["message"] = prep.BlockedMessage,
                    ["models"] = new List<string>(),
                };
            }
            if (!string.IsNullOrWhiteSpace(prep.ApiKey)) apiKey = prep.ApiKey;
            if (prep.ExtraHeaders.Count > 0) extraHeaders = prep.ExtraHeaders;
        }
        try
        {
            var url = provider.BaseUrl.TrimEnd('/') + (prep?.ModelsPathOverride ?? "/models");
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
            }
            foreach (var (name, value) in extraHeaders)
            {
                req.Headers.TryAddWithoutValidation(name, value);
            }

            var resp = await _httpClient.SendAsync(req);
            if (resp.IsSuccessStatusCode)
            {
                var json = await resp.Content.ReadAsStringAsync();
                var doc = JsonDocument.Parse(json);
                var models = new List<string>();
                if (doc.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in data.EnumerateArray())
                    {
                        if (item.TryGetProperty("id", out var idProp))
                        {
                            var modelName = idProp.GetString();
                            if (!string.IsNullOrWhiteSpace(modelName))
                            {
                                models.Add(modelName);
                            }
                        }
                    }
                }

                // 关键点：获取模型成功后，自动合并保存至当前提供商，使得输入框和全局列表立即生效！
                if (models.Count > 0)
                {
                    var merged = new List<string>(provider.Models);
                    foreach (var m in models)
                    {
                        if (!string.IsNullOrWhiteSpace(m) && !merged.Contains(m))
                        {
                            merged.Add(m);
                        }
                    }
                    provider.Models = merged;
                    if (string.IsNullOrWhiteSpace(provider.DefaultModel) || !merged.Contains(provider.DefaultModel))
                    {
                        provider.DefaultModel = merged.FirstOrDefault() ?? string.Empty;
                    }
                    provider.UpdatedAt = DateTime.UtcNow.ToString("o");
                    Save();
                }

                result["ok"] = true;
                result["models"] = models;
                return result;
            }

            result["ok"] = false;
            result["errorKind"] = "http";
            result["error"] = $"HTTP {(int)resp.StatusCode}";
            result["message"] = $"HTTP 状态码: {(int)resp.StatusCode}";
            result["models"] = new List<string>();
        }
        catch (Exception ex)
        {
            result["ok"] = false;
            result["errorKind"] = "network";
            result["error"] = ex.Message;
            result["message"] = $"网络连接错误: {ex.Message}";
            result["models"] = new List<string>();
        }
        return result;
    }

    /// <summary>
    /// 简单测试大模型连通性。
    /// </summary>
    /// <param name="prep">订阅登录厂商的调用准备（密钥/附加头），API Key 厂商传 null</param>
    public async Task<Dictionary<string, object>> TestModelAsync(ProviderConfig provider, string? modelId, OAuthService.CallPrep? prep = null)
    {
        var model = string.IsNullOrWhiteSpace(modelId) ? provider.DefaultModel : modelId;
        var start = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var apiKey = provider.ApiKey;
        var extraHeaders = (IReadOnlyDictionary<string, string>)new Dictionary<string, string>();
        if (prep != null)
        {
            // 协议不兼容的订阅厂商（Google / Anthropic 原生协议）：不假装支持，直接返回屏蔽原因
            if (prep.BlockedMessage != null)
            {
                return new Dictionary<string, object>
                {
                    ["ok"] = false,
                    ["message"] = prep.BlockedMessage,
                };
            }
            if (!string.IsNullOrWhiteSpace(prep.ApiKey)) apiKey = prep.ApiKey;
            if (prep.ExtraHeaders.Count > 0) extraHeaders = prep.ExtraHeaders;
        }
        try
        {
            var url = provider.BaseUrl.TrimEnd('/') + "/chat/completions";
            using var req = new HttpRequestMessage(HttpMethod.Post, url);
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
            }
            foreach (var (name, value) in extraHeaders)
            {
                req.Headers.TryAddWithoutValidation(name, value);
            }

            var body = new
            {
                model,
                messages = new[] { new { role = "user", content = "Hi" } },
                max_tokens = 5
            };
            req.Content = new StringContent(JsonSerializer.Serialize(body), System.Text.Encoding.UTF8, "application/json");

            var resp = await _httpClient.SendAsync(req);
            var duration = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - start;

            if (resp.IsSuccessStatusCode)
            {
                return new Dictionary<string, object>
                {
                    ["ok"] = true,
                    ["latencyMs"] = duration,
                    ["model"] = model ?? string.Empty,
                    ["modelId"] = model ?? string.Empty,
                    ["reply"] = "连接成功"
                };
            }

            return new Dictionary<string, object>
            {
                ["ok"] = false,
                ["error"] = $"HTTP {(int)resp.StatusCode}",
                ["message"] = $"接口返回异常 HTTP {(int)resp.StatusCode}",
                ["latencyMs"] = duration
            };
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object>
            {
                ["ok"] = false,
                ["error"] = ex.Message,
                ["message"] = $"连通性测试失败: {ex.Message}",
                ["latencyMs"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - start
            };
        }
    }

    public static PublicProvider ToPublic(ProviderConfig p)
    {
        var masked = string.IsNullOrWhiteSpace(p.ApiKey)
            ? string.Empty
            : p.ApiKey.Length > 8
                ? p.ApiKey[..4] + "••••" + p.ApiKey[^4..]
                : "••••";

        var label = !string.IsNullOrWhiteSpace(p.Label)
            ? p.Label
            : (!string.IsNullOrWhiteSpace(p.Name) ? p.Name : "自定义提供商");

        return new PublicProvider
        {
            Id = p.Id,
            Type = string.IsNullOrWhiteSpace(p.Type) ? "openai-compatible" : p.Type,
            Name = label,
            Label = label,
            BaseUrl = p.BaseUrl,
            DefaultModel = p.DefaultModel,
            Models = p.Models,
            Enabled = p.Enabled,
            HasApiKey = !string.IsNullOrWhiteSpace(p.ApiKey),
            ApiKeyMask = masked,
            ApiKeyMasked = masked,
            Reasoning = p.Reasoning,
            CreatedAt = p.CreatedAt,
            UpdatedAt = p.UpdatedAt,
            // 订阅登录状态与账号信息（绝不暴露 RefreshToken / 明文令牌）
            AuthMode = p.AuthMode == "oauth" ? "oauth" : "api-key",
            OauthProvider = p.OauthProvider,
            HasRefreshToken = !string.IsNullOrWhiteSpace(p.RefreshToken),
            TokenExpiresAt = p.TokenExpiresAt,
            AccountEmail = p.AccountEmail,
            PlanName = p.PlanName
        };
    }

    private void Load()
    {
        if (File.Exists(_storagePath))
        {
            try
            {
                var list = JsonSerializer.Deserialize<List<ProviderConfig>>(File.ReadAllText(_storagePath));
                if (list != null)
                {
                    _providers.Clear();
                    _providers.AddRange(list);
                }
            }
            catch { }
        }
    }

    private void Save()
    {
        try
        {
            File.WriteAllText(_storagePath, JsonSerializer.Serialize(_providers, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { }
    }
}
