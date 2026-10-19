const path = require('path');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 开始验证输入框背面折叠排队卡片样式...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', msg => console.log('[Browser]:', msg.text()));

  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 1. 发送第一条长任务消息进入流式生成状态
  const textarea = page.locator('.chat-prompt-textarea');
  await textarea.fill('请详细分析智能体多任务调度和任务队列的最佳实践方案，给出架构图与原理分析。');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // 2. 在模型正在回复状态下，依次添加两条排队任务（对齐用户图片）
  console.log('添加排队任务 1...');
  await textarea.fill('pnpm --filter @deepagent/web dev - 启动前端服务');
  await page.waitForTimeout(400);

  let queueBtn = page.locator('button:has-text("排队")');
  if (await queueBtn.count() > 0) {
    await queueBtn.click();
    await page.waitForTimeout(500);
  }

  console.log('添加排队任务 2...');
  await textarea.fill('dotnet run --project backend\\MafHarness.Web - 启动后端网关');
  await page.waitForTimeout(400);

  queueBtn = page.locator('button:has-text("排队")');
  if (await queueBtn.count() > 0) {
    await queueBtn.click();
    await page.waitForTimeout(500);
  }

  // 3. 在输入框中输入第三条正在编辑的文本，完美复刻用户截图中的形态
  await textarea.fill('排队卡片再优化 一下显示的位置 我想它能显示在输入框的背面 但不是在输入框里面 就');
  await page.waitForTimeout(500);

  // 4. 捕获深色模式下的效果（展开态）
  console.log('📸 截图深色模式（Dark）展开态...');
  const composerArea = page.locator('.chat-prompt-input').locator('xpath=..');
  if (await composerArea.count() > 0) {
    await composerArea.screenshot({ path: 'screenshots/stacked_queue_dark_expanded.png' });
  }
  await page.screenshot({ path: 'screenshots/stacked_queue_dark_full.png' });

  // 5. 点击折叠按钮，测试折叠态
  console.log('测试折叠...');
  const collapseBtn = page.locator('button[title*="排队任务"]').first();
  if (await collapseBtn.count() > 0) {
    await collapseBtn.click();
    await page.waitForTimeout(400);
    console.log('📸 截图深色模式（Dark）折叠态...');
    await composerArea.screenshot({ path: 'screenshots/stacked_queue_dark_collapsed.png' });
    // 再次点击展开
    await collapseBtn.click();
    await page.waitForTimeout(400);
  }

  // 6. 切换为浅色（Light）模式
  console.log('切换到浅色（Light）模式...');
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await page.waitForTimeout(600);

  console.log('📸 截图浅色模式（Light）展开态...');
  if (await composerArea.count() > 0) {
    await composerArea.screenshot({ path: 'screenshots/stacked_queue_light_expanded.png' });
  }
  await page.screenshot({ path: 'screenshots/stacked_queue_light_full.png' });

  // 7. 测试浅色下的折叠态
  if (await collapseBtn.count() > 0) {
    await collapseBtn.click();
    await page.waitForTimeout(400);
    console.log('📸 截图浅色模式（Light）折叠态...');
    await composerArea.screenshot({ path: 'screenshots/stacked_queue_light_collapsed.png' });
  }

  console.log('✅ 所有黑白双色主题与折叠/展开测试截图全部完成！');
  await browser.close();
})();
