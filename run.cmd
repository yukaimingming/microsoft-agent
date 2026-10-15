@echo off
chcp 65001 >nul
title MAF Harness 智能体全功能工作台

echo ========================================================
echo   MAF Harness 智能体工作台一键启动
echo   后端: .NET 10 WebAPI (端口 8787)
echo   前端: React 19 + AI Elements (端口 5174)
echo ========================================================

where dotnet >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 .NET SDK，请先安装 .NET 10 SDK！
    pause
    exit /b 1
)

where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 pnpm，请先安装 Node.js 和 pnpm！
    pause
    exit /b 1
)

echo [1/2] 启动 .NET 10 后端服务 (http://127.0.0.1:8787)...
start "MAF-Harness-Backend" cmd /c "cd /d "%~dp0backend" && dotnet run"

echo 等待后端初始化就绪...
timeout /t 3 /nobreak >nul

echo [2/2] 启动前端 Vite 开发服务器 (http://127.0.0.1:5174)...
start "MAF-Harness-Frontend" cmd /c "cd /d "%~dp0frontend" && pnpm --filter @deepagent/web dev --host 127.0.0.1 --port 5174"

echo.
echo ========================================================
echo   服务已在后台启动！
echo   请在浏览器中打开: http://127.0.0.1:5174
echo ========================================================
echo.
pause
