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
        p.UpdatedAt = DateTime.UtcNow.ToString("o");

        Save();
        return p;
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

    public async Task<Dictionary<string, object>> FetchModelsAsync(ProviderConfig provider)
    {
        var result = new Dictionary<string, object>();
        try
        {
            var url = provider.BaseUrl.TrimEnd('/') + "/models";
            using var req = new HttpRequestMessage(HttpMethod.Get, url);
            if (!string.IsNullOrWhiteSpace(provider.ApiKey))
            {
                req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", provider.ApiKey);
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
            result["error"] = $"HTTP {resp.StatusCode}";
        }
        catch (Exception ex)
        {
            result["ok"] = false;
            result["error"] = ex.Message;
        }
        return result;
    }

    public async Task<Dictionary<string, object>> TestModelAsync(ProviderConfig provider, string? modelId)
    {
        var model = string.IsNullOrWhiteSpace(modelId) ? provider.DefaultModel : modelId;
        var start = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        try
        {
            var url = provider.BaseUrl.TrimEnd('/') + "/chat/completions";
            using var req = new HttpRequestMessage(HttpMethod.Post, url);
            if (!string.IsNullOrWhiteSpace(provider.ApiKey))
            {
                req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", provider.ApiKey);
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
                    ["model"] = model ?? string.Empty
                };
            }

            return new Dictionary<string, object>
            {
                ["ok"] = false,
                ["error"] = $"HTTP {(int)resp.StatusCode}",
                ["latencyMs"] = duration
            };
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object>
            {
                ["ok"] = false,
                ["error"] = ex.Message,
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
            UpdatedAt = p.UpdatedAt
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
