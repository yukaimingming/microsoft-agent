using MafHarness.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace MafHarness.Web.Controllers;

[ApiController]
[Route("api/workspace")]
public sealed class WorkspaceController : ControllerBase
{
    private readonly WorkspaceService _workspaceService;

    public WorkspaceController(WorkspaceService workspaceService)
    {
        _workspaceService = workspaceService;
    }

    [HttpGet("tree")]
    public IActionResult GetTree([FromQuery] string? root, [FromQuery] int depth = 3)
    {
        var target = !string.IsNullOrWhiteSpace(root) ? root : _workspaceService.CurrentWorkspaceRoot;
        try
        {
            var nodes = _workspaceService.GetWorkspaceTree(target, depth);
            return Ok(new { ok = true, root = target, nodes });
        }
        catch (Exception ex)
        {
            return Ok(new
            {
                ok = false,
                root = target,
                nodes = new[] { new { name = Path.GetFileName(target), path = target, type = "directory" } },
                message = ex.Message
            });
        }
    }

    [HttpPost("select")]
    public IActionResult SelectWorkspace([FromBody] Dictionary<string, string> body)
    {
        if (!body.TryGetValue("path", out var path) || string.IsNullOrWhiteSpace(path))
        {
            return BadRequest(new { error = "缺少文件夹路径" });
        }

        try
        {
            _workspaceService.SetCurrentWorkspaceRoot(path);
            var tree = _workspaceService.GetWorkspaceTree(path, 3);
            return Ok(new { ok = true, root = path, nodes = tree });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = "无法访问该文件夹: " + ex.Message });
        }
    }

    [HttpPost("mkdir")]
    public IActionResult CreateDir([FromBody] Dictionary<string, string> body)
    {
        body.TryGetValue("parentDir", out var parentDir);
        if (!body.TryGetValue("dirName", out var dirName) || string.IsNullOrWhiteSpace(dirName))
        {
            return BadRequest(new { error = "缺少文件夹名称" });
        }

        try
        {
            _workspaceService.Mkdir(parentDir, dirName);
            var tree = _workspaceService.GetWorkspaceTree(_workspaceService.CurrentWorkspaceRoot, 3);
            return Ok(new { ok = true, nodes = tree });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = "创建文件夹失败: " + ex.Message });
        }
    }

    [HttpGet("browse")]
    public IActionResult Browse([FromQuery] string? path)
    {
        var target = !string.IsNullOrWhiteSpace(path) ? path : _workspaceService.CurrentWorkspaceRoot;
        var entries = _workspaceService.BrowseDirectory(target);
        return Ok(new
        {
            ok = true,
            currentPath = target,
            entries
        });
    }
}
