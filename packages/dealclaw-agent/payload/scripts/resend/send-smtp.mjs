#!/usr/bin/env node
// scripts/resend/send-smtp.mjs — SMTP直连发送（网易163邮箱）
// Usage: node scripts/resend/send-smtp.mjs --to buyer@x.com --subject "..." --html "<p>...</p>"

import { createTransport } from 'nodemailer';

const args = process.argv.slice(2);
const parseArg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const toRaw = parseArg('--to');
const subject = parseArg('--subject');
let html = parseArg('--html');
const dryRun = args.includes('--dry-run');

if (!toRaw || !subject || !html) {
  console.error('Usage: node scripts/resend/send-smtp.mjs --to <email> --subject <subject> --html <html> [--dry-run]');
  process.exit(2);
}

const to = toRaw.split(',').map(s => s.trim());

// SMTP config — 从环境变量读取
const smtpConfig = {
  host: 'smtp.163.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'aarkissu@163.com',
    pass: process.env.SMTP_PASS || '',
  },
};

if (dryRun) {
  console.log('DRY RUN — would send via SMTP:');
  console.log(`  From: ${smtpConfig.auth.user}`);
  console.log(`  To: ${to.join(', ')}`);
  console.log(`  Subject: ${subject}`);
  console.log(`  HTML: ${html.substring(0, 100)}...`);
  process.exit(0);
}

const transporter = createTransport(smtpConfig);

const fromName = parseArg('--from-name') || 'Aarkissu';

for (const recipient of to) {
  try {
    const info = await transporter.sendMail({
      from: `"${fromName}" <${smtpConfig.auth.user}>`,
      to: recipient,
      subject,
      html,
    });
    console.log(`${recipient}: ${info.messageId}`);
  } catch (err) {
    console.error(`${recipient}: ERROR — ${err.message}`);
  }
}

await transporter.close();
