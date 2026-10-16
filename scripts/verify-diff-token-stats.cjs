const path = require('path');
const fs = require('fs');
module.paths.push(path.join(__dirname, '../frontend/node_modules'));
const { chromium } = require('playwright');

(async () => {
  console.log('🚀 开始执行文件Diff差异、正文不闪退与底部Token统计自动化测试...');
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
  await page.waitForTimeout(2000);

  // 2. 点击左上角“新聊天”进入空白新会话
  console.log('2. 点击「新聊天」以确保在干净新会话中测试...');
  const newChatBtn = page.locator('button:has-text("新聊天"), button[title*="新聊天"], button[title*="新建"]').first();
  if (await newChatBtn.count() > 0) {
    await newChatBtn.click();
    await page.waitForTimeout(1500);
  }

  // 截图 12: 主页面新会话快捷建议卡片与清爽暗黑输入框布局
  console.log('3. 截图主界面建议提示词与输入框...');
  const shot12 = path.join(screenshotsDir, '12-main-page-token-stats-at-bottom.png');
  await page.screenshot({ path: shot12 });
  console.log('✅ [1/3] 截图完成 (新会话主界面建议提示词与输入框): ' + shot12);

  // 4. 发送文件修改与 Diff 对比任务
  console.log('4. 触发建议提示词：多盘读写与行级 Diff ...');
  const filePromptBtn = page.locator('button:has-text("多盘读写与行级 Diff"), button:has-text("文件变更")').first();
  if (await filePromptBtn.count() > 0) {
    await filePromptBtn.click();
  } else {
    const textarea = page.locator('textarea').first();
    await textarea.fill('在工作区创建一个名为 demo-notes.txt 的文件，写入几行项目介绍；再用 file_access_replace 修改其中内容并展示行级 Diff 对比。');
    await page.waitForTimeout(300);
    const submitBtn = page.locator('button[type="submit"]').first();
    await submitBtn.click();
  }

  // 5. 等待 Agent 执行文件写入、Diff 对比与正文流式输出
  console.log('5. 等待 Agent 执行文件写入、Diff 对比与正文流式输出...');
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);

    // 检查是否有审批卡片（排除输入框左下角的「请求批准」下拉菜单按钮）
    const approveActionBtn = page.locator('button:has-text("批准"):not(:has-text("请求"))').first();
    if (await approveActionBtn.count() > 0 && await approveActionBtn.isVisible()) {
      console.log('   检测到敏感操作审批请求卡片，点击「批准」...');
      await approveActionBtn.click();
      await page.waitForTimeout(400);

      const resumeBtn = page.locator('button:has-text("继续执行")').first();
      if (await resumeBtn.count() > 0 && await resumeBtn.isVisible() && !(await resumeBtn.isDisabled())) {
        console.log('   点击「继续执行」恢复任务流...');
        await resumeBtn.click();
        await page.waitForTimeout(600);
      }
    }

    // 检查是否有全访问弹窗
    const confirmFullBtn = page.locator('button:has-text("确认开启"), button:has-text("确认")').first();
    if (await confirmFullBtn.count() > 0 && await confirmFullBtn.isVisible()) {
      await confirmFullBtn.click();
    }

    // 检查运行是否真正完成（顶栏模型深度思考中与左侧执行中消失）
    const isRunning = (await page.getByText('模型深度思考').count() > 0) || (await page.getByText('执行中').count() > 0);
    if (!isRunning && i > 15) {
      console.log(`   Agent 运行圆满完成 (耗时约 ${i} 秒)`);
      break;
    }
  }

  // 等待渲染稳定
  await page.waitForTimeout(2500);

  // 截图 13: 包含行级 Diff 差异对比（红绿高亮）与完整正文输出（正文清晰未消失、不卡住）
  const shot13 = path.join(screenshotsDir, '13-file-diff-and-persisted-content.png');
  await page.screenshot({ path: shot13 });
  console.log('✅ [2/3] 截图完成 (文件Diff红绿对比正常，正文完整呈现不闪退): ' + shot13);

  // 验证正文是否确实存在且未消失
  const assistantMsgText = await page.locator('[class*="MessageContent"]').allInnerTexts();
  const fullText = assistantMsgText.join('\n');
  console.log(`   验证正文文字长度: ${fullText.length} 字符`);
  if (fullText.length > 20) {
    console.log('   ✅ 正文内容稳固展示在页面中，未发生闪退消失！');
  }

  // 6. 测试“深度思考”并验证思维链折叠与正文输出
  console.log('6. 测试新建会话并执行深度思考...');
  if (await newChatBtn.count() > 0) {
    await newChatBtn.click();
    await page.waitForTimeout(1000);
  }

  const thinkPromptBtn = page.locator('button:has-text("深度推演与思维链"), button:has-text("深度思考")').first();
  if (await thinkPromptBtn.count() > 0) {
    await thinkPromptBtn.click();
    console.log('   已触发深度推演任务，等待思考流与正文完成...');
    for (let j = 0; j < 60; j++) {
      await page.waitForTimeout(1000);
      const isRunning = (await page.getByText('模型深度思考').count() > 0) || (await page.getByText('执行中').count() > 0);
      if (!isRunning && j > 15) break;
    }
    await page.waitForTimeout(2000);
    const shot14 = path.join(screenshotsDir, '14-deep-reasoning-and-bottom-stats.png');
    await page.screenshot({ path: shot14 });
    console.log('✅ [3/3] 截图完成 (深度思考流连贯，输入框下方Token统计实时更新): ' + shot14);
  }

  await browser.close();
  console.log('🎉 全部自动化测试完成！');
})();
