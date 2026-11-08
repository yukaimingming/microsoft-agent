using MafHarness.Web.Models;
using MafHarness.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace MafHarness.Web.Controllers;

[ApiController]
[Route("api/providers")]
public sealed class ProviderController : ControllerBase
{
    private readonly ILogger<ProviderController> _logger;
    private readonly ProviderService _providerService;
    private readonly ProviderBalanceService _balanceService;
    private readonly OAuthService _oauthService;

    public ProviderController(ILogger<ProviderController> logger, ProviderService providerService,
        ProviderBalanceService balanceService, OAuthService oauthService)
    {
        _logger = logger;
        _providerService = providerService;
        _balanceService = balanceService;
        _oauthService = oauthService;
    }

    [HttpGet]
    public IActionResult ListProviders()
    {
        var list = _providerService.List().Select(ProviderService.ToPublic).ToList();
        return Ok(new { providers = list });
    }

    [HttpPost]
    public async Task<IActionResult> CreateProvider([FromBody] ProviderInput input)
    {
        var created = _providerService.Create(input);
        await ApplyPendingOAuthAsync(created, input);
        return StatusCode(201, new { provider = ProviderService.ToPublic(created) });
    }

    [HttpPut("{id}")]
    public async Task<IActionResult> UpdateProvider(string id, [FromBody] ProviderInput input)
    {
        var updated = _providerService.Update(id, input);
        if (updated == null)
        {
            return NotFound(new { error = "提供商不存在" });
        }
        await ApplyPendingOAuthAsync(updated, input);
        return Ok(new { provider = ProviderService.ToPublic(updated) });
    }

    [HttpDelete("{id}")]
    public IActionResult DeleteProvider(string id)
    {
        var removed = _providerService.Remove(id);
        if (!removed)
        {
            return NotFound(new { error = "提供商不存在" });
        }
        return Ok(new { ok = true });
    }

    [HttpPost("{id}/models")]
    public async Task<IActionResult> FetchModels(string id)
    {
        var provider = _providerService.Get(id);
        if (provider == null)
        {
            return NotFound(new { error = "提供商不存在" });
        }
        // 订阅登录厂商先做调用准备（动态 Bearer / 到期自动刷新 / 附加头 / 协议屏蔽）
        var prep = await _oauthService.PrepareForCallAsync(provider, HttpContext.RequestAborted);
        return Ok(await _providerService.FetchModelsAsync(provider, prep));
    }

    [HttpPost("{id}/test")]
    public async Task<IActionResult> TestModel(string id, [FromBody] Dictionary<string, string>? body)
    {
        var provider = _providerService.Get(id);
        if (provider == null)
        {
            return NotFound(new { error = "提供商不存在" });
        }
        var modelId = body != null && body.TryGetValue("modelId", out var mid) ? mid : provider.DefaultModel;
        var prep = await _oauthService.PrepareForCallAsync(provider, HttpContext.RequestAborted);
        return Ok(await _providerService.TestModelAsync(provider, modelId, prep));
    }

    /// <summary>查询厂商余额（当前支持 DeepSeek / Moonshot Kimi / SiliconFlow 的 API Key 厂商）。</summary>
    [HttpGet("{id}/balance")]
    public async Task<IActionResult> Balance(string id)
    {
        var provider = _providerService.Get(id);
        if (provider == null)
        {
            return NotFound(new { ok = false, error = "提供商不存在" });
        }
        return Ok(await _balanceService.QueryBalanceAsync(provider));
    }

    /// <summary>
    /// 保存时消费一次性的订阅登录凭据：新建厂商（start 时未指定 providerId）的
    /// 登录流程里，令牌暂存在 OAuthService 的会话中，前端保存时携带 oauthLoginId。
    /// </summary>
    private async Task ApplyPendingOAuthAsync(ProviderConfig provider, ProviderInput input)
    {
        var loginId = input.OauthLoginId;
        if (string.IsNullOrWhiteSpace(loginId)) return;
        var tokens = _oauthService.TakeTokens(loginId);
        if (tokens == null)
        {
            _logger.LogWarning("订阅登录凭据不存在或已失效，忽略 oauthLoginId={LoginId}", loginId);
            return;
        }
        _providerService.ApplyOAuthToken(provider.Id,
            tokens.TryGetValue("oauthProvider", out var op) ? op?.ToString() : null,
            tokens.TryGetValue("accessToken", out var at) ? at?.ToString() : null,
            tokens.TryGetValue("refreshToken", out var rt) ? rt?.ToString() : null,
            tokens.TryGetValue("expiresAt", out var ea) ? ea?.ToString() : null,
            tokens.TryGetValue("accountEmail", out var ae) ? ae?.ToString() : null,
            tokens.TryGetValue("planName", out var pn) ? pn?.ToString() : null);
        await Task.CompletedTask;
    }
}
