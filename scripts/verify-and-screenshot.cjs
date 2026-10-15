const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  console.log('🚀 开始自动化端到端测试与真实界面截图...');
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

  // 1. 访问主界面
  console.log('1. 正在访问工作台前端首页 http://127.0.0.1:5174 ...');
  await page.goto('http://127.0.0.1:5174', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 清除本地旧会话缓存，强制以纯净新对话状态展示主面板 8 大卡片
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 收起右侧代码审查侧边栏，让主工作台中央气派展示
  const reviewToggle = page.locator('button[aria-label="代码审查"]');
  const isReviewOpen = await page.locator('aside:has-text("审查")').count() > 0;
  if (isReviewOpen && await reviewToggle.count() > 0) {
    await reviewToggle.click();
    await page.waitForTimeout(800);
  }

  // 截图 1: 主面板深色模式（展示8个MAFHarness能力提示词卡片）
  const shot1 = path.join(screenshotsDir, '01-maf-workbench-home-dark.png');
  await page.screenshot({ path: shot1, fullPage: false });
  console.log('✅ 截图 1 完成: ' + shot1);

  // 截图 2: 切换为浅色主题
  console.log('2. 切换浅色主题并截图...');
  const themeBtn = page.locator('button[data-testid="header-toggle-theme-btn"]');
  if (await themeBtn.count() > 0) {
    await themeBtn.click();
    await page.waitForTimeout(1000);
  }
  const shot2 = path.join(screenshotsDir, '02-maf-workbench-home-light.png');
  await page.screenshot({ path: shot2, fullPage: false });
  console.log('✅ 截图 2 完成: ' + shot2);

  // 切回深色模式准备对话交互
  if (await themeBtn.count() > 0) {
    await themeBtn.click();
    await page.waitForTimeout(800);
  }

  // 3. 点击第一个建议提示词（待办清单与自治循环）
  console.log('3. 点击建议提示词「待办清单与自治循环」并与 MAF 后端真实交互...');
  const promptButton = page.locator('button:has-text("任务清单与自治循环")').first();
  if (await promptButton.count() > 0) {
    await promptButton.click();
  } else {
    const inputArea = page.locator('textarea').first();
    await inputArea.fill('请使用 todos_add 为当前工作区规划自动化脚本的待办任务清单，并汇报当前模式。');
    await page.keyboard.press('Enter');
  }

  // 等待智能体响应流和工具调用
  console.log('等待智能体流式生成及工具执行 (最多等 20 秒)...');
  await page.waitForTimeout(16000);

  const shot3 = path.join(screenshotsDir, '03-maf-agent-chat-flow.png');
  await page.screenshot({ path: shot3, fullPage: false });
  console.log('✅ 截图 3 完成: ' + shot3);

  // 4. 打开右侧代码审查（Review）边栏与终端视图
  console.log('4. 展开代码审查侧边栏并切换终端...');
  if (await reviewToggle.count() > 0) {
    await reviewToggle.click();
    await page.waitForTimeout(1000);
  }

  // 点击终端标签并在终端中输入执行测试命令
  const terminalTab = page.locator('button:has-text("终端")').first();
  if (await terminalTab.count() > 0) {
    await terminalTab.click();
    await page.waitForTimeout(800);
    const terminalInput = page.locator('input[placeholder*="命令"]').first();
    if (await terminalInput.count() > 0) {
      await terminalInput.fill('Get-ChildItem');
      await terminalInput.press('Enter');
      await page.waitForTimeout(2000);
    }
  }

  const shot4 = path.join(screenshotsDir, '04-maf-review-and-terminal.png');
  await page.screenshot({ path: shot4, fullPage: false });
  console.log('✅ 截图 4 完成: ' + shot4);

  await browser.close();
  console.log('🎉 全部测试与截图完成！');
})();
