# MAF Harness 智能体工作台一键启动脚本 (PowerShell)
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  MAF Harness 智能体工作台一键启动 (PowerShell)" -ForegroundColor Cyan
Write-Host "  后端: .NET 10 WebAPI (端口 8787)" -ForegroundColor DarkGray
Write-Host "  前端: React 19 + AI Elements (端口 5174)" -ForegroundColor DarkGray
Write-Host "========================================================" -ForegroundColor Cyan

$root = $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; dotnet run"
Start-Sleep -Seconds 3
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; pnpm --filter @deepagent/web dev --host 127.0.0.1 --port 5174"

Write-Host "`n服务已在后台启动！`n请打开浏览器访问: http://127.0.0.1:5174" -ForegroundColor Green
