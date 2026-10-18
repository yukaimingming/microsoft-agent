const path = require('path');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 开始全流程视觉验证：ContextMeter 与 排队/立即引导功能...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', (msg) => console.log('浏览器控制台:', msg.text()));

  console.log('1. 打开页面 http://127.0.0.1:5175 ...');
  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const inputBottomBar = page.locator('.shrink-0.bg-black.px-4.py-4');

  // 截图 1: 验证 ContextMeter 默认状态（环形用量胶囊，单行不折行）
  await inputBottomBar.screenshot({ path: 'screenshots/01-context-meter-default.png' });
  console.log('✅ 截图 1 已保存: screenshots/01-context-meter-default.png');

  // 点击 ContextMeter 验证弹出用量对话框
  const meterBtn = page.locator('.context-meter-btn');
  if (await meterBtn.count() > 0) {
    await meterBtn.first().click();
    await page.waitForTimeout(500);
    // 整页截图捕获完整的向上浮动弹窗
    await page.screenshot({ path: 'screenshots/02-context-meter-dialog.png' });
    console.log('✅ 截图 2 已保存: screenshots/02-context-meter-dialog.png');
    // 关闭 dialog (点击页面任意空白处)
    await page.mouse.click(100, 100);
    await page.waitForTimeout(400);
  }

  // 2. 发送一条生成任务，让模型进入正在回复中（isRunning === true）
  const textarea = page.locator('.chat-prompt-textarea');
  await textarea.fill('请写一段 300 字关于智能体在生产环境落地的挑战与解决思路');
  await page.keyboard.press('Enter');
  console.log('已发送指令，等待模型回复生成...');
  await page.waitForTimeout(1000);

  // 3. 模型回复中，输入用户指定的提示词
  console.log('模型回复中，在输入框输入提示词...');
  await textarea.fill('还有确定要用什么token吗，目前只是个人agent');
  await page.waitForTimeout(400);

  // 截图 3: 模型回复中，右侧显示【排队】与【立即引导】按钮
  await inputBottomBar.screenshot({ path: 'screenshots/03-replying-with-queue-buttons.png' });
  console.log('✅ 截图 3 已保存: screenshots/03-replying-with-queue-buttons.png');

  // 4. 点击【排队】按钮
  const queueBtn = page.locator('button:has-text("排队")');
  console.log('点击【排队】按钮...');
  await queueBtn.click();
  await page.waitForTimeout(600);

  // 截图 4: 排队卡片展示在输入框上方，输入框文字清空并显示 Cmd/Ctrl+Enter 占位符
  await inputBottomBar.screenshot({ path: 'screenshots/04-queue-card-in-input.png' });
  console.log('✅ 截图 4 已保存: screenshots/04-queue-card-in-input.png');

  // 截图 5: 完整全景图
  await page.screenshot({ path: 'screenshots/05-full-page-queue-view.png' });
  console.log('✅ 截图 5 已保存: screenshots/05-full-page-queue-view.png');

  await browser.close();
  console.log('🎉 验证全部成功完成！');
})();
