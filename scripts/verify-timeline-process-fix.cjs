const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 开始验证：多步文件操作与 Diff 替换时，思考与过程说明稳定收拢在详细展示区内部，彻底解决跑到外部正文又跳回的 Bug...');

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('PAGE LOG ERROR:', msg.text());
  });
  page.on('pageerror', err => console.log('PAGE JS ERROR:', err.message));

  // 1. 打开首页
  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 模拟用户提出的真实 prompt 及多步工具过程数据
  const userPrompt = '在工作区创建一个名为 demo-notes.txt 的文件，写入几行项目介绍；再用 file_access_replace 修改其中内容并展示行级 Diff 对比';

  const testState = await page.evaluate(async (promptText) => {
    let activeSessionId = 'test-demo-notes-session';
    try {
      const resp = await fetch('/api/workbench');
      if (resp.ok) {
        const data = await resp.json();
        if (data.workbench?.activeSessionId) {
          activeSessionId = data.workbench.activeSessionId;
        }
      }
    } catch (e) {}

    const now = Date.now();
    const state = {
      threadId: activeSessionId,
      messages: [
        {
          id: 'msg-user-diff-task',
          role: 'user',
          content: promptText,
          streaming: false,
          createdAt: now - 15000,
        },
        // 过程 1：思考过程 + 工具前引导说明
        {
          id: 'msg-asst-step-1',
          role: 'assistant',
          reasoning: '用户要求在工作区创建 demo-notes.txt 并写入项目介绍，随后用 file_access_replace 替换部分内容并展示行级 Diff。首先我将使用文件工具创建 demo-notes.txt 并写入基础内容。',
          reasoningStreaming: false,
          reasoningDuration: 4,
          content: '好的，我将在工作区为您创建 demo-notes.txt 并写入项目介绍。',
          streaming: false,
          isProcess: true,
          createdAt: now - 12000,
          contentStartedAt: now - 11000,
        },
        // 过程 2：第二步替换说明
        {
          id: 'msg-asst-step-2',
          role: 'assistant',
          content: '已成功创建 demo-notes.txt 文件。现在使用 file_access_replace 修改其中内容，展示行级 Diff 对比。',
          streaming: false,
          isProcess: true,
          createdAt: now - 8000,
          contentStartedAt: now - 7500,
        },
        // 最终回答：独立在正文区，不与过程混杂
        {
          id: 'msg-asst-final',
          role: 'assistant',
          content: '已成功为您在工作区创建了 `demo-notes.txt` 文件，并使用 `file_access_replace` 工具完成了项目介绍内容的精准替换，上方时间线已展示清晰的行级 Diff 对比。',
          streaming: false,
          createdAt: now - 3000,
          contentStartedAt: now - 2800,
        }
      ],
      activities: [
        // 工具 1：创建文件
        {
          id: 'tool:call_create_file_1',
          kind: 'tool',
          status: 'completed',
          title: '创建文件 · demo-notes.txt',
          startedAt: now - 10000,
          finishedAt: now - 9000,
          subtitle: '写入 4 行项目介绍',
          detail: {
            toolName: 'file_access_create',
            arguments: { path: 'demo-notes.txt', content: '# 项目介绍\nDeepAgent 是基于 AI SDK Elements 构建的次世代智能体工作台。\n支持多智能体协作与行级 Diff 对比。\n版本：v1.0.0' },
            output: '文件 demo-notes.txt 创建成功，写入 138 字节。'
          }
        },
        // 工具 2：替换内容并输出行级 Diff
        {
          id: 'tool:call_replace_diff_2',
          kind: 'tool',
          status: 'completed',
          title: '修改文件 · demo-notes.txt',
          startedAt: now - 7000,
          finishedAt: now - 5000,
          subtitle: '行级 Diff 对比已生成',
          detail: {
            toolName: 'file_access_replace',
            arguments: {
              path: 'demo-notes.txt',
              find: '版本：v1.0.0',
              replace: '版本：v1.0.1 (对齐 AI SDK Elements 官网规范)'
            },
            diff: {
              path: 'demo-notes.txt',
              originalContent: '# 项目介绍\nDeepAgent 是基于 AI SDK Elements 构建的次世代智能体工作台。\n支持多智能体协作与行级 Diff 对比。\n版本：v1.0.0',
              newContent: '# 项目介绍\nDeepAgent 是基于 AI SDK Elements 构建的次世代智能体工作台。\n支持多智能体协作与行级 Diff 对比。\n版本：v1.0.1 (对齐 AI SDK Elements 官网规范)',
              addedLines: 1,
              removedLines: 1
            },
            output: '成功替换 demo-notes.txt 中的 1 处内容。'
          }
        }
      ],
      run: {
        status: 'completed',
        runId: 'run-diff-task-1',
        threadId: activeSessionId,
        progressNote: '已完成分析与文件修改',
        interrupts: [],
        error: null,
      },
      pendingDecisions: {},
    };

    // 同步到后端与本地
    await fetch(`/api/workbench/sessions/${encodeURIComponent(activeSessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    localStorage.setItem(`maf_session_state_${activeSessionId}`, JSON.stringify(state));

    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');

    return activeSessionId;
  }, userPrompt);

  console.log(`📝 已注入文件创建与行级 Diff 任务测试数据，重新加载页面...`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 展开「已完成分析」折叠卡片，展示内部的思考内容与过程
  const analysisBtn = page.locator('button:has-text("已完成分析")').first();
  if (await analysisBtn.count() > 0) {
    console.log('🖱️ 展开详细展示区中的「已完成分析」卡片...');
    await analysisBtn.click();
    await page.waitForTimeout(500);
  }

  const screenshotsDir = path.resolve('screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  // 截图验证：深色模式下过程稳定收拢在详细展示区内部，且外部只有最终正文
  console.log('📸 截取深色模式修复后效果图...');
  await page.screenshot({ path: 'screenshots/demo_notes_process_fix_dark.png' });

  // 切换浅色模式并截图
  console.log('🔄 切换为浅色模式...');
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    localStorage.setItem('theme', 'light');
  });
  await page.waitForTimeout(800);

  console.log('📸 截取浅色模式修复后效果图...');
  await page.screenshot({ path: 'screenshots/demo_notes_process_fix_light.png' });

  // 复制到 artifact 目录
  const artifactDir = 'C:\\Users\\kaiming yu\\.gemini\\antigravity\\brain\\6a90b100-ca33-4c2b-a685-410581b5f503';
  if (fs.existsSync(artifactDir)) {
    ['demo_notes_process_fix_dark.png', 'demo_notes_process_fix_light.png'].forEach(file => {
      const src = path.join(screenshotsDir, file);
      const dest = path.join(artifactDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`📁 已复制到 Artifact: ${dest}`);
      }
    });
  }

  console.log('🎉 验证全部完成！');
  await browser.close();
})();
