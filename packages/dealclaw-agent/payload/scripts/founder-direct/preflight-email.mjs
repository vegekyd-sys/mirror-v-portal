#!/usr/bin/env node
// preflight-email.mjs — 发送前协议检测
// 优先查注册表，无记录时 DNS 探测兜底

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMx } from 'node:dns/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY = resolve(__dirname, 'email-registry.json');

const args = process.argv.slice(2);
const parseArg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const email = parseArg('--email');

if (!email) {
  console.error('Usage: node preflight-email.mjs --email user@domain.com');
  process.exit(2);
}

// ── 1. 查注册表 ──
let registry = {};
if (existsSync(REGISTRY)) {
  registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
}

const record = registry[email];
if (record) {
  console.log(`📋 Registry: ${record.protocol.toUpperCase()} | bound: ${record.bound_at}`);
  console.log(`   ${record.note || ''}`);
  
  if (record.protocol === 'resend') {
    // Resend 域名是否已验证
    const verifiedDomains = ['mail.dealclaw.io'];
    if (verifiedDomains.includes(record.domain)) {
      console.log('✅ Resend domain verified → READY');
      process.exit(0);
    } else {
      console.log(`⚠️  Resend domain "${record.domain}" NOT verified`);
      console.log('ACTION: Add domain in Resend dashboard → verify DNS');
      process.exit(2);
    }
  }
  
  if (record.protocol === 'smtp') {
    // 还需检查 accounts/ 绑定文件
    const accountFile = resolve(__dirname, 'accounts', `${email.replace(/[@.]/g, '_')}.json`);
    if (existsSync(accountFile)) {
      console.log('✅ SMTP account bound → READY');
      process.exit(0);
    } else {
      console.log('❌ SMTP account NOT bound → run: node bind-email.mjs --email ' + email);
      process.exit(2);
    }
  }
  
  console.log(`❌ Unknown protocol: ${record.protocol}`);
  process.exit(2);
}

// ── 2. 注册表无记录 → 按域名自动归类 + 写入注册表 ──
const domain = email.split('@')[1]?.toLowerCase();

// 个人邮箱 / 常见企业邮箱 → 一律 SMTP
const smtpDomains = new Set([
  'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','yahoo.com',
  'qq.com','163.com','126.com','sina.com','sohu.com','foxmail.com',
  'icloud.com','me.com','proton.me','protonmail.com','zoho.com','zoho.eu',
]);
// DealClaw 代理邮箱 → Resend
const resendDomains = new Set(['mail.dealclaw.io','mail.dealclaw.com']);

let protocol, detectNote = '';
if (smtpDomains.has(domain)) {
  protocol = 'smtp';
  detectNote = 'personal email → SMTP';
} else if (resendDomains.has(domain)) {
  protocol = 'resend';
  detectNote = 'DealClaw proxy → Resend';
} else {
  // DNS 兜底：有 MX → SMTP，无 MX → Resend
  let hasMx = false;
  try { const mx = await resolveMx(domain); hasMx = mx && mx.length > 0; } catch (e) {}
  protocol = hasMx ? 'smtp' : 'resend';
  detectNote = `DNS probe: ${hasMx ? 'MX found → SMTP' : 'no MX → Resend'}`;
}

// 写入注册表
registry[email] = {
  protocol,
  domain,
  bound_at: new Date().toISOString().slice(0, 10),
  note: detectNote
};
writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + '\n');
console.log(`📋 Auto-registered: ${protocol.toUpperCase()} → email-registry.json`);

// 按协议判断状态
if (protocol === 'smtp') {
  console.log('❌ Not bound → run: node bind-email.mjs --email ' + email);
  process.exit(2);
}
if (protocol === 'resend') {
  console.log(`⚠️  Resend domain "${domain}" NOT verified`);
  console.log('ACTION: Add domain in Resend dashboard → verify DNS');
  process.exit(2);
}
