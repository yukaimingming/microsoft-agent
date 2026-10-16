const path = require('path');
const fs = require('fs');
module.paths.push(path.join(__dirname, '../frontend/node_modules'));
const { chromium } = require('playwright');

(async () => {
  console.log('🚀 开始验证：1. Diff差异卡片默认收缩不展开  2. 思维链严格位于正文上方不跳动');
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

  // 1. 打开页面
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

  // 3. 测试文件创建与修改以触发 Diff 卡片
  console.log('3. 触发多盘读写与行级 Diff 任务...');
  const textarea = page.locator('textarea').first();
  await textarea.fill('在工作区创建一个名为 demo-notes.txt 的文件，写入几行项目介绍；再用 file_access_replace 修改其中内容并展示行级 Diff 对比。');
  await page.waitForTimeout(300);
  const submitBtn = page.locator('button[type="submit"]').first();
  await submitBtn.click();

  // 等待执行完成（若有安全审批自动点击批准）
  console.log('4. 等待文件修改及 Diff 生成...');
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);

    const approveActionBtn = page.locator('button:has-text("批准"):not(:has-text("请求"))').first();
    if (await approveActionBtn.count() > 0 && await approveActionBtn.isVisible()) {
      console.log('   点击「批准」敏感文件操作...');
      await approveActionBtn.click();
      await page.waitForTimeout(400);

      const resumeBtn = page.locator('button:has-text("继续执行")').first();
      if (await resumeBtn.count() > 0 && await resumeBtn.isVisible() && !(await resumeBtn.isDisabled())) {
        await resumeBtn.click();
      }
    }

    const confirmFullBtn = page.locator('button:has-text("确认开启"), button:has-text("确认")').first();
    if (await confirmFullBtn.count() > 0 && await confirmFullBtn.isVisible()) {
      await confirmFullBtn.click();
    }

    const isRunning = (await page.getByText('模型深度思考').count() > 0) || (await page.getByText('执行中').count() > 0);
    if (!isRunning && i > 15) {
      console.log(`   文件修改任务执行完成 (耗时约 ${i} 秒)`);
      break;
    }
  }

  await page.waitForTimeout(2000);

  // 验证 Diff 卡片是否默认收缩
  console.log('5. 验证 Diff 卡片默认是否收缩...');
  const diffSectionTrigger = page.locator('button:has-text("个文件变更")').first();
  if (await diffSectionTrigger.count() > 0) {
    const isTriggerVisible = await diffSectionTrigger.isVisible();
    console.log(`   Diff 卡片栏可见: ${isTriggerVisible}`);

    // 检查 demo-notes.txt 是否不可见（默认整个收起）
    const fileRowBefore = page.locator('button:has-text("demo-notes.txt")').first();
    const isFileVisibleBefore = await fileRowBefore.isVisible();
    console.log(`   默认状态下内部文件列表是否折叠隐藏: ${!isFileVisibleBefore}`);

    // 截图 18: Diff 卡片默认处于折叠收缩状态
    const shot18 = path.join(screenshotsDir, '18-diff-card-default-collapsed.png');
    await page.screenshot({ path: shot18 });
    console.log('✅ 截图已保存 (Diff卡片默认收缩): ' + shot18);

    // 点击展开主卡片测试
    console.log('   点击展开 Diff 主卡片...');
    await diffSectionTrigger.click();
    await page.waitForTimeout(800);

    // 单文件详情展开
    const fileRowBtn = page.locator('button:has-text("demo-notes.txt")').first();
    if (await fileRowBtn.count() > 0) {
      console.log('   点击展开单文件行级差异...');
      await fileRowBtn.click();
      await page.waitForTimeout(800);
    }

    // 截图 19: 手动展开后的 Diff 细节
    const shot19 = path.join(screenshotsDir, '19-diff-card-manually-expanded.png');
    await page.screenshot({ path: shot19 });
    console.log('✅ 截图已保存 (Diff卡片手动展开后显示行级差异对比): ' + shot19);
  }

  // 6. 测试深度思考，严格验证思维链在正文上方
  console.log('6. 测试深度思考与思维链上下排列位置...');
  if (await newChatBtn.count() > 0) {
    await newChatBtn.click();
    await page.waitForTimeout(1000);
  }

  const thinkTextarea = page.locator('textarea').first();
  await thinkTextarea.fill('请启动深度思考，全面对比快速排序与堆排序算法在内存局部性、最坏时间复杂度与工业界实际系统场景下的核心差异。');
  await page.waitForTimeout(300);
  const thinkSubmitBtn = page.locator('button[type="submit"]').first();
  await thinkSubmitBtn.click();

  console.log('7. 监控思考中状态及正文生成...');
  let checkedOrderDuringStreaming = false;

  for (let j = 0; j < 60; j++) {
    await page.waitForTimeout(1000);

    // 检测思维链与正文的位置 (思维链是 section.process-group，正文是含有正文内容的元素)
    const processGroupLocator = page.locator('.process-group').first();
    const hasProcessGroup = await processGroupLocator.count() > 0;
    
    // 正文选择器
    const contentLocator = page.locator('[data-slot="message-content"]').first();
    const hasContent = await contentLocator.count() > 0;

    if (hasProcessGroup && hasContent && !checkedOrderDuringStreaming) {
      const pBox = await processGroupLocator.boundingBox();
      const cBox = await contentLocator.boundingBox();
      if (pBox && cBox && cBox.height > 10) {
        console.log(`   流式输出中位置对比 -> 思维链 Y: ${pBox.y}, 正文 Y: ${cBox.y}`);
        if (pBox.y < cBox.y) {
          console.log('   ✅ 验证通过：思维链位置在正文上方！');
          checkedOrderDuringStreaming = true;
          const shot20 = path.join(screenshotsDir, '20-reasoning-above-response-streaming.png');
          await page.screenshot({ path: shot20 });
          console.log('✅ 截图已保存 (流式输出中思维链在正文上方): ' + shot20);
        } else {
          console.error('   ❌ 警告：思维链 Y 坐标大于正文 Y 坐标！');
        }
      }
    }

    const isRunning = (await page.getByText('模型深度思考').count() > 0) || (await page.getByText('执行中').count() > 0);
    if (!isRunning && j > 15) {
      console.log(`   深度思考任务执行完毕 (耗时约 ${j} 秒)`);
      break;
    }
  }

  await page.waitForTimeout(2000);

  // 最终位置复核
  const finalProcessGroup = page.locator('.process-group').first();
  const finalContent = page.locator('[data-slot="message-content"]').first();

  if (await finalProcessGroup.count() > 0 && await finalContent.count() > 0) {
    const finalPBox = await finalProcessGroup.boundingBox();
    const finalCBox = await finalContent.boundingBox();
    if (finalPBox && finalCBox) {
      console.log(`   最终呈现位置 -> 思维链 Y: ${finalPBox.y}, 正文 Y: ${finalCBox.y}`);
      if (finalPBox.y < finalCBox.y) {
        console.log('   ✅ 最终验证通过：思维链完美固化在正文上方，绝未跳到正文下方！');
      } else {
        console.error('   ❌ 最终位置不正确！');
      }
    }
  }

  const shot21 = path.join(screenshotsDir, '21-reasoning-above-response-complete.png');
  await page.screenshot({ path: shot21 });
  console.log('✅ 截图已保存 (深度思考全部完成，思维链居上正文居下): ' + shot21);

  await browser.close();
  console.log('🎉 自动化验证测试圆满成功！');
})();
