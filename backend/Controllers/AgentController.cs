using System.Text;
using MafHarness.Web.Models;
using MafHarness.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace MafHarness.Web.Controllers;

[ApiController]
public sealed class AgentController : ControllerBase
{
    private readonly MafAgentManager _agentManager;
    private readonly ILogger<AgentController> _logger;

    public AgentController(MafAgentManager agentManager, ILogger<AgentController> logger)
    {
        _agentManager = agentManager;
        _logger = logger;
    }

    [HttpPost("/agent")]
    public async Task RunAgent([FromBody] RunAgentInput input, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["Connection"] = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        var tcs = new TaskCompletionSource();

        await _agentManager.ExecuteAsync(
            input,
            async chunk =>
            {
                try
                {
                    var bytes = Encoding.UTF8.GetBytes(chunk);
                    await Response.Body.WriteAsync(bytes, cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                }
                catch
                {
                    // 客户端断开连接
                }
            },
            () =>
            {
                tcs.TrySetResult();
                return Task.CompletedTask;
            },
            cancellationToken);

        await tcs.Task;
    }

    [HttpPost("/agent/cancel")]
    public IActionResult Cancel([FromBody] Dictionary<string, string> body)
    {
        if (!body.TryGetValue("threadId", out var threadId) || string.IsNullOrWhiteSpace(threadId))
        {
            return BadRequest(new { error = "缺少 threadId" });
        }

        var cancelled = _agentManager.CancelThread(threadId);
        return Ok(new { ok = true, cancelled });
    }
}
