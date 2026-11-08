using MafHarness.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace MafHarness.Web.Controllers;

/// <summary>
/// 订阅登录（OAuth）控制器。
///
/// - POST /api/providers/oauth/start   发起登录（回环授权码：生成 PKCE + 本地回环回调服务；
///   设备码：申请设备码并后台轮询），返回授权地址或设备码信息
/// - GET  /api/providers/oauth/status  前端轮询登录结果（含账号邮箱/套餐/令牌过期时间；
///   设备码流程附带 userCode 与验证页地址）
/// - POST /api/providers/oauth/refresh 用已保存的 refresh_token 换新 access token
/// - POST /api/providers/oauth/logout  清除订阅登录态
/// </summary>
[ApiController]
[Route("api/providers/oauth")]
public sealed class OAuthController : ControllerBase
{
    private readonly ILogger<OAuthController> _logger;
    private readonly OAuthService _oauthService;
    private readonly ProviderService _providerService;

    public OAuthController(ILogger<OAuthController> logger, OAuthService oauthService, ProviderService providerService)
    {
        _logger = logger;
        _oauthService = oauthService;
        _providerService = providerService;
    }

    [HttpPost("start")]
    public async Task<IActionResult> Start([FromBody] Dictionary<string, string>? body)
    {
        var type = body != null && body.TryGetValue("type", out var t) ? t : null;
        var providerId = body != null && body.TryGetValue("providerId", out var p) ? p : null;
        // 类型校验改注册表驱动：支持的厂商由 OAuthProviders 注册表唯一决定
        if (type == null || !OAuthProviders.IsSupported(type))
        {
            return BadRequest(new { ok = false, message = $"不支持的订阅登录类型: {type}（支持 {string.Join(" / ", OAuthService.SupportedTypes)}）" });
        }
        if (!string.IsNullOrWhiteSpace(providerId) && _providerService.Get(providerId) == null)
        {
            return BadRequest(new { ok = false, message = "目标厂商不存在" });
        }
        // 凭据未随配置注入的厂商（如 Google）在此拦截，返回配置指引，不向授权方发起任何请求
        var credentialHint = OAuthProviders.GetCredentialMissingMessage(type);
        if (credentialHint != null)
        {
            return BadRequest(new { ok = false, message = credentialHint });
        }
        try
        {
            var login = await _oauthService.StartAsync(type,
                string.IsNullOrWhiteSpace(providerId) ? null : providerId);
            var output = new Dictionary<string, object?>
            {
                ["ok"] = true,
                // 流程形态：回环授权码（authorizeUrl）| 设备码（userCode + verificationUri）
                ["flow"] = login.Flow == OAuthFlow.Device ? "device" : "loopback",
                ["state"] = login.State,
                ["loginId"] = login.State,
            };
            if (login.AuthorizeUrl != null)
            {
                output["authorizeUrl"] = login.AuthorizeUrl;
                output["redirectUri"] = login.RedirectUri;
            }
            // 回环流程固定 5 分钟；设备码流程用厂商返回的 expires_in
            output["expiresInSeconds"] = login.DeviceExpiresAt > DateTimeOffset.UtcNow
                ? Math.Max(30, (long)(login.DeviceExpiresAt - DateTimeOffset.UtcNow).TotalSeconds)
                : 300;
            if (login.UserCode != null)
            {
                output["userCode"] = login.UserCode;
                output["verificationUri"] = login.VerificationUri;
                output["verificationUriComplete"] = login.VerificationUriComplete;
                output["intervalSeconds"] = login.IntervalSeconds;
            }
            return Ok(output);
        }
        catch (Exception e)
        {
            _logger.LogError(e, "启动订阅登录失败: type={Type}", type);
            return StatusCode(500, new { ok = false, message = $"启动订阅登录失败: {e.Message}" });
        }
    }

    [HttpGet("status")]
    public IActionResult Status([FromQuery] string state)
    {
        var snapshot = _oauthService.GetStatus(state);
        if (snapshot == null)
        {
            return NotFound(new { ok = false, status = "missing", message = "登录会话不存在或已被清理" });
        }
        var output = new Dictionary<string, object?> { ["ok"] = true };
        foreach (var (key, value) in snapshot)
        {
            output[key] = value;
        }
        return Ok(output);
    }

    [HttpPost("refresh")]
    public async Task<IActionResult> Refresh([FromBody] Dictionary<string, string>? body)
    {
        var providerId = body != null && body.TryGetValue("providerId", out var p) ? p : null;
        if (string.IsNullOrWhiteSpace(providerId))
        {
            return BadRequest(new { ok = false, message = "缺少 providerId" });
        }
        return Ok(await _oauthService.RefreshForProviderAsync(providerId));
    }

    [HttpPost("logout")]
    public IActionResult Logout([FromBody] Dictionary<string, string>? body)
    {
        var providerId = body != null && body.TryGetValue("providerId", out var p) ? p : null;
        if (string.IsNullOrWhiteSpace(providerId))
        {
            return BadRequest(new { ok = false, message = "缺少 providerId" });
        }
        return Ok(_oauthService.Logout(providerId));
    }
}
