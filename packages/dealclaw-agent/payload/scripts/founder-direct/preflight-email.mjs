#!/usr/bin/env node
// preflight-email.mjs — 发送/绑定前协议检测
// 判据真源：lib/email-routing.mjs（代理域硬判据 → 注册表 → 已知个人域 → MX 兜底）
//
// 退出码：0 = READY；2 = 未就绪（缺绑定 / 域名未验证）；1 = 运行错误

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyEmailProtocol,
  isResendProxyDomain,
  accountFileFor,
} from './lib/email-routing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY = resolve(__dirname, 'email-registry.json');
const ACCOUNTS_DIR = resolve(__dirname, 'accounts');

const args = process.argv.slice(2);
const parseArg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const email = parseArg('--email');

if (!email) {
  console.error('Usage: node preflight-email.mjs --email user@domain.com');
  process.exit(2);
}

function loadRegistry() {
  if (!existsSync(REGISTRY)) return {};
  try { return JSON.parse(readFileSync(REGISTRY, 'utf8')); } catch { return {}; }
}

const registry = loadRegistry();
const result = await classifyEmailProtocol(email, { registry });

if (!result.protocol) {
  console.error(`❌ ${result.note}`);
  process.exit(2);
}

console.log(`📋 ${result.protocol.toUpperCase()} | domain=${result.domain} | 来源=${result.source}`);
if (result.note) console.log(`   ${result.note}`);

// 注册表：只补新记录，不覆盖既有记录
const existing = registry[email];
if (!existing) {
  registry[email] = {
    protocol: result.protocol,
    domain: result.domain,
    bound_at: new Date().toISOString().slice(0, 10),
    note: result.note,
  };
  writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + '\n');
  console.log('📝 已登记 → email-registry.json');
} else if (result.stale) {
  console.log('⚠️  注册表记录与代理域判据冲突 → 本次按 RESEND 处理');
  console.log('ACTION: node scripts/founder-direct/migrate-proxy-protocol.mjs（先看报告，再加 --apply）');
}

// ── Resend 代理邮箱 ──────────────────────────────────────────
if (result.protocol === 'resend') {
  // 代理域由平台在 Resend 侧统一验证；需要逐域严格校验时设 DC_RESEND_VERIFIED_DOMAINS=a.com,b.com
  const explicit = (process.env.DC_RESEND_VERIFIED_DOMAINS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const verified = explicit.length
    ? explicit.includes(result.domain)
    : isResendProxyDomain(result.domain);

  if (verified) {
    console.log('✅ Resend 代理域已验证 → READY（绑定走服务端 /webhook/bindings，传 agent_email）');
    process.exit(0);
  }
  console.log(`⚠️  Resend domain "${result.domain}" NOT verified`);
  console.log('ACTION: Add domain in Resend dashboard → verify DNS');
  process.exit(2);
}

// ── 个人邮箱（本地 IMAP）────────────────────────────────────
const accountFile = resolve(ACCOUNTS_DIR, accountFileFor(email));
if (existsSync(accountFile)) {
  console.log('✅ SMTP account bound → READY（绑定走本地 bind-group，传 account_id）');
  process.exit(0);
}
console.log('❌ SMTP account NOT bound → run: node bind-email.mjs --email ' + email);
process.exit(2);
