#!/usr/bin/env node
// scripts/founder-direct/send-direct.mjs
// 通过已绑定的企业邮箱 SMTP 发送邮件（走 Sent folder）
// Usage:
//   node scripts/founder-direct/send-direct.mjs --from tian@company.com --to buyer@example.com --subject 'quick question' --html '<p>Hi</p>'
//   node scripts/founder-direct/send-direct.mjs --from tian@company.com --to buyer@example.com --subject '...' --html-file draft.html

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import nodemailer from 'nodemailer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_DIR = resolve(__dirname, 'accounts');
const SENT_LOG = resolve(__dirname, 'sent-log.jsonl');

const args = process.argv.slice(2);
const parseArg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const hasArg = (f) => args.includes(f);

const from = parseArg('--from');
const toRaw = parseArg('--to');
const subject = parseArg('--subject');
let html = parseArg('--html');
let text = parseArg('--text');
const htmlFile = parseArg('--html-file');
const ccRaw = parseArg('--cc');
const bccRaw = parseArg('--bcc');
const dryRun = hasArg('--dry-run');

if (!from || !toRaw || !subject) {
  console.error('Usage: node send-direct.mjs --from tian@company.com --to buyer@x.com --subject <s> [--html <h>] [--html-file <f>] [--text <t>] [--cc <c>] [--bcc <b>] [--dry-run]');
  process.exit(2);
}

if (htmlFile) {
  if (!existsSync(htmlFile)) { console.error(`File not found: ${htmlFile}`); process.exit(1); }
  html = readFileSync(htmlFile, 'utf8');
}

// ── Load account config ────────────────────────────────────────
const accountFile = resolve(ACCOUNTS_DIR, `${from.replace(/[@.]/g, '_')}.json`);
if (!existsSync(accountFile)) {
  console.error(`❌ ${from} not bound. Run bind-email.mjs first.`);
  process.exit(2);
}
const account = JSON.parse(readFileSync(accountFile, 'utf8'));

// ── Prompt for password ────────────────────────────────────────
async function promptPassword() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`Email password for ${from}: `, (pw) => { rl.close(); resolve(pw.trim()); });
  });
}

// ── Daily counter ──────────────────────────────────────────────
const DAILY_LIMIT = 15;

function countTodaySent() {
  if (!existsSync(SENT_LOG)) return 0;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lines = readFileSync(SENT_LOG, 'utf8').trim().split('\n').filter(Boolean);
  return lines.filter(line => {
    try {
      const entry = JSON.parse(line);
      return entry.sent_at && entry.sent_at.startsWith(today);
    } catch { return false; }
  }).length;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  // Check daily limit (skip for dry runs)
  if (!dryRun) {
    const todaySent = countTodaySent();
    if (todaySent >= DAILY_LIMIT) {
      console.log(JSON.stringify({
        blocked: true,
        reason: `Daily limit reached: ${todaySent}/${DAILY_LIMIT} already sent today`,
        today_sent: todaySent,
        daily_limit: DAILY_LIMIT,
        retry_after: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
      }));
      process.exit(0);
    }
  }

  const pw = parseArg('--password') || await promptPassword();

  const to = toRaw.split(',').map(s => s.trim());
  const cc = ccRaw ? ccRaw.split(',').map(s => s.trim()) : undefined;
  const bcc = bccRaw ? bccRaw.split(',').map(s => s.trim()) : undefined;

  if (dryRun) {
    console.log('DRY RUN — would send:');
    console.log(JSON.stringify({ from, to, subject, cc, bcc, html_preview: html?.substring(0, 200) }, null, 2));
    return;
  }

  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: from, pass: pw },
  });

  // Founder Direct: prefer text-only. HTML only when explicitly requested.
// Gmail trusts plain text from real senders; HTML triggers bulk-sender heuristics.
const mailOpts = { from, to, cc, bcc, subject };
if (html && !hasArg('--text-only')) {
  mailOpts.html = html;
  if (text) mailOpts.text = text;
} else {
  // Text-only mode: strip HTML or use explicit text
  mailOpts.text = text || (html ? html.replace(/<[^>]*>/g, '').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim() : '');
}

const info = await transport.sendMail(mailOpts);
  transport.close();

  const result = {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
    sent_at: new Date().toISOString(),
    from, to, subject,
  };

  console.log(JSON.stringify(result, null, 2));

  // Log to sent-log.jsonl
  if (!existsSync(SENT_LOG)) writeFileSync(SENT_LOG, '');
  writeFileSync(SENT_LOG, JSON.stringify(result) + '\n', { flag: 'a' });
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
