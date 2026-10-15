using MafHarness.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace MafHarness.Web.Controllers;

[ApiController]
[Route("api/health")]
public sealed class HealthController : ControllerBase
{
    private readonly WorkspaceService _workspaceService;
    private readonly ProviderService _providerService;
    private readonly IConfiguration _configuration;
    private static readonly DateTime _startedAt = DateTime.UtcNow;

    public HealthController(
        WorkspaceService workspaceService,
        ProviderService providerService,
        IConfiguration configuration)
    {
        _workspaceService = workspaceService;
        _providerService = providerService;
        _configuration = configuration;
    }

    [HttpGet]
    public IActionResult Health()
    {
        return Ok(new
        {
            status = "ok",
            framework = "Microsoft Agent Framework (MAF Harness) .NET 10",
            startedAt = _startedAt.ToString("o"),
            workspaceRoot = _workspaceService.CurrentWorkspaceRoot,
            defaultModel = _configuration["Llm:ModelId"] ?? "Atria-Dawn-Preview",
            providersCount = _providerService.List().Count
        });
    }
}
