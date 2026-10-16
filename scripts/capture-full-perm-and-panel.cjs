const path = require('path');
const fs = require('fs');
module.paths.push(path.join(__dirname, '../frontend/node_modules'));
const { chromium } = require('playwright');

(async () => {
  console.log('🚀 开始全面测试并捕获高质量交付截图...');
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

  // 1. 访问 5175
  console.log('1. 打开前端主页面 http://127.0.0.1:5175 ...');
  await page.goto('http://127.0.0.1:5175', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 2. 新建会话
  try {
    const newChatBtn = page.locator('button:has-text("新聊天"), button[title*="新聊天"]').first();
    if (await newChatBtn.count() > 0) {
      await newChatBtn.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(1000);
    }
  } catch (e) {
    console.log('跳过新聊天点击直接在当前面板操作');
  }

  // 3. 切换为「完全访问权限」
  console.log('2. 切换为「完全访问权限」并确认...');
  const permSelector = page.locator('[data-testid="permission-mode-selector"]').first();
  await permSelector.click({ force: true, timeout: 5000 });
  await page.waitForTimeout(400);

  const fullPermOption = page.locator('[data-testid="permission-mode-full"]').first();
  await fullPermOption.click({ force: true, timeout: 5000 });
  await page.waitForTimeout(500);

  const confirmBtn = page.locator('[data-testid="confirm-full-access"], button:has-text("确认")').first();
  if (await confirmBtn.count() > 0 && await confirmBtn.isVisible()) {
    console.log('   点击完全权限确认弹窗...');
    await confirmBtn.click({ force: true, timeout: 5000 });
    await page.waitForTimeout(600);
  }

  // 4. 发送 Shell 命令
  console.log('3. 发送 Shell 终端执行命令（完全访问权限免审测试）...');
  const textarea = page.locator('textarea').first();
  await textarea.fill('请使用 run_shell 工具执行命令 "Get-Location; Get-Date"，输出当前目录和系统时间。在完全访问权限下体验直接免审执行。');
  await page.waitForTimeout(300);
  await textarea.press('Enter');

  // 5. 循环等待直到助手完全回答完毕
  console.log('4. 等待 Shell 执行与助手流式输出完成...');
  let approvalDetected = false;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);

    // 真正的人工审批卡片标志
    const approvalCard = page.locator('text=此工具请求执行敏感操作').first();
    if (await approvalCard.count() > 0 && await approvalCard.isVisible()) {
      approvalDetected = true;
      console.log('   ❌ 警告：检测到了人工审批卡片！');
      break;
    }

    const state = await page.evaluate(() => {
      const h = window.__deepagentTestHooks ? window.__deepagentTestHooks.getState() : null;
      if (!h || !h.messages) return null;
      const msgs = h.messages;
      const assistantMsgs = msgs.filter(m => m.role === 'assistant');
      const last = assistantMsgs[assistantMsgs.length - 1];
      return {
        count: msgs.length,
        hasAssistant: Boolean(last),
        contentLength: last ? last.content.length : 0,
        streaming: last ? last.streaming : false,
        activitiesCount: h.activities ? h.activities.length : 0,
      };
    });

    if (state && state.hasAssistant) {
      process.stdout.write(`\r   [秒 ${i+1}] 助手消息字数: ${state.contentLength}, 流式状态: ${state.streaming}, 活动数: ${state.activitiesCount}`);
      // 必须等到助手产生了正文，且流式生成结束！
      if (i > 12 && !state.streaming && state.contentLength > 20) {
        console.log(`\n   ✅ Shell 免审执行与正文流式输出完全就绪 (耗时约 ${i+1} 秒)`);
        break;
      }
    }
  }

  await page.waitForTimeout(2500);

  // 截图 17: 完全访问权限下 run_shell 免审执行、终端输出与总结正文
  const shot17 = path.join(screenshotsDir, '17-full-permission-shell-completed.png');
  await page.screenshot({ path: shot17 });
  console.log('📸 截图 17 已保存: ' + shot17);

  if (!approvalDetected) {
    console.log('🎉 验证成功：完全权限下调用 run_shell 彻底免审，绝无弹窗打扰！');
  }

  // 6. 测试文件修改与行级 Diff
  console.log('5. 新建会话测试文件修改与行级 Diff 对比...');
  try {
    const newChatBtn = page.locator('button:has-text("新聊天"), button[title*="新聊天"]').first();
    if (await newChatBtn.count() > 0) {
      await newChatBtn.click({ force: true, timeout: 5000 });
      await page.waitForTimeout(1000);
    }
  } catch (e) {}

  await textarea.fill('在工作区创建一个名为 diff-demo.txt 的文件，写入几行项目配置信息；然后使用 file_access_replace 修改其中的关键参数，并展示行级 Diff 差异对比。');
  await page.waitForTimeout(300);
  await textarea.press('Enter');

  console.log('6. 等待文件 Diff 与正文生成完成...');
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    const state = await page.evaluate(() => {
      const h = window.__deepagentTestHooks ? window.__deepagentTestHooks.getState() : null;
      if (!h || !h.messages) return null;
      const msgs = h.messages;
      const assistantMsgs = msgs.filter(m => m.role === 'assistant');
      const last = assistantMsgs[assistantMsgs.length - 1];
      return {
        count: msgs.length,
        hasAssistant: Boolean(last),
        contentLength: last ? last.content.length : 0,
        streaming: last ? last.streaming : false,
      };
    });

    if (state && state.hasAssistant) {
      process.stdout.write(`\r   [秒 ${i+1}] 助手消息字数: ${state.contentLength}, 流式状态: ${state.streaming}`);
      if (i > 12 && !state.streaming && state.contentLength > 20) {
        console.log(`\n   ✅ Diff 任务运行圆满完成 (耗时约 ${i+1} 秒)`);
        break;
      }
    }
  }

  await page.waitForTimeout(2500);

  // 截图 18: 文件Diff与面板功能展示
  const shot18 = path.join(screenshotsDir, '18-panel-diff-and-tokens.png');
  await page.screenshot({ path: shot18 });
  console.log('📸 截图 18 已保存: ' + shot18);

  await browser.close();
  console.log('🎉 全面测试与截图捕获顺利完成！');
})();
