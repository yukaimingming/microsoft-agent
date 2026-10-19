const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

(async () => {
  console.log('🚀 开始验证：AI SDK Elements 规范代码块组件在黑白双主题下的效果...');

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();

  // 监听浏览器控制台与错误
  page.on('console', msg => {
    if (msg.type() === 'error') console.log('PAGE LOG ERROR:', msg.text());
  });
  page.on('pageerror', err => console.log('PAGE JS ERROR:', err.message));

  // 1. 打开首页
  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Markdown 内容：包含 Python、TypeScript 围栏代码块和行内代码
  const testMarkdown = `这是一段测试回答，全面对齐 **[AI SDK Elements CodeBlock](https://elements.ai-sdk.dev/components/code-block)** 规范。

包含行内代码如 \`const runtime = "edge";\` 的胶囊标签，以及以下多语言代码块：

\`\`\`python
import asyncio
import aiohttp

async def fetch_status(url: str) -> dict:
    """异步获取网页状态码"""
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            return {"url": url, "status": response.status}

if __name__ == "__main__":
    result = asyncio.run(fetch_status("https://elements.ai-sdk.dev"))
    print(f"Status check result: {result}")
\`\`\`

下面是 TypeScript 接口与组件实现代码块：
\`\`\`typescript
export interface CodeBlockProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
}

export function CodeBlockCard({ code, language }: CodeBlockProps) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 shadow-xs">
      <div className="flex items-center justify-between border-b pb-2 text-xs font-mono">
        <span>{language}</span>
      </div>
      <pre className="mt-2 text-sm"><code>{code}</code></pre>
    </div>
  );
}
\`\`\`
`;

  // 2. 注入完整合法的 ClientState
  const activeId = await page.evaluate(async (mdContent) => {
    let activeSessionId = 'test-codeblock-session';
    try {
      const resp = await fetch('/api/workbench');
      if (resp.ok) {
        const data = await resp.json();
        if (data.workbench?.activeSessionId) {
          activeSessionId = data.workbench.activeSessionId;
        }
      }
    } catch (e) {}

    const testState = {
      threadId: activeSessionId,
      messages: [
        {
          id: 'msg-user-1',
          role: 'user',
          content: '请写一个 Python 异步抓取脚本与 TypeScript 规范组件示例。',
          streaming: false,
          createdAt: Date.now() - 5000
        },
        {
          id: 'msg-assistant-1',
          role: 'assistant',
          content: mdContent,
          streaming: false,
          createdAt: Date.now()
        }
      ],
      activities: [],
      run: {
        status: 'idle',
        runId: null,
        threadId: activeSessionId,
        progressNote: null,
        interrupts: [],
        error: null
      },
      pendingDecisions: {}
    };

    // 写入后端
    await fetch(`/api/workbench/sessions/${encodeURIComponent(activeSessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testState)
    });

    // 写入本地 localStorage
    localStorage.setItem(`maf_session_state_${activeSessionId}`, JSON.stringify(testState));

    // 默认确保是深色模式
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');

    return activeSessionId;
  }, testMarkdown);

  console.log(`📝 已向会话 [${activeId}] 注入规范的 ClientState 测试数据，正在重新加载页面...`);

  // 3. 重新加载页面让组件挂载并渲染
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // 确保 screenshots 目录存在
  const screenshotsDir = path.resolve('screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  // 检查代码块是否渲染
  const codeBlockWrapper = page.locator('[data-streamdown="code-block-wrapper"]');
  const count = await codeBlockWrapper.count();
  console.log(`✅ 检测到已渲染的代码块数量: ${count}`);

  if (count > 0) {
    // 4. 深色模式截图
    console.log('📸 截取深色模式代码块效果...');
    await page.screenshot({ path: 'screenshots/code_block_dark.png' });

    // 点击复制按钮测试反馈
    const firstCopyBtn = codeBlockWrapper.first().locator('button');
    if (await firstCopyBtn.count() > 0) {
      console.log('🖱️ 点击第一个代码块的复制按钮...');
      await firstCopyBtn.click();
      await page.waitForTimeout(400);
      await codeBlockWrapper.first().screenshot({ path: 'screenshots/code_block_copy_feedback_dark.png' });
      console.log('📸 已保存深色模式下复制成功的对勾反馈截图');
    }

    // 5. 切换为浅色模式
    console.log('🔄 切换为浅色模式 (Light Theme)...');
    await page.evaluate(() => {
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      localStorage.setItem('theme', 'light');
    });
    await page.waitForTimeout(1000);

    console.log('📸 截取浅色模式代码块效果...');
    await page.screenshot({ path: 'screenshots/code_block_light.png' });
    await codeBlockWrapper.first().screenshot({ path: 'screenshots/code_block_card_light.png' });
    console.log('📸 已保存浅色模式下的代码块卡片局部截图');

    // 复制截图到 artifacts 目录
    const artifactDir = 'C:\\Users\\kaiming yu\\.gemini\\antigravity\\brain\\6a90b100-ca33-4c2b-a685-410581b5f503';
    if (fs.existsSync(artifactDir)) {
      ['code_block_dark.png', 'code_block_light.png', 'code_block_copy_feedback_dark.png', 'code_block_card_light.png'].forEach(file => {
        const src = path.join(screenshotsDir, file);
        const dest = path.join(artifactDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          console.log(`📁 已复制到 Artifact: ${dest}`);
        }
      });
    }
    console.log('🎉 双主题代码块验证与截图全部完成！');
  } else {
    console.error('❌ 未能找到代码块元素，截图当前页面进行排查...');
    await page.screenshot({ path: 'screenshots/code_block_debug.png' });
  }

  await browser.close();
})();
