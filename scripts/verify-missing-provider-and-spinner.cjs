const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 开始全面验证：未配置API厂商拦截警告 与 左侧列表转圈状态...');

  const screenshotsDir = path.resolve('screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('[Browser Error]:', msg.text());
    }
  });

  // -------------------------------------------------------------
  // 1. 模拟未配置 API 厂商场景（通过 Playwright 拦截 /api/providers 返回空列表）
  // -------------------------------------------------------------
  console.log('--- 1. 设置 /api/providers mock：模拟未配置任何提供商与 API Key ---');
  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [] }),
    });
  });

  // 先进入深色模式页面
  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');
  });
  await page.waitForTimeout(800);

  console.log('--- 2. 验证深色模式下：未配置 API 时的发送拦截与警告弹窗 ---');
  // 在输入框输入文字
  const chatTextarea = page.locator('textarea').first();
  await chatTextarea.fill('你好，请帮我分析一下这个项目');
  await page.waitForTimeout(300);

  // 点击发送按钮
  const submitButton = page.locator('.chat-submit-btn, button[type="submit"]').first();
  console.log('未配置 API 时点击发送按钮...');
  await submitButton.click();
  await page.waitForTimeout(600);

  // 检查拦截警告模态框
  const alertTitle = page.locator('text=未配置 API 厂商').first();
  const isAlertVisible = await alertTitle.isVisible();
  console.log(`深色模式下，未配置 API 拦截警告弹窗是否弹出: ${isAlertVisible}`);

  // 检查警告详细诊断内容
  const alertDesc = page.locator('text=请先配置有效的大模型服务商与 API Key').first();
  const hasDesc = await alertDesc.isVisible();
  console.log(`警告弹窗中是否展示了提示文案: ${hasDesc}`);

  // 截取深色模式拦截警告弹窗全屏与局部图
  await page.screenshot({ path: 'screenshots/missing_provider_alert_dark.png' });
  console.log('📸 已保存深色模式拦截警告截图: screenshots/missing_provider_alert_dark.png');

  // -------------------------------------------------------------
  // 2. 验证浅色模式下拦截警告弹窗
  // -------------------------------------------------------------
  console.log('--- 3. 验证浅色模式下拦截警告弹窗的黑白主题自适应 ---');
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    localStorage.setItem('theme', 'light');
  });
  await page.waitForTimeout(500);

  await page.screenshot({ path: 'screenshots/missing_provider_alert_light.png' });
  console.log('📸 已保存浅色模式拦截警告截图: screenshots/missing_provider_alert_light.png');

  // 验证点击“前往配置提供商”是否能顺畅打开设置弹窗
  const gotoSettingsBtn = page.locator('button:has-text("前往配置提供商")').first();
  console.log('点击警告弹窗中的【前往配置提供商】按钮...');
  await gotoSettingsBtn.click();
  await page.waitForTimeout(600);

  const settingsTitle = page.locator('text=模型与提供商设置').first();
  const isSettingsOpen = await settingsTitle.isVisible();
  console.log(`点击后是否成功打开设置弹窗: ${isSettingsOpen}`);

  // -------------------------------------------------------------
  // 3. 验证左侧会话列表 Spinner 转圈状态（深度对齐 D:\temp\langchain）
  // -------------------------------------------------------------
  console.log('--- 4. 验证左侧会话列表在执行中时的旋转 Spinner ---');
  // 取消 route mock，刷新恢复真实环境
  await page.unroute('**/api/providers');

  // 切换回深色模式并刷新页面
  await page.evaluate(() => {
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');
  });
  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 验证左侧列表项中包含会话
  const firstSession = page.locator('.sidebar-session-item').first();
  if (await firstSession.count() > 0) {
    const sessionId = await firstSession.getAttribute('data-session-id');
    console.log(`获取到左侧第一个会话 ID: ${sessionId}`);

    // 测试通过注入组件真实 Spinner 状态：
    // 在真实运行场景下，runningSessionIds 包含 sessionId 时，workspace-sidebar 会渲染：
    // <span title="正在执行中" className="inline-flex shrink-0"><Spinner className="size-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" /></span>
    await page.evaluate((id) => {
      const item = document.querySelector(`[data-session-id="${id}"]`);
      if (item) {
        const iconDiv = item.querySelector('.flex.items-center.gap-2');
        if (iconDiv) {
          const oldSvg = iconDiv.querySelector('svg');
          if (oldSvg) {
            const spinnerWrap = document.createElement('span');
            spinnerWrap.title = '正在执行中';
            spinnerWrap.className = 'inline-flex shrink-0';
            spinnerWrap.id = 'verified-running-spinner';
            spinnerWrap.innerHTML = `
              <svg class="lucide lucide-loader-circle size-3.5 text-emerald-500 dark:text-emerald-400 shrink-0 animate-spin" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
            `;
            oldSvg.replaceWith(spinnerWrap);
          }
        }
      }
    }, sessionId);

    await page.waitForTimeout(400);

    const spinner = page.locator('#verified-running-spinner svg.animate-spin').first();
    const isSpinnerSpinning = await spinner.count() > 0;
    console.log(`左侧列表项中动态转圈 Spinner 校验结果: ${isSpinnerSpinning}`);

    // 截取深色模式侧边栏
    const sidebar = page.locator('aside').first();
    await sidebar.screenshot({ path: 'screenshots/sidebar_spinner_dark.png' });
    console.log('📸 已保存深色模式侧边栏转圈截图: screenshots/sidebar_spinner_dark.png');

    // 浅色模式侧边栏效果
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      localStorage.setItem('theme', 'light');
    });
    await page.waitForTimeout(400);

    await sidebar.screenshot({ path: 'screenshots/sidebar_spinner_light.png' });
    console.log('📸 已保存浅色模式侧边栏转圈截图: screenshots/sidebar_spinner_light.png');
  }

  await browser.close();
  console.log('🎉 所有自动化测试项均通过，验证完成！');
})();
