using MafHarness.Web.Models;
using MafHarness.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace MafHarness.Web.Controllers;

/// <summary>
/// 微信 ClawBot (iLink 协议) 开放接口控制器。
/// 严格对齐微信开放文档规范：
/// https://developers.weixin.qq.com/doc/aispeech/knowledge/openapi/Clawbotrelated.html
/// - POST /api/v1/wechat/qrcode
/// - POST /api/v1/wechat/qrcode/status
/// - POST /api/v1/wechat/channel_reset
/// - GET  /api/v1/wechat/status
/// </summary>
[ApiController]
[Route("api/v1/wechat")]
public sealed class WeChatController : ControllerBase
{
    private readonly WeChatIlinkService _wechatService;
    private readonly ILogger<WeChatController> _logger;

    public WeChatController(WeChatIlinkService wechatService, ILogger<WeChatController> logger)
    {
        _wechatService = wechatService;
        _logger = logger;
    }

    /// <summary>
    /// 获取微信 ClawBot 登录二维码
    /// POST /api/v1/wechat/qrcode
    /// </summary>
    [HttpPost("qrcode")]
    [HttpGet("qrcode")]
    public async Task<IActionResult> GetQrCode(CancellationToken cancellationToken)
    {
        try
        {
            var data = await _wechatService.GetQrCodeAsync(cancellationToken);
            return Ok(new
            {
                success = true,
                data
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "获取微信 ClawBot 二维码失败");
            return StatusCode(500, new
            {
                success = false,
                error = ex.Message
            });
        }
    }

    /// <summary>
    /// 轮询微信二维码扫描状态（长轮询接口）
    /// POST /api/v1/wechat/qrcode/status
    /// </summary>
    [HttpPost("qrcode/status")]
    public async Task<IActionResult> GetQrCodeStatus(
        [FromBody] WeChatQrCodeStatusRequest request,
        CancellationToken cancellationToken)
    {
        if (request == null || string.IsNullOrWhiteSpace(request.QrCode))
        {
            return BadRequest(new
            {
                success = false,
                error = "缺少必填参数 qrcode"
            });
        }

        try
        {
            var data = await _wechatService.PollQrCodeStatusAsync(request.QrCode, cancellationToken);
            return Ok(new
            {
                success = true,
                data
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "轮询微信二维码状态失败");
            return StatusCode(500, new
            {
                success = false,
                error = ex.Message
            });
        }
    }

    /// <summary>
    /// 重置微信 IM 通道，删除绑定凭据并停止对应通道的 longpoll 轮询
    /// POST /api/v1/wechat/channel_reset
    /// </summary>
    [HttpPost("channel_reset")]
    public IActionResult ResetChannel([FromBody] WeChatChannelResetRequest? request)
    {
        var channelId = _wechatService.ResetChannel(request?.ChannelId);
        return Ok(new
        {
            success = true,
            data = new
            {
                message = "IM通道重置任务已提交",
                channel_id = channelId
            }
        });
    }

    /// <summary>
    /// 获取个人助手 ClawBot 实时连接状态与统计信息
    /// GET /api/v1/wechat/status
    /// </summary>
    [HttpGet("status")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public IActionResult GetStatus()
    {
        var data = _wechatService.GetConnectionStatus();
        return Ok(new
        {
            success = true,
            data
        });
    }
}
