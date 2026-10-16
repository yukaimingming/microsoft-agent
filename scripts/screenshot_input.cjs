const path = require('path');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  console.log('Navigating to http://127.0.0.1:5175 ...');
  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 1. 暗色模式整页与输入框局部特写
  await page.screenshot({ path: 'screenshots/aligned_input_full.png' });
  const inputContainer = page.locator('.chat-prompt-input');
  if (await inputContainer.count() > 0) {
    await inputContainer.screenshot({ path: 'screenshots/aligned_input_box.png' });
    console.log('暗色输入框截图完成');
  }

  // 2. 悬停 token usage 按钮
  const usageBtn = page.locator('.chat-token-usage-btn');
  if (await usageBtn.count() > 0) {
    await usageBtn.hover();
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'screenshots/aligned_input_hover_usage.png' });
    console.log('Hover 用量截图完成');
  }

  // 3. 浅色模式截图
  const themeBtn = page.locator('button[data-testid="header-toggle-theme-btn"]');
  if (await themeBtn.count() > 0) {
    await themeBtn.click();
    await page.waitForTimeout(800);
    if (await inputContainer.count() > 0) {
      await inputContainer.screenshot({ path: 'screenshots/aligned_input_box_light.png' });
      console.log('浅色输入框截图完成');
    }
  }

  await browser.close();
  console.log('截图全部成功生成!');
})();
