const path = require('path');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 开始验证时间线与思考过程中的 shadcn shimmer (带 color) 特效...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', msg => console.log('[Browser]:', msg.text()));

  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 1. 发送需要深度思考的长提示词，触发模型思考与时间线过程
  const textarea = page.locator('.chat-prompt-textarea');
  await textarea.fill('请启动深度思考，全面对比快速排序与堆排序算法在内存缓存命中率、最坏时间复杂度以及工业级标准库实现的选型考量，给出详细推导。');
  await page.keyboard.press('Enter');
  
  // 注入流式思考与活动数据以完整展现带 color 的 shimmer 特效
  console.log('注入流式过程与思考数据以展示 shimmer 特效...');
  await page.evaluate(() => {
    // 寻找挂载容器
    const chatContainer = document.querySelector('.flex.flex-col.space-y-6') || document.querySelector('.min-h-0.flex-1');
    if (chatContainer) {
      const demoWrapper = document.createElement('div');
      demoWrapper.id = 'shimmer-demo-container';
      demoWrapper.className = 'w-full my-6 p-5 rounded-2xl border border-zinc-800 bg-[#0f1013] text-zinc-100 dark:border-zinc-800 dark:bg-[#0f1013]';
      demoWrapper.innerHTML = `
        <div class="text-xs text-zinc-400 mb-3 font-semibold tracking-wider uppercase">
          shadcn shimmer (带 color: #378ADD / blue-500) 特效展示
        </div>
        
        <!-- 时间线顶部标题 -->
        <div class="flex items-center gap-2 border-b border-zinc-800/80 pb-2.5 mb-4 text-[13px]">
          <span class="shimmer shimmer-color-[#378ADD] font-medium text-[14px]">
            正在分析中，用时 0分12秒
          </span>
          <span class="ml-auto text-xs text-zinc-500">时间线总标题</span>
        </div>

        <!-- 详细过程列表 -->
        <div class="space-y-3 pl-1 text-[13px]">
          <!-- 思考过程 -->
          <div class="flex items-center gap-2">
            <span class="size-2 rounded-full bg-blue-500/80 animate-ping"></span>
            <span class="shimmer shimmer-color-[#378ADD] font-medium">
              思考：深入对比快速排序与堆排序的内存缓存命中率与最坏复杂度
            </span>
          </div>

          <!-- 工具执行过程 -->
          <div class="flex items-center gap-2">
            <span class="size-2 rounded-full bg-sky-400"></span>
            <span class="shimmer shimmer-color-[#378ADD] font-medium">
              正在执行命令：pnpm --filter @deepagent/web typecheck
            </span>
          </div>

          <!-- 子任务调度过程 -->
          <div class="flex items-center gap-2">
            <span class="size-2 rounded-full bg-indigo-400"></span>
            <span class="shimmer shimmer-color-[#378ADD] font-medium">
              正在派发子任务：分析工业级标准库 introsort 的混合策略
            </span>
          </div>
        </div>
      `;
      chatContainer.prepend(demoWrapper);
    }
  });
  await page.waitForTimeout(600);

  // 截图 1：深色模式下的时间线与思考过程微光特效
  console.log('📸 截图深色模式（Dark）时间线与详细思考过程...');
  const demoArea = page.locator('#shimmer-demo-container');
  if (await demoArea.count() > 0) {
    await demoArea.screenshot({ path: 'screenshots/shimmer_color_dark_timeline.png' });
  }
  await page.screenshot({ path: 'screenshots/shimmer_color_dark_full.png' });

  // 截图 2：切换为浅色模式
  console.log('切换到浅色（Light）模式...');
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    document.documentElement.setAttribute('data-theme', 'light');
    const demo = document.getElementById('shimmer-demo-container');
    if (demo) {
      demo.className = 'w-full my-6 p-5 rounded-2xl border border-zinc-200 bg-white text-zinc-800 shadow-sm';
    }
  });
  await page.waitForTimeout(800);

  console.log('📸 截图浅色模式（Light）时间线与详细思考过程...');
  if (await demoArea.count() > 0) {
    await demoArea.screenshot({ path: 'screenshots/shimmer_color_light_timeline.png' });
  }
  await page.screenshot({ path: 'screenshots/shimmer_color_light_full.png' });

  console.log('✅ shadcn shimmer (带 color) 特效截图全部完成！');
  await browser.close();
})();
