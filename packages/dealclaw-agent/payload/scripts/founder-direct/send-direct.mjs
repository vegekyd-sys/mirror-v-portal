#!/usr/bin/env node
// scripts/founder-direct/send-direct.mjs
// 发送邮件：Resend 代理邮箱走 Resend API，普通邮箱走 SMTP
// Usage:
//   node scripts/founder-direct/send-direct.mjs --from tian@company.com --to buyer@example.com --subject 'quick question' --html '<p>Hi</p>'
//   node scripts/founder-direct/send-direct.mjs --from tian@company.com --to buyer@example.com --subject '...' --html-file draft.html

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RECEIPT_SCRIPT = resolve(__dirname, '..', '..', 'work', 'mio-api', 'dc_send_receipt.py');

// ── Email registry (authoritative protocol source) ───────────
const REGISTRY_FILE = resolve(__dirname, 'email-registry.json');

function loadRegistry() {
  if (!existsSync(REGISTRY_FILE)) return {};
  try { return JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')); } catch { return {}; }
}

// ── Resend proxy domains (fallback only, registry wins) ──────
const RESEND_PROXY_DOMAIN_SUFFIX = '.dealclaw.io';
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_4BU…Myx1';
const RESEND_API_URL = 'https://api.resend.com/emails';

function isResendProxy(email) {
  // 1. Registry first (authoritative)
  const registry = loadRegistry();
  const record = registry[email];
  if (record && record.protocol === 'resend') return true;
  if (record && record.protocol === 'smtp') return false;
  // 2. Fallback: any subdomain under dealclaw.io is treated as Resend proxy
  const domain = email.split('@')[1]?.toLowerCase();
  return Boolean(domain && domain.endsWith(RESEND_PROXY_DOMAIN_SUFFIX));
}

async function sendViaResend(from, to, subject, text, html, cc, bcc) {
  // Uses Resend HTTP API — no SMTP auth needed for proxy emails
  const payload = { from, to, subject };
  if (text) payload.text = text;
  if (html) payload.html = html;
  if (cc?.length) payload.cc = cc;
  if (bcc?.length) payload.bcc = bcc;

  const resp = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (resp.status !== 200) {
    throw new Error(`Resend API error ${resp.status}: ${JSON.stringify(data)}`);
  }
  return {
    resendId: data.id,
    via: 'resend',
    accepted: to,
    rejected: [],
    sent_at: new Date().toISOString(),
  };
}

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
const receiptTarget = parseArg('--receipt-target');

// 批次回执：一次发送动作推一条汇总，不逐封。失败静默，绝不阻断发送结果。
function pushReceipt(target, text) {
  if (!target || !text) return;
  try {
    spawnSync('python3', [RECEIPT_SCRIPT, '--target', target, '--text', text], { stdio: 'ignore', timeout: 30000 });
  } catch (_) { /* ignore */ }
}

if (!from || !toRaw || !subject) {
  console.error('Usage: node send-direct.mjs --from tian@company.com --to buyer@x.com --subject <s> [--html <h>] [--html-file <f>] [--text <t>] [--cc <c>] [--bcc <b>] [--dry-run]');
  process.exit(2);
}

if (htmlFile) {
  if (!existsSync(htmlFile)) { console.error(`File not found: ${htmlFile}`); process.exit(1); }
  html = readFileSync(htmlFile, 'utf8');
}

// ── Load account config (skip for Resend proxy) ────────────────
const useResend = isResendProxy(from);
let account = null;
if (!useResend) {
  const accountFile = resolve(ACCOUNTS_DIR, `${from.replace(/[@.]/g, '_')}.json`);
  if (!existsSync(accountFile)) {
    console.error(`❌ ${from} not bound. Run bind-email.mjs first.`);
    process.exit(2);
  }
  account = JSON.parse(readFileSync(accountFile, 'utf8'));
}

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
  const to = toRaw.split(',').map(s => s.trim());
  const cc = ccRaw ? ccRaw.split(',').map(s => s.trim()) : undefined;
  const bcc = bccRaw ? bccRaw.split(',').map(s => s.trim()) : undefined;

  // ── Route: Resend proxy vs SMTP ──────────────────────────
  if (isResendProxy(from)) {
    // Resend proxy email — use Resend HTTP API, no SMTP needed
    if (dryRun) {
      console.log('DRY RUN (Resend) — would send:');
      console.log(JSON.stringify({ from, to, subject, cc, bcc, via: 'resend', text_preview: text?.substring(0, 200) }, null, 2));
      return;
    }
    const result = await sendViaResend(from, to, subject, text, html, cc, bcc);
    console.log(JSON.stringify(result, null, 2));
    if (!existsSync(SENT_LOG)) writeFileSync(SENT_LOG, '');
    writeFileSync(SENT_LOG, JSON.stringify({ ...result, from, to, subject }) + '\n', { flag: 'a' });
    pushReceipt(receiptTarget, `✅ 邮件已发出：本轮 ${to.length} 封`);
    return;
  }

  // ── SMTP path (non-Resend emails) ─────────────────────────
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

  if (dryRun) {
    console.log('DRY RUN — would send:');
    console.log(JSON.stringify({ from, to, subject, cc, bcc, html_preview: html?.substring(0, 200) }, null, 2));
    return;
  }

  const { default: nodemailer } = await import('nodemailer');
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
  const logRecord = {
    ...result,
    company_id: parseArg('--company-id') || '',
    text: mailOpts.text || '',
    html: mailOpts.html || '',
  };
  writeFileSync(SENT_LOG, JSON.stringify(logRecord) + '\n', { flag: 'a' });
  pushReceipt(receiptTarget, `✅ 邮件已发出：本轮 ${to.length} 封`);
}

main().catch(err => {
  console.error('❌', err.message);
  pushReceipt(receiptTarget, `❌ 邮件发送失败：${err.message}`);
  process.exit(1);
});
