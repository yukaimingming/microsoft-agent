using MafHarness.Web.Models;
using MafHarness.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace MafHarness.Web.Controllers;

[ApiController]
[Route("api/workbench")]
public sealed class WorkbenchController : ControllerBase
{
    private readonly WorkbenchService _workbenchService;

    public WorkbenchController(WorkbenchService workbenchService)
    {
        _workbenchService = workbenchService;
    }

    [HttpGet]
    public IActionResult GetIndex()
    {
        return Ok(new { workbench = _workbenchService.LoadIndex() });
    }

    [HttpPut]
    public IActionResult UpdateIndex([FromBody] WorkbenchIndex index)
    {
        _workbenchService.SaveIndex(index);
        return Ok(new { ok = true });
    }

    [HttpGet("sessions/{threadId}")]
    public IActionResult GetSessionState(string threadId)
    {
        var state = _workbenchService.LoadSessionState(threadId);
        if (state == null)
        {
            return NotFound(new { error = "会话状态不存在" });
        }
        return Ok(new { state });
    }

    [HttpPut("sessions/{threadId}")]
    public IActionResult SaveSessionState(string threadId, [FromBody] object state)
    {
        _workbenchService.SaveSessionState(threadId, state);
        return Ok(new { ok = true });
    }

    [HttpDelete("sessions/{threadId}")]
    public IActionResult DeleteSessionState(string threadId)
    {
        _workbenchService.DeleteSessionState(threadId);
        return Ok(new { ok = true });
    }
}
