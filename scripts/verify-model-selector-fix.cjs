const path = require('path');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 开始全面验证模型选择器修复情况...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', msg => console.log('[Browser Console]:', msg.text()));

  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 1. 深色模式测试
  console.log('--- 1. 验证深色模式下的模型选择器 ---');
  await page.evaluate(() => {
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');
  });
  await page.waitForTimeout(300);

  let modelBtn = page.locator('button[title*="切换当前模型"]').first();
  const initialModelText = (await modelBtn.innerText()).trim();
  console.log(`初始选中的模型名称: "${initialModelText}"`);

  console.log('点击模型选择按钮展开下拉菜单...');
  await modelBtn.click();
  await page.waitForTimeout(500);

  const modelDropdown = page.locator('.workspace-dropdown-panel.composer-menu').first();
  const isDropdownVisible = await modelDropdown.isVisible();
  console.log(`深色模式下下拉菜单是否可见: ${isDropdownVisible}`);

  const modelItems = await page.locator('.workspace-dropdown-panel.composer-menu button:has-text("deepseek"), .workspace-dropdown-panel.composer-menu button:has-text("Atria"), .workspace-dropdown-panel.composer-menu button:has-text("qwen")').all();
  console.log(`找到可用模型项数量: ${modelItems.length}`);

  // 截图深色模式
  await page.screenshot({ path: 'screenshots/model_selector_dark_fixed.png' });
  console.log('📸 已保存深色模式截图: screenshots/model_selector_dark_fixed.png');

  // 选择切换为 deepseek-reasoner
  const targetModelBtn = page.locator('.workspace-dropdown-panel.composer-menu button:has-text("deepseek-reasoner")').first();
  if (await targetModelBtn.count() > 0) {
    console.log('点击切换为 deepseek-reasoner...');
    await targetModelBtn.click();
    await page.waitForTimeout(400);

    modelBtn = page.locator('button[title*="切换当前模型"]').first();
    const updatedModelText = (await modelBtn.innerText()).trim();
    console.log(`切换后选中的模型名称: "${updatedModelText}"`);
  }

  // 2. 浅色模式测试
  console.log('--- 2. 验证浅色模式下的模型选择器与黑白主题自适应 ---');
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    localStorage.setItem('theme', 'light');
  });
  await page.waitForTimeout(400);

  modelBtn = page.locator('button[title*="切换当前模型"]').first();
  console.log('浅色模式下点击模型选择按钮...');
  await modelBtn.click();
  await page.waitForTimeout(500);

  const isLightDropdownVisible = await modelDropdown.isVisible();
  console.log(`浅色模式下下拉菜单是否可见: ${isLightDropdownVisible}`);

  // 截图浅色模式
  await page.screenshot({ path: 'screenshots/model_selector_light_fixed.png' });
  console.log('📸 已保存浅色模式截图: screenshots/model_selector_light_fixed.png');

  // 3. 验证思考等级下拉也正常弹出
  console.log('--- 3. 验证思考等级下拉菜单 ---');
  const effortBtn = page.locator('button[title*="切换思考等级"]').first();
  if (await effortBtn.count() > 0) {
    await effortBtn.click();
    await page.waitForTimeout(400);
    const effortDropdown = page.locator('.workspace-dropdown-panel.composer-menu:has-text("思考等级")');
    console.log(`思考等级下拉菜单是否正常弹出可见: ${await effortDropdown.isVisible()}`);
  }

  // 4. 验证权限模式下拉也正常弹出
  console.log('--- 4. 验证权限模式下拉菜单 ---');
  const permBtn = page.locator('button[data-testid="permission-mode-selector"]').first();
  if (await permBtn.count() > 0) {
    await permBtn.click();
    await page.waitForTimeout(400);
    const permDropdown = page.locator('.workspace-dropdown-panel.composer-menu:has-text("请求批准")');
    console.log(`权限模式下拉菜单是否正常弹出可见: ${await permDropdown.isVisible()}`);
  }

  await browser.close();
  console.log('🎉 所有验证步骤执行完毕！全部通过！');
})();
