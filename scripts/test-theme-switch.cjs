const path = require('path');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 测试 TodoCard 和深浅色主题表现...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', msg => console.log('浏览器控制台:', msg.text()));

  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 1. 检查深色主题下输入框与页面
  await page.screenshot({ path: 'screenshots/theme_dark_default.png' });
  console.log('✅ 保存截图 screenshots/theme_dark_default.png');

  // 2. 点击切换为浅色主题按钮（header 上的日/月图标按钮）
  const themeToggleBtn = page.locator('[data-testid="header-toggle-theme-btn"]');
  if (await themeToggleBtn.count() > 0) {
    await themeToggleBtn.click();
    await page.waitForTimeout(600);
    console.log('已点击切换为浅色主题');
    await page.screenshot({ path: 'screenshots/theme_light_default.png' });
    console.log('✅ 保存截图 screenshots/theme_light_default.png');
  }

  // 3. 在浅色模式下，截取底部输入框区域
  const inputBottomBar = page.locator('.shrink-0.bg-black.px-4.py-4, .shrink-0.px-4.py-4');
  if (await inputBottomBar.count() > 0) {
    await inputBottomBar.first().screenshot({ path: 'screenshots/theme_light_input.png' });
    console.log('✅ 保存截图 screenshots/theme_light_input.png');
  }

  await browser.close();
})();
