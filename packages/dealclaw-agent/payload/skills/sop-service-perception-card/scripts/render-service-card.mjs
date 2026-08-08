import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [,, templatePath, dataPath, outPath] = process.argv;
if (!templatePath || !dataPath || !outPath) {
  console.error('Usage: node render-service-card.mjs <template.html> <data.json> <out.png>');
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
let html = fs.readFileSync(templatePath, 'utf8');
for (const [key, value] of Object.entries(data)) {
  html = html.replaceAll(`{{${key}}}`, String(value ?? ''));
}
const tmp = path.join(path.dirname(outPath), `${path.basename(outPath, path.extname(outPath))}.render.html`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(tmp, html);
const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-gpu']
});
const page = await browser.newPage({ viewport: { width: 804, height: 1748 }, deviceScaleFactor: 1 });
await page.goto(`file://${path.resolve(tmp)}`, { waitUntil: 'networkidle' });
await page.screenshot({ path: outPath });
await browser.close();
console.log(outPath);
