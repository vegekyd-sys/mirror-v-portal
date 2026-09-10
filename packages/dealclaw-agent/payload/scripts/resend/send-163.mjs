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

// Embed tracking pixel
const pixelUrl = `http://webhook.dealclaw.io/px/${trackId}`;
const trackedHtml = html + `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none" />`;

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
