using MafHarness.Web.Models;
using MafHarness.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace MafHarness.Web.Controllers;

[ApiController]
[Route("api/providers")]
public sealed class ProviderController : ControllerBase
{
    private readonly ProviderService _providerService;

    public ProviderController(ProviderService providerService)
    {
        _providerService = providerService;
    }

    [HttpGet]
    public IActionResult ListProviders()
    {
        var list = _providerService.List().Select(ProviderService.ToPublic).ToList();
        return Ok(new { providers = list });
    }

    [HttpPost]
    public IActionResult CreateProvider([FromBody] ProviderInput input)
    {
        var created = _providerService.Create(input);
        return StatusCode(201, new { provider = ProviderService.ToPublic(created) });
    }

    [HttpPut("{id}")]
    public IActionResult UpdateProvider(string id, [FromBody] ProviderInput input)
    {
        var updated = _providerService.Update(id, input);
        if (updated == null)
        {
            return NotFound(new { error = "提供商不存在" });
        }
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
        return Ok(await _providerService.FetchModelsAsync(provider));
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
        return Ok(await _providerService.TestModelAsync(provider, modelId));
    }
}
