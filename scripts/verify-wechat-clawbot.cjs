const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve('./frontend/node_modules/playwright'));

const ARTIFACT_DIR = 'C:/Users/yukai/.gemini/antigravity/brain/933540fb-5127-49e8-9942-aad79d234c7e';
const SCREENSHOTS_DIR = path.resolve('./screenshots');

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  console.log('🚀 启动浏览器验证个人微信 ClawBot (iLink 协议) 扫码与状态功能...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // 确保初始为深色模式
  await page.evaluate(() => {
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
  });
  await page.waitForTimeout(400);

  // 1. 验证左下角设置旁边的手机图标与连接状态，以及右上角状态指示器
  const phoneBtn = page.locator('[data-testid="open-wechat-clawbot-btn"]');
  await phoneBtn.waitFor({ state: 'visible', timeout: 10000 });
  const statusText = await page.locator('[data-testid="sidebar-clawbot-status-text"]').innerText();
  console.log('✅ 左下角设置旁边手机按钮已显示，状态文本:', statusText);

  const mainShotPath = path.join(ARTIFACT_DIR, 'wechat_clawbot_main_status.png');
  await page.screenshot({ path: mainShotPath });
  fs.copyFileSync(mainShotPath, path.join(SCREENSHOTS_DIR, 'wechat_clawbot_main_status.png'));

  // 2. 点击左下角设置旁边的手机图标，弹出微信 ClawBot 二维码弹窗
  await phoneBtn.click();
  const modal = page.locator('[data-testid="wechat-clawbot-modal"]');
  await modal.waitFor({ state: 'visible', timeout: 10000 });

  // 等待真实 iLink 微信二维码图片加载完成
  const qrImg = page.locator('[data-testid="wechat-qrcode-img"]');
  await qrImg.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="wechat-qrcode-img"]');
    return img && img.complete && img.naturalWidth > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(600);

  const qrDarkPath = path.join(ARTIFACT_DIR, 'wechat_clawbot_qrcode_dark.png');
  await page.screenshot({ path: qrDarkPath });
  fs.copyFileSync(qrDarkPath, path.join(SCREENSHOTS_DIR, 'wechat_clawbot_qrcode_dark.png'));
  console.log('✅ 深色模式微信二维码弹窗截图已生成:', qrDarkPath);

  // 3. 切换浅色模式验证弹窗与二维码显示
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
  });
  await page.waitForTimeout(500);

  const qrLightPath = path.join(ARTIFACT_DIR, 'wechat_clawbot_qrcode_light.png');
  await page.screenshot({ path: qrLightPath });
  fs.copyFileSync(qrLightPath, path.join(SCREENSHOTS_DIR, 'wechat_clawbot_qrcode_light.png'));
  console.log('✅ 浅色模式微信二维码弹窗截图已生成:', qrLightPath);

  await browser.close();
  console.log('🎉 全部截图验证成功！');
})();
