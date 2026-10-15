const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('🚀 开始生成官方级完美交付截图...');
  const screenshotsDir = path.join(__dirname, '../screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1040 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  console.log('1. 正在访问前端并重置为空白新会话...');
  await page.goto('http://127.0.0.1:5174', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 确保右侧 Review 边栏关闭，使得主聊天/建议词居中完整展示
  const reviewToggle = page.locator('button[aria-label="代码审查"]');
  const isReviewOpen = await page.locator('aside:has-text("审查")').count() > 0;
  if (isReviewOpen && await reviewToggle.count() > 0) {
    await reviewToggle.click();
    await page.waitForTimeout(500);
  }

  // 注入纯净状态展示中央 8 个 MAF 内置能力建议提示词
  await page.evaluate(() => {
    if (window.__deepagentTestHooks && window.__deepagentTestHooks.loadState) {
      window.__deepagentTestHooks.loadState({
        threadId: 'maf-showcase-' + Date.now(),
        messages: [],
        activities: [],
        run: { status: 'idle', interrupts: [] },
        pendingDecisions: {},
      });
    }
  });
  await page.waitForTimeout(1000);

  // 截图 1: MAF 8 大能力建议提示词主面板（深色模式）
  const shot1 = path.join(screenshotsDir, '01-maf-workbench-home-dark.png');
  await page.screenshot({ path: shot1 });
  console.log('✅ 截图 1 完成 (8大能力建议卡片深色): ' + shot1);

  // 截图 2: 切换浅色主题
  const themeBtn = page.locator('button[data-testid="header-toggle-theme-btn"]');
  if (await themeBtn.count() > 0) {
    await themeBtn.click();
    await page.waitForTimeout(800);
  }
  const shot2 = path.join(screenshotsDir, '02-maf-workbench-home-light.png');
  await page.screenshot({ path: shot2 });
  console.log('✅ 截图 2 完成 (8大能力建议卡片浅色): ' + shot2);

  // 切换回深色
  if (await themeBtn.count() > 0) {
    await themeBtn.click();
    await page.waitForTimeout(600);
  }

  // 截图 3: 点击建议词触发实际对话、思考折叠流与工具卡片
  console.log('3. 触发待办清单与自治循环建议提示词...');
  const cardBtn = page.locator('button:has-text("任务清单与自治循环")').first();
  if (await cardBtn.count() > 0) {
    await cardBtn.click();
  }

  console.log('等待智能体流式生成及工具执行...');
  await page.waitForTimeout(16000);

  // 展开思考气泡以展示详细思维链
  const expandReasoning = page.locator('button:has-text("展开"), button:has-text("思考"), div:has-text("正在分析")').first();
  if (await expandReasoning.count() > 0) {
    try { await expandReasoning.click(); } catch(e){}
    await page.waitForTimeout(800);
  }

  const shot3 = path.join(screenshotsDir, '03-maf-agent-chat-flow.png');
  await page.screenshot({ path: shot3 });
  console.log('✅ 截图 3 完成 (思考流与工具卡片): ' + shot3);

  // 截图 4: 打开代码审查 (Review) 与 PowerShell 交互式终端
  console.log('4. 展开代码审查侧边栏与终端...');
  if (await reviewToggle.count() > 0) {
    await reviewToggle.click();
    await page.waitForTimeout(800);
  }

  const terminalTab = page.locator('button:has-text("终端")').first();
  if (await terminalTab.count() > 0) {
    await terminalTab.click();
    await page.waitForTimeout(600);
    const terminalInput = page.locator('input[placeholder*="命令"]').first();
    if (await terminalInput.count() > 0) {
      await terminalInput.fill('Get-Process -Name MafHarness*');
      await terminalInput.press('Enter');
      await page.waitForTimeout(2000);
    }
  }

  const shot4 = path.join(screenshotsDir, '04-maf-review-and-terminal.png');
  await page.screenshot({ path: shot4 });
  console.log('✅ 截图 4 完成 (Review代码审查与PowerShell终端): ' + shot4);

  await browser.close();
  console.log('🎉 终极交付截图已全部生成！');
})();
