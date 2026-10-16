const path = require('path');
module.paths.push(path.join(__dirname, '../frontend/node_modules'));
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1040 }, locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5175', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 点击历史会话中含有创建 demo-notes.txt 的会话
  const diffChat = page.locator('div:has-text("demo-notes"), div:has-text("在工作区创建")').last();
  if (await diffChat.count() > 0) {
    await diffChat.click();
    await page.waitForTimeout(2500);
  }

  // 截图 18: 默认折叠收起的 Diff 卡片
  await page.screenshot({ path: path.join(__dirname, '../screenshots/18-diff-card-default-collapsed.png') });
  console.log('Saved 18: diff card default collapsed');

  // 点击展开主卡片
  const trigger = page.locator('button:has-text("个文件变更")').first();
  if (await trigger.count() > 0) {
    await trigger.click();
    await page.waitForTimeout(1000);

    // 点击展开单文件
    const fileBtn = page.locator('button:has-text("demo-notes.txt")').first();
    if (await fileBtn.count() > 0) {
      await fileBtn.click();
      await page.waitForTimeout(1000);
    }
  }

  // 截图 19: 手动展开后的行级 Diff
  await page.screenshot({ path: path.join(__dirname, '../screenshots/19-diff-card-manually-expanded.png') });
  console.log('Saved 19: diff card manually expanded');

  await browser.close();
})();
