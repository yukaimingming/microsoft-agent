const path = require('path');
module.paths.push(path.join(__dirname, '../frontend/node_modules'));
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1040 }, locale: 'zh-CN' });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5175', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 点击最新的会话
  const sessionItem = page.locator('div:has-text("在工作区创建")').last();
  if (await sessionItem.count() > 0) {
    await sessionItem.click();
    await page.waitForTimeout(2000);
  }

  // 1. 滚动到消息顶部截图：展示思维链在最上、Diff卡片默认折叠收起、正文紧随其下
  const scrollContainer = page.locator('[data-slot="conversation-content"]').first();
  if (await scrollContainer.count() > 0) {
    await scrollContainer.evaluate((el) => { el.scrollTop = 0; });
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(800);

  const shotTop = path.join(__dirname, '../screenshots/25-top-view-with-collapsed-diff.png');
  await page.screenshot({ path: shotTop });
  console.log('Saved 25: top view with collapsed diff');

  // 2. 页面中段/底部截图：展示完整的正文内容（包含Markdown表格、代码块）
  const shotBottom = path.join(__dirname, '../screenshots/26-bottom-view-with-full-markdown.png');
  await page.screenshot({ path: shotBottom });
  console.log('Saved 26: bottom view with full markdown');

  await browser.close();
})();
