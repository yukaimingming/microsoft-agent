using System.Text;
using System.Text.Json;
using MafHarness.Web.Models;

namespace MafHarness.Web.Services;

/// <summary>
/// 厂商余额查询服务（API Key 厂商）。
///
/// 各家接口（2026-11 联网核实，与姊妹项目 agentscope-harness 同源）：
/// - DeepSeek：GET https://api.deepseek.com/user/balance（Bearer），返回
///   balance_infos[0]：{currency, total_balance, granted_balance, topped_up_balance}
/// - Moonshot（Kimi）：GET {origin}/v1/users/me/balance（Bearer），返回
///   data：{available_balance, voucher_balance}（人民币）
/// - SiliconFlow（硅基流动）：GET {origin}/v1/user/info（Bearer），返回
///   data：{totalBalance, chargeBalance, grantedBalance?...}
///
/// 统一返回结构：{ok, vendor?, currency, balance, granted, toppedUp, used, message?}。
/// </summary>
public sealed class ProviderBalanceService
{
    private readonly ILogger<ProviderBalanceService> _logger;
    private readonly IHttpClientFactory _httpClientFactory;

    public ProviderBalanceService(ILogger<ProviderBalanceService> logger, IHttpClientFactory httpClientFactory)
    {
        _logger = logger;
        _httpClientFactory = httpClientFactory;
    }

    public async Task<Dictionary<string, object?>> QueryBalanceAsync(ProviderConfig provider)
    {
        var result = new Dictionary<string, object?>();
        var apiKey = provider.ApiKey?.Trim() ?? "";
        if (apiKey.Length == 0)
        {
            result["ok"] = false;
            result["message"] = "未配置密钥，无法查询余额";
            return result;
        }
        var baseUrl = provider.BaseUrl?.Trim() ?? "";
        var host = ParseHost(baseUrl);
        if (host == null)
        {
            result["ok"] = false;
            result["message"] = $"无法识别的 Base URL: {baseUrl}";
            return result;
        }
        try
        {
            if (host.Contains("deepseek"))
            {
                return await QueryDeepSeekAsync(apiKey, result);
            }
            if (host.Contains("moonshot"))
            {
                return await QueryMoonshotAsync(Origin(baseUrl), apiKey, result);
            }
            if (host.Contains("siliconflow"))
            {
                return await QuerySiliconFlowAsync(Origin(baseUrl), apiKey, result);
            }
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "查询余额失败: providerId={ProviderId}, host={Host}", provider.Id, host);
            result["ok"] = false;
            result["message"] = $"网络连接错误: {e.Message}";
            return result;
        }
        result["ok"] = false;
        result["message"] = "该厂商暂不支持余额查询（当前支持 DeepSeek / Moonshot Kimi / SiliconFlow）";
        return result;
    }

    // DeepSeek：GET https://api.deepseek.com/user/balance
    private async Task<Dictionary<string, object?>> QueryDeepSeekAsync(string apiKey, Dictionary<string, object?> result)
    {
        var (status, body) = await GetAsync("https://api.deepseek.com/user/balance", apiKey);
        if (status != 200) return HttpError(result, status);
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("balance_infos", out var infos) || infos.ValueKind != JsonValueKind.Array || infos.GetArrayLength() == 0)
        {
            result["ok"] = false;
            result["message"] = "响应缺少 balance_infos 字段，无法解析余额";
            return result;
        }
        var info = infos[0];
        result["ok"] = true;
        result["vendor"] = "deepseek";
        result["currency"] = TextOr(info, "currency", "CNY");
        result["balance"] = TextOrNull(info, "total_balance");
        result["granted"] = TextOrNull(info, "granted_balance");
        result["toppedUp"] = TextOrNull(info, "topped_up_balance");
        result["used"] = null;
        return result;
    }

    // Moonshot：GET {origin}/v1/users/me/balance（api.moonshot.cn 或 .ai 均可）
    private async Task<Dictionary<string, object?>> QueryMoonshotAsync(string origin, string apiKey, Dictionary<string, object?> result)
    {
        var (status, body) = await GetAsync(origin + "/v1/users/me/balance", apiKey);
        if (status != 200) return HttpError(result, status);
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
        {
            result["ok"] = false;
            result["message"] = "响应缺少 data 字段，无法解析余额";
            return result;
        }
        result["ok"] = true;
        result["vendor"] = "moonshot";
        result["currency"] = "CNY";
        result["balance"] = TextOrNull(data, "available_balance");
        result["granted"] = TextOrNull(data, "voucher_balance");
        result["toppedUp"] = null;
        result["used"] = null;
        return result;
    }

    // SiliconFlow：GET {origin}/v1/user/info（api.siliconflow.cn / .com）
    private async Task<Dictionary<string, object?>> QuerySiliconFlowAsync(string origin, string apiKey, Dictionary<string, object?> result)
    {
        var (status, body) = await GetAsync(origin + "/v1/user/info", apiKey);
        if (status != 200) return HttpError(result, status);
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
        {
            result["ok"] = false;
            result["message"] = "响应缺少 data 字段，无法解析余额";
            return result;
        }
        // totalBalance 为总额（社区反馈 balance 字段语义不稳定，优先 totalBalance）
        var total = TextOrNull(data, "totalBalance") ?? TextOrNull(data, "balance");
        result["ok"] = true;
        result["vendor"] = "siliconflow";
        result["currency"] = "CNY";
        result["balance"] = total;
        result["granted"] = TextOrNull(data, "grantedBalance");
        result["toppedUp"] = TextOrNull(data, "chargeBalance");
        result["used"] = null;
        return result;
    }

    private async Task<(int Status, string Body)> GetAsync(string url, string apiKey)
    {
        using var client = _httpClientFactory.CreateClient("provider-balance");
        client.Timeout = TimeSpan.FromSeconds(15);
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
        req.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
        using var resp = await client.SendAsync(req);
        var body = await resp.Content.ReadAsStringAsync();
        return ((int)resp.StatusCode, body);
    }

    private static Dictionary<string, object?> HttpError(Dictionary<string, object?> result, int status)
    {
        result["ok"] = false;
        result["message"] = status switch
        {
            401 => "API Key 无效或已过期（HTTP 401），请检查密钥配置",
            403 => "API Key 没有余额查询权限（HTTP 403）",
            404 => "余额接口不存在（HTTP 404），请确认 Base URL 配置",
            429 => "请求过于频繁（HTTP 429），请稍后重试",
            _ => $"余额接口返回异常 HTTP {status}",
        };
        return result;
    }

    private static string? ParseHost(string? baseUrl)
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) return null;
        try
        {
            var uri = new Uri(baseUrl);
            return uri.Host.ToLowerInvariant();
        }
        catch
        {
            return null;
        }
    }

    private static string Origin(string baseUrl)
    {
        var uri = new Uri(baseUrl.Trim());
        return uri.Scheme + "://" + uri.Host + (uri.Port > 0 && !uri.IsDefaultPort ? ":" + uri.Port : "");
    }

    private static string? TextOr(JsonElement node, string field, string? fallback)
    {
        return node.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String
            ? (string.IsNullOrWhiteSpace(value.GetString()) ? fallback : value.GetString())
            : fallback;
    }

    private static string? TextOrNull(JsonElement node, string field) => TextOr(node, field, null);
}
