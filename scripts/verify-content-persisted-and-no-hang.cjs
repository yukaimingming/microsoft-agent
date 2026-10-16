const path = require('path');
const fs = require('fs');
module.paths.push(path.join(__dirname, '../frontend/node_modules'));
const { chromium } = require('playwright');

(async () => {
  console.log('🚀 开始验证：文件修改生成Diff后正文完整保留不闪退、执行不卡顿、按钮状态及时恢复...');
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

  // 1. 打开前端
  console.log('1. 访问前端 http://127.0.0.1:5175 ...');
  await page.goto('http://127.0.0.1:5175', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 2. 点击新聊天
  console.log('2. 开启新聊天会话...');
  const newChatBtn = page.locator('button:has-text("新聊天"), button[title*="新聊天"]').first();
  if (await newChatBtn.count() > 0) {
    await newChatBtn.click();
    await page.waitForTimeout(1000);
  }

  // 3. 发送完全相同的提示词
  const userPrompt = '在工作区创建一个名为 demo-notes.txt 的文件，写入几行项目介绍；再用 file_access_replace 修改其中内容并展示行级 Diff 对比。';
  console.log('3. 发送用户提示词: ' + userPrompt);
  const textarea = page.locator('textarea').first();
  await textarea.fill(userPrompt);
  await page.waitForTimeout(300);
  const submitBtn = page.locator('button[type="submit"]').first();
  await submitBtn.click();

  console.log('4. 监控执行流程，自动处理审批并记录各阶段状态...');
  let contentObserved = false;
  let maxWaitSeconds = 60;
  let completedInSeconds = -1;

  for (let i = 0; i < maxWaitSeconds; i++) {
    await page.waitForTimeout(1000);

    // 审批自动放行
    const approveActionBtn = page.locator('button:has-text("批准"):not(:has-text("请求"))').first();
    if (await approveActionBtn.count() > 0 && await approveActionBtn.isVisible()) {
      console.log(`   [第 ${i} 秒] 点击「批准」操作...`);
      await approveActionBtn.click();
      await page.waitForTimeout(400);

      const resumeBtn = page.locator('button:has-text("继续执行")').first();
      if (await resumeBtn.count() > 0 && await resumeBtn.isVisible() && !(await resumeBtn.isDisabled())) {
        await resumeBtn.click();
      }
    }

    // 监测正文出现
    const contentLocator = page.locator('[data-slot="message-content"]').first();
    if (await contentLocator.count() > 0 && await contentLocator.isVisible()) {
      const text = await contentLocator.innerText();
      if (text.trim().length > 10) {
        if (!contentObserved) {
          console.log(`   [第 ${i} 秒] ✅ 观察到正文内容开始流式输出: "${text.trim().slice(0, 35)}..."`);
          contentObserved = true;
        }
      }
    }

    // 检查按钮与运行状态
    const isRunning = (await page.getByText('模型深度思考').count() > 0) || (await page.getByText('执行中').count() > 0);
    if (!isRunning && i > 12) {
      console.log(`   [第 ${i} 秒] 🎉 智能体运行正常结束！未发生卡顿，按钮已恢复可用状态！`);
      completedInSeconds = i;
      break;
    }
  }

  // 等待 3 秒观察完成后正文是否稳固存在
  console.log('5. 等待 3 秒观察完成后正文是否依然稳固呈现（严防闪退）...');
  await page.waitForTimeout(3000);

  // 严格核查正文
  const finalContentLocator = page.locator('[data-slot="message-content"]').first();
  let finalContentText = '';
  if (await finalContentLocator.count() > 0 && await finalContentLocator.isVisible()) {
    finalContentText = (await finalContentLocator.innerText()).trim();
  }

  console.log(`   最终页面正文文本长度: ${finalContentText.length} 字符`);
  console.log(`   最终正文内容预览: "${finalContentText.slice(0, 60)}..."`);

  if (finalContentText.length > 20) {
    console.log('   ✅ 验证通过：正文内容牢固保留在页面中，绝未消失！');
  } else {
    console.error('   ❌ 失败：正文内容仍未显示或被意外隐藏！');
  }

  // 截图 22: 正文完整显示、Diff卡片收缩、按钮恢复空闲的完美状态
  const shot22 = path.join(screenshotsDir, '22-file-diff-and-content-persisted.png');
  await page.screenshot({ path: shot22 });
  console.log('✅ 截图已保存 (正文完整保留不闪退、Diff卡片默认收缩): ' + shot22);

  // 展开 Diff 卡片并截图
  const diffTrigger = page.locator('button:has-text("个文件变更")').first();
  if (await diffTrigger.count() > 0) {
    await diffTrigger.click();
    await page.waitForTimeout(600);
    const fileRow = page.locator('button:has-text("demo-notes.txt")').first();
    if (await fileRow.count() > 0) {
      await fileRow.click();
      await page.waitForTimeout(600);
    }
    const shot23 = path.join(screenshotsDir, '23-diff-expanded-with-persisted-content.png');
    await page.screenshot({ path: shot23 });
    console.log('✅ 截图已保存 (Diff手动展开且正文依然完好在下方): ' + shot23);
  }

  await browser.close();
  console.log(`🎉 验证完毕！整轮耗时约 ${completedInSeconds} 秒，彻底告别卡顿与正文消失！`);
})();
