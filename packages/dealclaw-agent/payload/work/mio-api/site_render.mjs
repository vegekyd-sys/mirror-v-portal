#!/usr/bin/env node
// site_render.mjs — 用 puppeteer 渲染 JS 站点并把渲染后的 HTML 打到 stdout。
// 用法: node site_render.mjs <url> [waitMs]
import puppeteer from 'puppeteer';

const url = process.argv[2];
const waitMs = parseInt(process.argv[3] || '2500', 10);
if (!url) {
  console.error('usage: node site_render.mjs <url> [waitMs]');
  process.exit(2);
}

const launcher = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
};
if (process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH) {
  launcher.executablePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
} else {
  launcher.executablePath = '/usr/bin/google-chrome';
}

const browser = await puppeteer.launch(launcher);
try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (compatible; DealClawAssetBot/1.0)');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise((r) => setTimeout(r, waitMs));
  // 滚动触发懒加载
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 800) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  const html = await page.content();
  process.stdout.write(html);
} catch (e) {
  console.error('render failed: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
} finally {
  await browser.close();
}
