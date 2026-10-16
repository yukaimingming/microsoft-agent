const path = require('path');
const fs = require('fs');
module.paths.push(path.join(__dirname, '../frontend/node_modules'));
const { chromium } = require('playwright');

(async () => {
  console.log('🚀 开始完整交互测试：点击批准 -> 继续执行 -> 等待全部完成 -> 校验正文...');
  const screenshotsDir = path.join(__dirname, '../screenshots');

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1040 }, locale: 'zh-CN' });

  await page.goto('http://127.0.0.1:5175', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 点击新聊天
  const newChatBtn = page.locator('button:has-text("新聊天"), button[title*="新聊天"]').first();
  if (await newChatBtn.count() > 0) {
    await newChatBtn.click();
    await page.waitForTimeout(1000);
  }

  // 发送
  const userPrompt = '在工作区创建一个名为 demo-notes.txt 的文件，写入几行项目介绍；再用 file_access_replace 修改其中内容并展示行级 Diff 对比。';
  const textarea = page.locator('textarea').first();
  await textarea.fill(userPrompt);
  await page.waitForTimeout(300);
  const submitBtn = page.locator('button[type="submit"]').first();
  await submitBtn.click();

  console.log('监控执行并处理审批...');
  for (let sec = 0; sec < 60; sec++) {
    await page.waitForTimeout(1000);

    // 检查审批
    const approveBtn = page.locator('button:has-text("批准"):not(:has-text("请求"))').first();
    if (await approveBtn.count() > 0 && await approveBtn.isVisible()) {
      console.log(`[${sec}s] 点击批准...`);
      await approveBtn.click();
      await page.waitForTimeout(500);

      const resumeBtn = page.locator('button:has-text("继续执行")').first();
      if (await resumeBtn.count() > 0 && await resumeBtn.isVisible() && !(await resumeBtn.isDisabled())) {
        console.log(`[${sec}s] 点击继续执行...`);
        await resumeBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    // 检查是否还在运行或等待
    const statusText = await page.innerText('body');
    const isLive = statusText.includes('模型深度思考') || statusText.includes('执行中') || statusText.includes('需人工确认');
    if (!isLive && sec > 12) {
      console.log(`[${sec}s] 任务真正全部完成！`);
      break;
    }
  }

  await page.waitForTimeout(3000);

  // 截取当前最终界面
  const shotPath = path.join(screenshotsDir, '24-final-full-execution.png');
  await page.screenshot({ path: shotPath });
  console.log('已截图: ' + shotPath);

  // 查看正文
  const messageTexts = await page.locator('[data-slot="message-content"], article, .text-zinc-100').allInnerTexts();
  console.log('消息文本元素数量:', messageTexts.length);
  for (let i = 0; i < messageTexts.length; i++) {
    const t = messageTexts[i].trim();
    if (t.length > 0) {
      console.log(`- 文本[${i}]: ${t.slice(0, 80).replace(/\n/g, ' ')}`);
    }
  }

  await browser.close();
})();
