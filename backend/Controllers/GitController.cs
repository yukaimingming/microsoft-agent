using MafHarness.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace MafHarness.Web.Controllers;

[ApiController]
[Route("api/git")]
public sealed class GitController : ControllerBase
{
    private readonly GitService _gitService;

    public GitController(GitService gitService)
    {
        _gitService = gitService;
    }

    [HttpGet("status")]
    public IActionResult GetStatus([FromQuery] string? root)
    {
        try
        {
            return Ok(_gitService.GetStatus(root));
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = ex.Message });
        }
    }

    [HttpGet("diff")]
    public IActionResult GetDiff(
        [FromQuery] string path,
        [FromQuery] string? root,
        [FromQuery] bool staged = false,
        [FromQuery] string? commit = null)
    {
        try
        {
            return Ok(_gitService.GetFileDiff(root, path, staged, commit));
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = ex.Message });
        }
    }

    [HttpPost("commit")]
    public IActionResult Commit([FromBody] Dictionary<string, object> body)
    {
        var message = body.TryGetValue("message", out var mObj) ? mObj?.ToString() ?? "update" : "update";
        var root = body.TryGetValue("root", out var rObj) ? rObj?.ToString() : null;
        List<string>? files = null;
        if (body.TryGetValue("files", out var fObj) && fObj is System.Text.Json.JsonElement el && el.ValueKind == System.Text.Json.JsonValueKind.Array)
        {
            files = el.EnumerateArray().Select(x => x.GetString() ?? "").Where(s => !string.IsNullOrEmpty(s)).ToList();
        }

        try
        {
            return Ok(_gitService.Commit(root, message, files));
        }
        catch (Exception ex)
        {
            return BadRequest(new { error = ex.Message });
        }
    }

    [HttpGet("file-content")]
    public IActionResult GetFileContent([FromQuery] string path, [FromQuery] string? root)
    {
        try
        {
            return Ok(_gitService.ReadFileContent(root, path));
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { ok = false, error = ex.Message });
        }
    }

    [HttpPost("terminal")]
    public IActionResult RunTerminal([FromBody] Dictionary<string, string> body)
    {
        var command = body.TryGetValue("command", out var cmd) ? cmd : string.Empty;
        var root = body.TryGetValue("root", out var r) ? r : null;

        try
        {
            return Ok(_gitService.ExecuteTerminalCommand(root, command));
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { ok = false, output = "终端执行错误: " + ex.Message, exitCode = -1 });
        }
    }
}
