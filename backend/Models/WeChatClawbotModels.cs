using System.Text.Json.Serialization;

namespace MafHarness.Web.Models;

/// <summary>
/// 微信 ClawBot (iLink 协议) 认证凭据与持久化状态
/// </summary>
public sealed class WeChatClawbotCredentials
{
    [JsonPropertyName("bot_token")]
    public string BotToken { get; set; } = string.Empty;

    [JsonPropertyName("ilink_bot_id")]
    public string IlinkBotId { get; set; } = string.Empty;

    [JsonPropertyName("ilink_user_id")]
    public string IlinkUserId { get; set; } = string.Empty;

    [JsonPropertyName("baseurl")]
    public string BaseUrl { get; set; } = "https://ilinkai.weixin.qq.com";

    [JsonPropertyName("get_updates_buf")]
    public string GetUpdatesBuf { get; set; } = string.Empty;

    [JsonPropertyName("connected_at")]
    public string ConnectedAt { get; set; } = DateTime.UtcNow.ToString("o");

    [JsonPropertyName("last_message_at")]
    public string? LastMessageAt { get; set; }

    [JsonPropertyName("message_count")]
    public int MessageCount { get; set; }
}

/// <summary>
/// POST /api/v1/wechat/qrcode 响应数据
/// </summary>
public sealed class WeChatQrCodeData
{
    [JsonPropertyName("qrcode_url")]
    public string QrCodeUrl { get; set; } = string.Empty;

    [JsonPropertyName("qrcode")]
    public string QrCode { get; set; } = string.Empty;

    [JsonPropertyName("qrcode_img_content")]
    public string? QrCodeImgContent { get; set; }

    [JsonPropertyName("qrcode_base64")]
    public string? QrCodeBase64 { get; set; }
}

/// <summary>
/// POST /api/v1/wechat/qrcode/status 请求体
/// </summary>
public sealed class WeChatQrCodeStatusRequest
{
    [JsonPropertyName("qrcode")]
    public string QrCode { get; set; } = string.Empty;
}

/// <summary>
/// POST /api/v1/wechat/qrcode/status 响应数据
/// </summary>
public sealed class WeChatQrCodeStatusData
{
    /// <summary>
    /// 二维码状态："wait"（等待扫描）、"scaned"（已扫描）、"confirmed"（已确认）、"expired"（已过期）
    /// </summary>
    [JsonPropertyName("status")]
    public string Status { get; set; } = "wait";

    [JsonPropertyName("credentials")]
    public WeChatCredentialsDto? Credentials { get; set; }

    [JsonPropertyName("baseurl")]
    public string BaseUrl { get; set; } = "https://ilinkai.weixin.qq.com";
}

public sealed class WeChatCredentialsDto
{
    [JsonPropertyName("bot_token")]
    public string BotToken { get; set; } = string.Empty;

    [JsonPropertyName("ilink_bot_id")]
    public string IlinkBotId { get; set; } = string.Empty;

    [JsonPropertyName("ilink_user_id")]
    public string IlinkUserId { get; set; } = string.Empty;
}

/// <summary>
/// POST /api/v1/wechat/channel_reset 请求体
/// </summary>
public sealed class WeChatChannelResetRequest
{
    [JsonPropertyName("channel_id")]
    public string? ChannelId { get; set; }
}

/// <summary>
/// GET /api/v1/wechat/status 实时连接状态数据
/// </summary>
public sealed class WeChatConnectionStatusData
{
    [JsonPropertyName("connected")]
    public bool Connected { get; set; }

    /// <summary>
    /// 状态枚举："connected" | "disconnected" | "wait" | "scaned" | "expired"
    /// </summary>
    [JsonPropertyName("status")]
    public string Status { get; set; } = "disconnected";

    [JsonPropertyName("ilink_bot_id")]
    public string? IlinkBotId { get; set; }

    [JsonPropertyName("ilink_user_id")]
    public string? IlinkUserId { get; set; }

    [JsonPropertyName("baseurl")]
    public string BaseUrl { get; set; } = "https://ilinkai.weixin.qq.com";

    [JsonPropertyName("connected_at")]
    public string? ConnectedAt { get; set; }

    [JsonPropertyName("last_message_at")]
    public string? LastMessageAt { get; set; }

    [JsonPropertyName("message_count")]
    public int MessageCount { get; set; }

    [JsonPropertyName("longpoll_active")]
    public bool LongPollActive { get; set; }

    [JsonPropertyName("last_error")]
    public string? LastError { get; set; }
}
