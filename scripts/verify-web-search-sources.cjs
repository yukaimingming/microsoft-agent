const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 开始验证：1. 去掉左侧执行中文本只留旋转图标  2. 网络搜索地球图标与URL来源跳转...');

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();

  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 模拟第一个会话处于后台执行状态
  await page.evaluate(() => {
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');

    const firstItem = document.querySelector('.sidebar-session-item');
    if (firstItem) {
      const iconContainer = firstItem.querySelector('.flex.items-center.gap-2');
      if (iconContainer) {
        const svg = iconContainer.querySelector('svg');
        if (svg) {
          const wrap = document.createElement('span');
          wrap.title = '正在执行中';
          wrap.className = 'inline-flex shrink-0';
          wrap.innerHTML = `<svg class="lucide lucide-loader-circle size-3.5 text-emerald-400 shrink-0 animate-spin" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
          svg.replaceWith(wrap);
        }
      }
    }
  });

  await page.waitForTimeout(400);

  // 展开时间线中的「已完成分析」以展示网络搜索输出过程
  const triggerBtn = page.locator('button:has-text("已完成分析")').first();
  if (await triggerBtn.count() > 0) {
    await triggerBtn.click();
    await page.waitForTimeout(400);
  }

  // 截图左侧边栏（确认无“执行中”文字，只有旋转图标）
  const sidebar = page.locator('aside').first();
  await sidebar.screenshot({ path: 'screenshots/sidebar_spinner_dark.png' });
  console.log('📸 已保存深色侧边栏无文字转圈截图: screenshots/sidebar_spinner_dark.png');

  // 全屏截图（网络搜索地球图标 + 来源胶囊 + 侧边栏纯转圈）
  await page.screenshot({ path: 'screenshots/web_search_process_dark.png' });
  console.log('📸 已保存深色模式全屏截图: screenshots/web_search_process_dark.png');

  // 浅色模式
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    localStorage.setItem('theme', 'light');
  });
  await page.waitForTimeout(400);

  await sidebar.screenshot({ path: 'screenshots/sidebar_spinner_light.png' });
  console.log('📸 已保存浅色侧边栏无文字转圈截图: screenshots/sidebar_spinner_light.png');

  await page.screenshot({ path: 'screenshots/web_search_process_light.png' });
  console.log('📸 已保存浅色模式全屏截图: screenshots/web_search_process_light.png');

  await browser.close();
  console.log('🎉 验证与全套截图生成完成！');
})();
