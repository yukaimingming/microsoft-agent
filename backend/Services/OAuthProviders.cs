using Microsoft.Extensions.Configuration;

namespace MafHarness.Web.Services;

/// <summary>订阅登录流程形态。</summary>
public enum OAuthFlow
{
    /// <summary>授权码 + PKCE，本地回环回调（OpenAI / Anthropic / Grok）。</summary>
    LoopbackPkce,
    /// <summary>授权码 + client_secret，本地回环回调（Google，复刻 gemini-cli 无 PKCE）。</summary>
    LoopbackSecret,
    /// <summary>RFC 8628 设备码流程，后端轮询令牌端点（Copilot / Qwen / Kimi）。</summary>
    Device,
}

/// <summary>一家订阅登录厂商的完整接入参数（不可变描述符）。</summary>
public sealed record OAuthProviderDescriptor(
    string Id,
    string Title,
    OAuthFlow Flow,
    /// <summary>授权端点（DEVICE 流程为 null）。</summary>
    string? AuthorizeUrl,
    /// <summary>令牌交换/轮询/刷新端点。</summary>
    string TokenUrl,
    /// <summary>仅 DEVICE 流程：设备码申请端点。</summary>
    string? DeviceCodeUrl,
    string ClientId,
    /// <summary>LOOPBACK_SECRET 流程必填，其余为 null。</summary>
    string? ClientSecret,
    string? Scope,
    /// <summary>回环回调 host（localhost 或 127.0.0.1）。</summary>
    string? CallbackHost,
    /// <summary>回环回调路径。</summary>
    string? CallbackPath,
    /// <summary>DEVICE 流程：申请设备码的请求体风格（true=json / false=form）。</summary>
    bool DeviceRequestJson,
    /// <summary>令牌交换/轮询/刷新的请求体风格（true=json / false=form）。</summary>
    bool JsonExchange,
    /// <summary>授权 URL 的额外参数（不含开头的 &amp;），如 Grok 的 referrer、Google 的 access_type。</summary>
    string? ExtraAuthorizeParams,
    /// <summary>下游 OpenAI 兼容推理端点；null 表示协议特殊、当前调用链不能直接消费令牌。</summary>
    string? OpenaiBaseUrl,
    /// <summary>调用下游时必须附加的 HTTP 头（Grok / Copilot）。</summary>
    IReadOnlyDictionary<string, string> ExtraHeaders,
    /// <summary>模型列表路径覆盖（Copilot 是根路径 /models，而非 /v1/models）。</summary>
    string? ModelsPathOverride,
    /// <summary>true 表示 apiKey 是短时派生令牌（Copilot），需用 refreshToken 动态换取。</summary>
    bool DynamicBearer,
    /// <summary>true 表示 access token 有效期短，调用前应按过期时间自动刷新（Qwen / Kimi）。</summary>
    bool ShortLivedToken,
    /// <summary>给前端卡片的调用方式/限制标注（null 表示无特殊限制）。</summary>
    string? Note,
    /// <summary>出站 OAuth 请求的 User-Agent（null 用服务默认值；Qwen 的阿里云 WAF 会拦截无 UA 请求）。</summary>
    string? UserAgent = null)
{
    /// <summary>是否本地回环授权码流程（非设备码）。</summary>
    public bool IsLoopback => Flow != OAuthFlow.Device;
}

/// <summary>
/// 订阅登录（OAuth）厂商注册表：每一家可订阅登录的厂商在这里声明一份描述符，
/// OAuthService、控制器与前端卡片目录均以本表为唯一事实来源（数据驱动）。
///
/// 技术参数来源（2026-11 联网核实，均已对官方开源实现逐项比对，与姊妹项目
/// agentscope-harness 的 OAuthProviders.java 同源）：
/// - openai：Codex CLI（auth.openai.com 公开客户端 app_EMoamEEZ73f0CkXaXp7hrann）。
/// - anthropic：Claude Code（claude.ai/oauth/authorize + console.anthropic.com 令牌交换）。
/// - grok：xAI 官方开源 Grok Build CLI（github.com/xai-org/grok-build，
///   crates/codegen/xai-grok-login）与 auth.x.ai 的 OIDC discovery 文档（实测拉取）。
///   公开 client_id=b1a00492-073a-47ea-816f-4c329264a828；回环授权码+PKCE（随机端口、
///   路径 /callback、host 固定 127.0.0.1、带 state+nonce+referrer）。推理不走 api.x.ai
///   （那是 API Key 专用），走 OpenAI 兼容代理 https://cli-chat-proxy.grok.com/v1，
///   且必须附带 X-XAI-Token-Auth: xai-grok-cli 与 x-authenticateresponse 头。
///   需要 SuperGrok 或 X Premium+ 订阅。
/// - google：google-gemini/gemini-cli packages/core/src/code_assist/oauth2.ts。
///   专属 installed-app 客户端（client_id / client_secret 不写入源码，启动时经配置注入，
///   见 GoogleDescriptor），回环路径 /oauth2callback（任意端口），scope 为 cloud-platform +
///   userinfo.email + userinfo.profile，带 access_type=offline、不带 PKCE（复刻 CLI）。
///   令牌仅用于 Code Assist 专有协议（cloudcode-pa.googleapis.com v1internal），
///   generativelanguage 的 OpenAI 兼容层实测只认 API Key，故 OpenaiBaseUrl=null。
/// - github-copilot：VS Code Copilot 同款公开 client_id=Iv1.b507a08c87ecfe98，
///   RFC 8628 设备码流程（github.com/login/device/code），再用 GitHub token 经
///   api.github.com/copilot_internal/v2/token 换约 30 分钟有效的 Copilot Bearer，
///   调 OpenAI 兼容的 api.githubcopilot.com（需 editor/copilot 系列头）。
/// - qwen：qwenlm/qwen-code packages/core/src/qwen/subscription-oauth-client.ts。
///   RFC 8628 设备码（auth.qwen.ai/api/oauth/device/code，client_id=qwen-code-cli，
///   scope=model:invoke profile:read），推理走 OpenAI 兼容
///   https://api.qwen.ai/compatible-mode/v1，需要 Plus/Pro 订阅。
/// - kimi：MoonshotAI/kimi-cli src/kimi_cli/auth/oauth.py。RFC 8628 设备码
///   （auth.kimi.com/api/oauth/device_authorization，client_id=17e5f671-...），
///   推理走 OpenAI 兼容 https://api.kimi.com/coding/v1，access token 约 15 分钟，
///   需 Kimi Code 会员；官方提醒第三方接入应如实标注客户端身份。
/// </summary>
public static class OAuthProviders
{
    private const string GoogleScope =
        "https://www.googleapis.com/auth/cloud-platform "
        + "https://www.googleapis.com/auth/userinfo.email "
        + "https://www.googleapis.com/auth/userinfo.profile";

    // Google OAuth 凭据不写入源码（避免硬编码密钥被 GitHub Push Protection 拦截）：
    // 启动时由 Program.cs 注入 IConfiguration，google 描述符按需构建（参考 agentscope
    // 的 googleDescriptor() 模式）。appsettings.json 的 OAuth 节提供默认空串，
    // 环境变量 MAF_HARNESS_OAuth__GoogleClientId / MAF_HARNESS_OAuth__GoogleClientSecret 可覆盖。
    private static IConfiguration? _configuration;

    /// <summary>启动时注入配置（仅 Program.cs 调用一次），供 google 描述符按需读取凭据。</summary>
    public static void Initialize(IConfiguration configuration) => _configuration = configuration;

    /// <summary>
    /// google 描述符按需构建：凭据仅从配置读取，源码不留明文；未配置时凭据为空，
    /// 登录入口（<see cref="GetCredentialMissingMessage"/>）会先行拦截并给出配置指引。
    /// </summary>
    private static OAuthProviderDescriptor GoogleDescriptor()
    {
        var clientId = _configuration?["OAuth:GoogleClientId"] ?? "";
        var clientSecret = _configuration?["OAuth:GoogleClientSecret"];
        return new OAuthProviderDescriptor(
            "google", "Google Gemini 订阅", OAuthFlow.LoopbackSecret,
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://oauth2.googleapis.com/token",
            null,
            clientId,
            string.IsNullOrWhiteSpace(clientSecret) ? null : clientSecret,
            GoogleScope,
            "127.0.0.1", "/oauth2callback",
            DeviceRequestJson: false, JsonExchange: false,
            "access_type=offline",
            null,
            new Dictionary<string, string>(),
            null, DynamicBearer: false, ShortLivedToken: false,
            "Google 账号免费档（Code Assist，约 1000 请求/天）可登录；但推理走 Code Assist 专有协议（cloudcode-pa.googleapis.com v1internal），非 OpenAI 兼容，当前调用链不直接消费该令牌，需配合外部协议代理使用；Antigravity 为独立的逆向协议，未接入");
    }

    /// <summary>
    /// 厂商凭据是否就绪；未随配置注入的（如 Google）返回中文配置指引，null 表示可正常发起。
    /// 供登录入口在触达授权方之前拦截，避免拿空 client_id 请求厂商。
    /// </summary>
    public static string? GetCredentialMissingMessage(string? id)
    {
        if (id == "google")
        {
            var d = GoogleDescriptor();
            if (string.IsNullOrWhiteSpace(d.ClientId) || string.IsNullOrWhiteSpace(d.ClientSecret))
            {
                return "Google 订阅登录的 OAuth 凭据尚未配置：请设置环境变量 "
                    + "MAF_HARNESS_OAuth__GoogleClientId 与 MAF_HARNESS_OAuth__GoogleClientSecret"
                    + "（或填入 backend/appsettings.json 的 OAuth:GoogleClientId / OAuth:GoogleClientSecret）后重启后端再试";
            }
        }
        return null;
    }

    /// <summary>全部支持的厂商 id（供控制器/前端目录使用，保持展示顺序）。</summary>
    public static readonly IReadOnlyList<string> Ids =
        ["openai", "anthropic", "grok", "google", "github-copilot", "qwen", "kimi"];

    private static readonly Dictionary<string, OAuthProviderDescriptor> All = new(StringComparer.Ordinal)
    {
        ["openai"] = new OAuthProviderDescriptor(
            "openai", "OpenAI ChatGPT 订阅", OAuthFlow.LoopbackPkce,
            "https://auth.openai.com/oauth/authorize",
            "https://auth.openai.com/oauth/token",
            null,
            "app_EMoamEEZ73f0CkXaXp7hrann", null,
            "openid profile email offline_access",
            "localhost", "/auth/callback",
            DeviceRequestJson: false, JsonExchange: false,
            "id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs",
            "https://api.openai.com/v1",
            new Dictionary<string, string>(),
            null, DynamicBearer: false, ShortLivedToken: false,
            null),

        ["anthropic"] = new OAuthProviderDescriptor(
            "anthropic", "Anthropic Claude 订阅", OAuthFlow.LoopbackPkce,
            "https://claude.ai/oauth/authorize",
            "https://console.anthropic.com/v1/oauth/token",
            null,
            "9d1c250a-e61b-44d9-88ed-5944d1968f2e", null,
            "org:create_api_key user:profile user:inference",
            "localhost", "/callback",
            DeviceRequestJson: false, JsonExchange: true,
            null,
            null,
            new Dictionary<string, string>(),
            null, DynamicBearer: false, ShortLivedToken: false,
            "原生 Anthropic 协议（非 OpenAI 兼容），当前推理调用链不直接消费该令牌，需配合兼容网关使用"),

        ["grok"] = new OAuthProviderDescriptor(
            "grok", "xAI Grok 订阅", OAuthFlow.LoopbackPkce,
            "https://auth.x.ai/oauth2/authorize",
            "https://auth.x.ai/oauth2/token",
            null,
            "b1a00492-073a-47ea-816f-4c329264a828", null,
            "openid profile email offline_access grok-cli:access api:access "
                + "conversations:read conversations:write workspaces:read workspaces:write",
            "127.0.0.1", "/callback",
            DeviceRequestJson: false, JsonExchange: false,
            "referrer=grok-build",
            "https://cli-chat-proxy.grok.com/v1",
            new Dictionary<string, string>
            {
                ["X-XAI-Token-Auth"] = "xai-grok-cli",
                ["x-authenticateresponse"] = "authenticate-response",
            },
            null, DynamicBearer: false, ShortLivedToken: false,
            "需要 SuperGrok 或 X Premium+ 订阅；推理走 Grok CLI 专用 OpenAI 兼容代理（cli-chat-proxy.grok.com），api.x.ai 仅支持 API Key"),

        // google 不在静态表里：凭据来自配置，由 GoogleDescriptor() 按需构建（见上）

        ["github-copilot"] = new OAuthProviderDescriptor(
            "github-copilot", "GitHub Copilot 订阅", OAuthFlow.Device,
            null,
            "https://github.com/login/oauth/access_token",
            "https://github.com/login/device/code",
            "Iv1.b507a08c87ecfe98", null,
            "read:user",
            null, null,
            DeviceRequestJson: true, JsonExchange: true,
            null,
            "https://api.githubcopilot.com",
            new Dictionary<string, string>
            {
                ["copilot-integration-id"] = "vscode-chat",
                ["editor-version"] = "vscode/1.99.0",
                ["editor-plugin-version"] = "copilot-chat/0.26.7",
                ["openai-intent"] = "conversation-panel",
                ["user-agent"] = "GitHubCopilotChat/0.26.7",
            },
            "/models", DynamicBearer: true, ShortLivedToken: false,
            "设备码流程：在 github.com/login/device 输入代码完成授权；Copilot Bearer 约 30 分钟有效，系统用 GitHub 令牌自动换取；需要 Copilot 订阅（免费账号可用模型有限）"),

        ["qwen"] = new OAuthProviderDescriptor(
            "qwen", "Qwen 通义订阅", OAuthFlow.Device,
            null,
            "https://auth.qwen.ai/api/oauth/token",
            "https://auth.qwen.ai/api/oauth/device/code",
            "qwen-code-cli", null,
            "model:invoke profile:read",
            null, null,
            DeviceRequestJson: false, JsonExchange: false,
            null,
            "https://api.qwen.ai/compatible-mode/v1",
            new Dictionary<string, string>(),
            null, DynamicBearer: false, ShortLivedToken: true,
            "设备码流程：在 chat.qwen.ai 授权页输入代码完成授权；需要 Qwen Plus/Pro 订阅（免费账号可登录但不解锁调用）",
            UserAgent: "qwen-code/0.10.0"),

        ["kimi"] = new OAuthProviderDescriptor(
            "kimi", "Kimi Code 会员", OAuthFlow.Device,
            null,
            "https://auth.kimi.com/api/oauth/token",
            "https://auth.kimi.com/api/oauth/device_authorization",
            "17e5f671-d194-4dfb-9706-5516cb48c098", null,
            null,
            null, null,
            DeviceRequestJson: false, JsonExchange: false,
            null,
            "https://api.kimi.com/coding/v1",
            new Dictionary<string, string>(),
            null, DynamicBearer: false, ShortLivedToken: true,
            "设备码流程：在 auth.kimi.com 授权页输入代码完成授权；需要 Kimi Code 会员（Andante/Moderato/Allegretto 等），access token 约 15 分钟自动续期"),
    };

    /// <summary>按 id 查找描述符；google 按需构建（凭据来自配置），未知厂商返回 null。</summary>
    public static OAuthProviderDescriptor? Get(string? id)
    {
        if (id == null) return null;
        if (id == "google") return GoogleDescriptor();
        return All.TryGetValue(id, out var d) ? d : null;
    }

    /// <summary>是否注册表内受支持的厂商。</summary>
    public static bool IsSupported(string? id) => Get(id) != null;
}
