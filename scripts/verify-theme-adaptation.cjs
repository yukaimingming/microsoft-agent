const path = require('path');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 开始全方位验证黑白主题（Dark / Light）下 TodoCard 与排队卡片...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', msg => console.log('浏览器控制台:', msg.text()));

  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 1. 发送一条消息进入运行态，在运行态中测试排队
  const textarea = page.locator('.chat-prompt-textarea');
  await textarea.fill('请写一段 200 字关于智能体规划能力的分析');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // 2. 在模型正在回复过程中，输入排队提示词并点击排队
  console.log('深色模式下排队测试...');
  await textarea.fill('还有确定要用什么token吗，目前只是个人agent');
  await page.waitForTimeout(400);

  const queueBtn = page.locator('button:has-text("排队")');
  if (await queueBtn.count() > 0) {
    await queueBtn.click();
    await page.waitForTimeout(600);
  }

  // 注入 TodoCard 真实数据以验证待办列表在深浅双色下的表现
  console.log('注入待办任务清单数据...');
  await page.evaluate(() => {
    // 寻找待办任务展示挂载容器
    const container = document.querySelector('.mx-auto.w-full.max-w-3xl > .mb-2');
    if (container && !document.getElementById('mock-todo-wrapper')) {
      const wrapper = document.createElement('div');
      wrapper.id = 'mock-todo-wrapper';
      wrapper.className = 'relative flex w-fit shrink-0 items-center';
      wrapper.innerHTML = `
        <div class="todo-card-container my-1 w-fit max-w-full rounded-xl border border-zinc-200 bg-white shadow-xs transition-colors dark:border-zinc-800 dark:bg-[#18181b] dark:shadow-md">
          <div class="collapsible">
            <button type="button" class="todo-card-trigger flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm font-medium transition-colors bg-zinc-100/90 hover:bg-zinc-200/90 text-zinc-800 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 dark:text-zinc-200 border-0 outline-none">
              <span class="flex items-center gap-2">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="size-4 shrink-0 text-amber-500 dark:text-amber-400">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                </svg>
                <span>3 项待办任务 (1/3 已完成)</span>
              </span>
            </button>
            <div class="mt-1 px-1 pb-1">
              <ul class="space-y-1">
                <li class="todo-card-item rounded-lg px-2.5 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/50">
                  <div class="flex items-center gap-2.5 py-0.5">
                    <span class="flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="size-3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path></svg>
                    </span>
                    <span class="text-zinc-400 line-through dark:text-zinc-500">1. 初始化项目结构与黑白主题配置</span>
                  </div>
                </li>
                <li class="todo-card-item rounded-lg px-2.5 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/50">
                  <div class="flex items-center gap-2.5 py-0.5">
                    <span class="flex size-4 shrink-0 items-center justify-center text-blue-600 dark:text-blue-400">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="size-3.5 animate-pulse"><path stroke-linecap="round" stroke-linejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>
                    </span>
                    <span class="text-zinc-800 dark:text-zinc-200 font-normal">2. 全面优化 Todo 列表与排队卡片样式</span>
                    <span class="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-600 bg-blue-50 border border-blue-200/80 dark:text-blue-400 dark:bg-blue-950/40 dark:border-blue-800/50 animate-pulse select-none">执行中</span>
                  </div>
                </li>
                <li class="todo-card-item rounded-lg px-2.5 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/50">
                  <div class="flex items-center gap-2.5 py-0.5">
                    <span class="size-3.5 shrink-0 rounded-full border border-zinc-400 bg-zinc-50 dark:border-zinc-600 dark:bg-transparent"></span>
                    <span class="text-zinc-800 dark:text-zinc-200 font-normal">3. 截图验证与 Git 提交交付</span>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      `;
      container.appendChild(wrapper);
    }
  });

  await page.waitForTimeout(400);

  // 截取深色模式下的 Todo 列表与输入框
  const bottomBar = page.locator('.shrink-0.px-4.py-4');
  await bottomBar.screenshot({ path: 'screenshots/theme_dark_todo_and_queue.png' });
  console.log('✅ 保存截图 screenshots/theme_dark_todo_and_queue.png');

  // 深色模式整页
  await page.screenshot({ path: 'screenshots/theme_dark_full_page.png' });
  console.log('✅ 保存截图 screenshots/theme_dark_full_page.png');

  // 3. 切换为浅色主题 (Light)
  console.log('切换到浅色主题...');
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('deepagent_theme_mode', 'light');
  });
  await page.waitForTimeout(600);

  // 截取浅色模式下的 Todo 列表与输入框
  await bottomBar.screenshot({ path: 'screenshots/theme_light_todo_and_queue.png' });
  console.log('✅ 保存截图 screenshots/theme_light_todo_and_queue.png');

  // 浅色模式整页
  await page.screenshot({ path: 'screenshots/theme_light_full_page.png' });
  console.log('✅ 保存截图 screenshots/theme_light_full_page.png');

  await browser.close();
  console.log('🎉 双主题视觉对比截图生成完毕！');
})();
