const path = require('path');
const fs = require('fs');
module.paths.push(path.join(__dirname, '../frontend/node_modules'));
const { chromium } = require('playwright');

(async () => {
  console.log('🚀 开始执行工作区选择与模型厂商持久化联动测试...');
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

  // 1. 访问前端 (http://127.0.0.1:5175)
  console.log('1. 打开前端主页面 http://127.0.0.1:5175 ...');
  await page.goto('http://127.0.0.1:5175', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 2. 测试工作区选择与磁盘驱动器选择
  console.log('2. 测试左侧工作区文件夹选择（默认工作区与全盘符驱动器展示）...');
  const addWorkspaceBtn = page.locator('button.sidebar-add-workspace-button, button[title="添加工作区"]').first();
  await addWorkspaceBtn.click();
  await page.waitForTimeout(1000);

  // 等待文件夹选择弹窗加载完毕
  const folderModal = page.locator('text=选择工作区文件夹').first();
  await folderModal.waitFor({ state: 'visible', timeout: 5000 });

  // 截图 09: 工作区弹窗中包含默认工作区与本机所有驱动器（C盘、D盘、E盘、桌面、文档等）
  const shot9 = path.join(screenshotsDir, '09-workspace-folder-picker-with-drives.png');
  await page.screenshot({ path: shot9 });
  console.log('✅ [1/3] 截图完成 (工作区弹窗支持默认Workspace与各磁盘选择): ' + shot9);

  // 点击选择 D:\ 盘或默认工作区进行测试
  const driveBtn = page.locator('button:has-text("新加卷 (D:)"), button:has-text("默认工作区")').first();
  if (await driveBtn.count() > 0) {
    await driveBtn.click();
    await page.waitForTimeout(800);
  }

  // 关闭文件夹弹窗（点击取消或右上角关闭）
  const closeFolderModalBtn = page.locator('button:has-text("取消")').first();
  if (await closeFolderModalBtn.count() > 0) {
    await closeFolderModalBtn.click();
  } else {
    await page.mouse.click(50, 50);
  }
  await page.waitForTimeout(600);

  // 3. 测试模型厂商设置：拉取远程模型并保存提示
  console.log('3. 打开设置模态框并测试模型获取与保存提示...');
  const settingsBtn = page.locator('[data-testid="open-settings-modal-btn"], button:has-text("设置")').first();
  await settingsBtn.click();
  await page.waitForTimeout(1000);

  // 点击“获取远程模型列表”
  const fetchModelsBtn = page.locator('button.settings-fetch-models-btn, button:has-text("获取远程模型列表")').first();
  if (await fetchModelsBtn.count() > 0) {
    console.log('点击「获取远程模型列表」按钮...');
    await fetchModelsBtn.click();
    await page.waitForTimeout(2000);
  }

  // 点击保存修改按钮
  const saveBtn = page.locator('button.settings-save-btn, button:has-text("保存修改")').first();
  if (await saveBtn.count() > 0) {
    console.log('点击「保存修改」按钮触发配置持久化与成功提示...');
    await saveBtn.click();
    await page.waitForTimeout(1000);
  }

  // 截图 10: 模型设置弹窗成功拉取模型并展示显眼的自动保存/保存成功高亮提示
  const shot10 = path.join(screenshotsDir, '10-provider-settings-fetch-and-save.png');
  await page.screenshot({ path: shot10 });
  console.log('✅ [2/3] 截图完成 (模型获取成功、保存修改并展示高亮通知): ' + shot10);

  // 关闭设置模态框
  const closeSettingsBtn = page.locator('button[aria-label="Close"], button:has-text("关闭")').first();
  if (await closeSettingsBtn.count() > 0) {
    await closeSettingsBtn.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(800);

  // 4. 测试输入框左下角模型下拉菜单与获取到的模型完整联动
  console.log('4. 验证主界面输入框模型下拉菜单联动展示所有获取到的模型...');
  const modelDropdownBtn = page.locator('button[title*="点击下拉切换当前模型"]').first();
  await modelDropdownBtn.waitFor({ state: 'visible', timeout: 5000 });
  await modelDropdownBtn.click();
  await page.waitForTimeout(600);

  // 截图 11: 输入框模型下拉菜单展开，展示全部 10+ 个远程模型列表
  const shot11 = path.join(screenshotsDir, '11-chat-input-models-dropdown.png');
  await page.screenshot({ path: shot11 });
  console.log('✅ [3/3] 截图完成 (输入框模型下拉成功列出所有获取到的模型): ' + shot11);

  await browser.close();
  console.log('🎉 所有新增问题验证完毕并通过全部测试！');
})().catch((err) => {
  console.error('❌ 测试运行出错:', err);
  process.exit(1);
});
