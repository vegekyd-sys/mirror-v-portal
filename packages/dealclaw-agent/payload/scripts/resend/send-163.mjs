#!/usr/bin/env node
// scripts/resend/send-163.mjs — 163 SMTP发送 + 追踪像素
import { createTransport } from 'nodemailer';

const args = process.argv.slice(2);
const parseArg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const toRaw = parseArg('--to');
const subject = parseArg('--subject');
const html = parseArg('--html');
const trackId = parseArg('--track-id') || Date.now().toString(36);
const dryRun = args.includes('--dry-run');

if (!toRaw || !subject || !html) {
  console.error('Usage: node scripts/resend/send-163.mjs --to <email> --subject <s> --html <h> [--track-id <id>]');
  process.exit(2);
}

const to = toRaw.split(',').map(s => s.trim());

// 打开追踪像素：**默认不嵌**。
// 历史版本硬编码 http://webhook.dealclaw.io/px/<id>：该域名已下线（Cloudflare 1033），
// 而且现役 webhook 服务上并没有 /px 路由，等于每封信都带一张加载失败的死图，还不报错。
// 需要追踪时用 DC_TRACK_BASE_URL 显式开启（形如 dealclaw.datathink.com/webhook），
// 前提是服务端先提供 /px/:id 路由；宁可不带像素，也不发死链。
const trackBase = (process.env.DC_TRACK_BASE_URL || '')
  .trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const pixelUrl = trackBase ? `https://${trackBase}/px/${trackId}` : '';
const trackedHtml = pixelUrl
  ? html + `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none" />`
  : html;

if (dryRun) {
  console.log(`DRY RUN: to=${to.join(',')} subject="${subject}" track=${trackId}`);
  process.exit(0);
}

const transporter = createTransport({
  host: 'smtp.163.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'aarkissu@163.com',
    pass: process.env.SMTP_PASS || '',
  },
});

const results = [];
for (const recipient of to) {
  try {
    const info = await transporter.sendMail({
      from: '"Aarkissu / Emma" <aarkissu@163.com>',
      to: recipient,
      subject,
      html: trackedHtml,
    });
    results.push({ to: recipient, status: 'OK', msgId: info.messageId, trackId });
    console.log(`✅ ${recipient} | track=${trackId} | ${info.messageId}`);
  } catch (err) {
    results.push({ to: recipient, status: 'FAIL', reason: err.message });
    console.log(`❌ ${recipient} | ${err.message}`);
  }
}

await transporter.close();
