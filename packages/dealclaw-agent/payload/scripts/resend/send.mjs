#!/usr/bin/env node
// scripts/resend/send.mjs — 通过 Resend API 发送邮件
// Usage:
//   node scripts/resend/send.mjs --from 'V <v@example.com>' --to 'buyer@example.com' --subject 'test' --html '<p>hello</p>'
//   node scripts/resend/send.mjs --from 'V <v@example.com>' --to email1,email2 --subject 'test' --html '<p>hello</p>' --cc cc@x.com
//   node scripts/resend/send.mjs ... --unsubscribe-url 'https://example.com/unsub'   # 加退订 header + footer

import { readFileSync, existsSync } from 'node:fs';

const API_KEY = process.env.RESEND_API_KEY;
if (!API_KEY) {
  console.error('RESEND_API_KEY env var required');
  process.exit(1);
}

const args = process.argv.slice(2);
const parseArg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const from = parseArg('--from');
const toRaw = parseArg('--to');
const subject = parseArg('--subject');
let html = parseArg('--html');
let text = parseArg('--text');
const ccRaw = parseArg('--cc');
const bccRaw = parseArg('--bcc');
const htmlFile = parseArg('--html-file');
const unsubscribeUrl = parseArg('--unsubscribe-url') || 'https://send.mail.dogarm.top/unsub';
const replyTo = parseArg('--reply-to');
const dryRun = args.includes('--dry-run');

if (!from || !toRaw || !subject) {
  console.error('Usage: node scripts/resend/send.mjs --from <from> --to <to[,to2]> --subject <subject> [--html <html>] [--html-file <path>] [--text <text>] [--cc <cc>] [--bcc <bcc>] [--unsubscribe-url <url>] [--reply-to <email>] [--dry-run]');
  process.exit(2);
}

if (htmlFile) {
  if (!existsSync(htmlFile)) {
    console.error(`File not found: ${htmlFile}`);
    process.exit(1);
  }
  html = readFileSync(htmlFile, 'utf8');
}

const to = toRaw.split(',').map(s => s.trim());
const cc = ccRaw ? ccRaw.split(',').map(s => s.trim()) : undefined;
const bcc = bccRaw ? bccRaw.split(',').map(s => s.trim()) : undefined;

// ── Unsubscribe (默认开启，--unsubscribe-url 可覆盖) ────────────
const unsubFooterHtml = `<p style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">If you'd rather not receive emails like this, you can <a href="${unsubscribeUrl}" style="color:#888;">unsubscribe</a>.</p>`;
const unsubFooterText = `\n\n--\nIf you'd rather not receive emails like this, unsubscribe here: ${unsubscribeUrl}`;

if (html) html += unsubFooterHtml;
if (text) text += unsubFooterText;

// ── Build body ──────────────────────────────────────────────────
const body = {
  from, to, subject,
  track_opens: true,
  track_clicks: true,
};
if (html) body.html = html;
if (text) body.text = text;
if (cc) body.cc = cc;
if (bcc) body.bcc = bcc;
if (replyTo) body.reply_to = [replyTo];
body.headers = {
  'List-Unsubscribe': `<${unsubscribeUrl}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};

if (dryRun) {
  console.log('DRY RUN — would send:');
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    'Authorization': `${API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

const data = await res.json();

if (!res.ok) {
  console.error('Resend error:', data);
  process.exit(1);
}

console.log(JSON.stringify(data, null, 2));
