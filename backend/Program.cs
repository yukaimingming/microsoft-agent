using MafHarness.Web.Services;

// 控制台与环境 UTF-8 编码设置
Console.OutputEncoding = System.Text.Encoding.UTF8;
Console.InputEncoding = System.Text.Encoding.UTF8;

var builder = WebApplication.CreateBuilder(args);

// 配置绑定与热重载
builder.Configuration
    .SetBasePath(AppContext.BaseDirectory)
    .AddJsonFile("appsettings.json", optional: false, reloadOnChange: true)
    .AddEnvironmentVariables("MAF_HARNESS_");

// 绑定端口为 8787
builder.WebHost.UseUrls("http://0.0.0.0:8787");

// 跨域设置：允许所有前端端口访问（如 5174, 5173, 3000）
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

// JSON 序列化选项
builder.Services.AddControllers().AddJsonOptions(options =>
{
    options.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase;
    options.JsonSerializerOptions.DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull;
});

// 核心服务依赖注入
builder.Services.AddSingleton<WorkspaceService>();
builder.Services.AddSingleton<ProviderService>();
builder.Services.AddSingleton<WorkbenchService>();
builder.Services.AddSingleton<GitService>();
builder.Services.AddSingleton<MafAgentManager>();

var app = builder.Build();

app.UseCors();
app.MapControllers();

Console.ForegroundColor = ConsoleColor.Cyan;
Console.WriteLine("==========================================================");
Console.WriteLine("  MAF Harness Agent WebAPI 后端服务 (Microsoft Agent Framework)");
Console.WriteLine("  框架版本: .NET 10.0 (C# 13) | AG-UI 协议全栈对接");
Console.WriteLine("  服务端口: http://127.0.0.1:8787");
Console.WriteLine("  端点清单: POST /agent (SSE 流式) | GET /api/health");
Console.WriteLine("==========================================================");
Console.ResetColor();

await app.RunAsync();
