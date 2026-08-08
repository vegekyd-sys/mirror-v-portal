#!/usr/bin/env node
// scripts/founder-direct/bind-email.mjs
// 绑定企业邮箱 — 自动检测 IMAP/SMTP，测试连通，保存配置
// Usage:
//   node scripts/founder-direct/bind-email.mjs --email tian@company.com
//   然后交互输入密码；或者 --password 传参

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { resolveMx } from 'node:dns/promises';
import nodemailer from 'nodemailer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_DIR = resolve(__dirname, 'accounts');
if (!existsSync(ACCOUNTS_DIR)) mkdirSync(ACCOUNTS_DIR, { recursive: true });

const args = process.argv.slice(2);
const parseArg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const email = parseArg('--email');
let password = parseArg('--password');

if (!email) {
  console.error('Usage: node bind-email.mjs --email tian@company.com');
  process.exit(2);
}

// ── Known provider SMTP settings ──────────────────────────────
const KNOWN_SMTP = {
  'google.com':   { host: 'smtp.gmail.com',           port: 587, tls: true },
  'gmail.com':    { host: 'smtp.gmail.com',           port: 587, tls: true },
  'outlook.com':  { host: 'smtp-mail.outlook.com',    port: 587, tls: true },
  'hotmail.com':  { host: 'smtp-mail.outlook.com',    port: 587, tls: true },
  'live.com':     { host: 'smtp-mail.outlook.com',    port: 587, tls: true },
  'yahoo.com':    { host: 'smtp.mail.yahoo.com',      port: 587, tls: true },
  '163.com':      { host: 'smtp.163.com',             port: 465, tls: true },
  '126.com':      { host: 'smtp.126.com',             port: 465, tls: true },
  'qq.com':       { host: 'smtp.qq.com',              port: 587, tls: true },
  'aliyun.com':   { host: 'smtp.aliyun.com',          port: 465, tls: true },
  'zoho.com':     { host: 'smtp.zoho.com',            port: 587, tls: true },
  'zoho.eu':      { host: 'smtp.zoho.eu',             port: 587, tls: true },
  'icloud.com':   { host: 'smtp.mail.me.com',         port: 587, tls: true },
  'me.com':       { host: 'smtp.mail.me.com',         port: 587, tls: true },
  'proton.me':    { host: '127.0.0.1',                port: 1025, tls: false, note: 'Proton requires Bridge' },
  'protonmail.com':{host:'127.0.0.1',                 port: 1025, tls: false, note: 'Proton requires Bridge' },
};

// Known IMAP (for saving to Sent folder)
const KNOWN_IMAP = {
  'gmail.com':    { host: 'imap.gmail.com',           port: 993, tls: true },
  'google.com':   { host: 'imap.gmail.com',           port: 993, tls: true },
  'outlook.com':  { host: 'outlook.office365.com',    port: 993, tls: true },
  'hotmail.com':  { host: 'outlook.office365.com',    port: 993, tls: true },
  'live.com':     { host: 'outlook.office365.com',    port: 993, tls: true },
  'yahoo.com':    { host: 'imap.mail.yahoo.com',      port: 993, tls: true },
  '163.com':      { host: 'imap.163.com',             port: 993, tls: true },
  '126.com':      { host: 'imap.126.com',             port: 993, tls: true },
  'qq.com':       { host: 'imap.qq.com',              port: 993, tls: true },
  'zoho.com':     { host: 'imap.zoho.com',            port: 993, tls: true },
  'zoho.eu':      { host: 'imap.zoho.eu',             port: 993, tls: true },
  'icloud.com':   { host: 'imap.mail.me.com',         port: 993, tls: true },
  'me.com':       { host: 'imap.mail.me.com',         port: 993, tls: true },
};

// ── Auto-detect SMTP settings ─────────────────────────────────
function detectSmtp(emailAddr) {
  const domain = emailAddr.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  // Exact match
  if (KNOWN_SMTP[domain]) return KNOWN_SMTP[domain];

  // Check for known providers by domain suffix
  for (const [knownDomain, config] of Object.entries(KNOWN_SMTP)) {
    if (domain.endsWith('.' + knownDomain)) return config;
  }

  return null;
}

function detectImap(emailAddr) {
  const domain = emailAddr.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  if (KNOWN_IMAP[domain]) return KNOWN_IMAP[domain];
  for (const [knownDomain, config] of Object.entries(KNOWN_IMAP)) {
    if (domain.endsWith('.' + knownDomain)) return config;
  }
  return null;
}

// ── Prompt for password ────────────────────────────────────────
async function promptPassword() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`Email password for ${email}: `, (pw) => {
      rl.close();
      resolve(pw.trim());
    });
  });
}

// ── Test SMTP connection ───────────────────────────────────────
async function testSmtp(smtpConfig, emailAddr, pw) {
  const transport = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.tls,
    auth: { user: emailAddr, pass: pw },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  const ok = await transport.verify();
  transport.close();
  return ok;
}

// ── MX-based SMTP detection ────────────────────────────────────
async function detectSmtpByMx(emailAddr) {
  const domain = emailAddr.split('@')[1];
  try {
    const mxs = await resolveMx(domain);
    const exchanges = mxs.map(m => m.exchange.toLowerCase());
    for (const mx of exchanges) {
      if (mx.includes('qq.com'))           return { host: 'smtp.exmail.qq.com', port: 465, tls: true };
      if (mx.includes('google.com'))       return KNOWN_SMTP['gmail.com'];
      if (mx.includes('outlook.com'))      return KNOWN_SMTP['outlook.com'];
      if (mx.includes('mail.protection.outlook.com')) return KNOWN_SMTP['outlook.com'];
    }
  } catch (_) { /* MX lookup failed, continue to patterns */ }
  return null;
}

// ── Try common patterns for unknown domains ────────────────────
async function tryCommonSmtp(emailAddr, pw) {
  const domain = emailAddr.split('@')[1];
  const patterns = [
    { host: `smtp.${domain}`,      port: 587, tls: true },
    { host: `mail.${domain}`,      port: 587, tls: true },
    { host: `smtp.${domain}`,      port: 465, tls: true },
    { host: `mail.${domain}`,      port: 465, tls: true },
    { host: `smtp.exmail.qq.com`,  port: 465, tls: true }, // 腾讯企业邮箱
    { host: `smtp.office365.com`,  port: 587, tls: true }, // MS365 hosted
  ];

  for (const cfg of patterns) {
    try {
      console.log(`  Trying ${cfg.host}:${cfg.port}...`);
      if (await testSmtp(cfg, emailAddr, pw)) {
        console.log(`  ✅ ${cfg.host}:${cfg.port} works!`);
        return cfg;
      }
    } catch (e) {
      // continue
    }
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  if (!password) {
    password = await promptPassword();
  }

  console.log(`\n🔗 Binding ${email}...\n`);

  // Step 1: Try auto-detected SMTP
  let smtpConfig = detectSmtp(email);
  let smtpOk = false;

  if (smtpConfig) {
    if (smtpConfig.note) {
      console.log(`⚠️  ${smtpConfig.note}`);
      console.log('Please configure SMTP manually:');
      smtpConfig = null;
    } else {
      console.log(`Auto-detected SMTP: ${smtpConfig.host}:${smtpConfig.port}`);
      try {
        smtpOk = await testSmtp(smtpConfig, email, password);
        if (smtpOk) {
          console.log(`✅ SMTP connected — ${smtpConfig.host}:${smtpConfig.port}\n`);
        } else {
          console.log(`❌ Auto-detected SMTP failed, trying alternatives...\n`);
          smtpConfig = null;
        }
      } catch (e) {
        console.log(`❌ ${e.message}\n`);
        smtpConfig = null;
      }
    }
  }

  // Step 2: MX-based detection + common patterns if auto-detect failed
  if (!smtpConfig) {
    const mxConfig = await detectSmtpByMx(email);
    if (mxConfig) {
      console.log(`MX → SMTP: ${mxConfig.host}:${mxConfig.port}`);
      try {
        smtpOk = await testSmtp(mxConfig, email, password);
        if (smtpOk) {
          smtpConfig = mxConfig;
          console.log(`✅ SMTP connected — ${smtpConfig.host}:${smtpConfig.port}\n`);
        } else {
          console.log(`❌ MX-detected SMTP failed, trying alternatives...\n`);
        }
      } catch (e) {
        console.log(`❌ ${e.message}\n`);
      }
    }
    if (!smtpConfig) {
      smtpConfig = await tryCommonSmtp(email, password);
    }
    if (!smtpConfig) {
      console.error('❌ Could not connect to any SMTP server.');
      console.error('   Please check:');
      console.error('   1. Email and password are correct');
      console.error('   2. If using Gmail/Outlook/163, use an App Password (not login password)');
      console.error('   3. SMTP is enabled on the provider side');
      process.exit(1);
    }
  }

  // Step 3: Detect IMAP (for Sent folder)
  const imapConfig = detectImap(email);
  if (imapConfig) {
    console.log(`IMAP detected: ${imapConfig.host}:${imapConfig.port} (for Sent folder sync)`);
  } else {
    console.log(`IMAP: no known config for this domain (Sent folder sync skipped)`);
  }
  console.log('');

  // Step 4: Save account config
  const accountFile = resolve(ACCOUNTS_DIR, `${email.replace(/[@.]/g, '_')}.json`);
  const config = {
    email,
    smtp: { host: smtpConfig.host, port: smtpConfig.port, secure: smtpConfig.tls },
    imap: imapConfig ? { host: imapConfig.host, port: imapConfig.port, tls: imapConfig.tls } : null,
    bound_at: new Date().toISOString(),
  };

  writeFileSync(accountFile, JSON.stringify(config, null, 2));

  // Step 5: Send test email to self
  console.log(`Sending test email to ${email}...`);
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: email, pass: password },
  });

  const info = await transport.sendMail({
    from: email,
    to: email,
    subject: 'Founder Direct — SMTP binding confirmed ✅',
    html: `<p>Hi,</p><p>Your email <strong>${email}</strong> is now connected to Founder Direct.</p><p>This means you can send personalized, human-sounding emails to high-value buyers directly from this address — no tracking pixels, no unsubscribe footers, just you talking to another person.</p><p>If you received this, the binding is working.</p><p>Tian</p>`,
  });
  transport.close();

  console.log(`✅ Test email sent — check ${email} inbox`);
  console.log(`\n📁 Config saved: ${accountFile}`);
  console.log(`\n🤝 ${email} — Founder Direct ready.
`);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
