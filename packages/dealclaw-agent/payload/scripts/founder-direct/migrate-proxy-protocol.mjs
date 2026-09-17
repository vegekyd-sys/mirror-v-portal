#!/usr/bin/env node
// migrate-proxy-protocol.mjs — 存量迁移：代理域（dealclaw.io 及其子域）的旧错误协议记录 → resend
//
// 背景：历史上只有 mail.dealclaw.io 被认作代理域，bde.dealclaw.io 这类子域会被
//       DNS MX 兜底判成 smtp，落进 email-registry.json 变成错误记录，
//       从而把代理邮箱走到个人 IMAP 链路。
//
// 行为：默认只出报告（不改任何文件）；--apply 才写注册表。幂等：已是 resend 的跳过。
//
// Usage:
//   node scripts/founder-direct/migrate-proxy-protocol.mjs
//   node scripts/founder-direct/migrate-proxy-protocol.mjs --json
//   node scripts/founder-direct/migrate-proxy-protocol.mjs --apply
//   node scripts/founder-direct/migrate-proxy-protocol.mjs --apply --quarantine-accounts
//   node scripts/founder-direct/migrate-proxy-protocol.mjs --registry <path> --accounts-dir <dir>
//
// --quarantine-accounts：把代理邮箱残留的本地 IMAP account 文件「移动」（非删除）到
//   accounts/.migrated-proxy-<时间戳>/，可人工移回；不加这个开关则只列出来。

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planProxyMigration,
  applyProxyMigration,
  accountFileFor,
  isResendProxyDomain,
  domainOf,
} from './lib/email-routing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const hasArg = (f) => args.includes(f);
const parseArg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const doApply = hasArg('--apply');
const asJson = hasArg('--json');
const quarantine = hasArg('--quarantine-accounts');
const registryPath = parseArg('--registry') || resolve(__dirname, 'email-registry.json');
const accountsDir = parseArg('--accounts-dir') || resolve(__dirname, 'accounts');

const registry = existsSync(registryPath)
  ? JSON.parse(readFileSync(registryPath, 'utf8'))
  : {};

const planned = planProxyMigration(registry);

// 连带排查：代理邮箱若还留着本地 IMAP account 文件 → 列出来（默认不动）
const localAccounts = [];
for (const [email] of Object.entries(registry)) {
  if (!isResendProxyDomain(domainOf(email))) continue;
  const file = join(accountsDir, accountFileFor(email));
  if (existsSync(file)) localAccounts.push({ email, file });
}

let quarantinedDir = null;
if (doApply && quarantine && localAccounts.length) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  quarantinedDir = join(accountsDir, `.migrated-proxy-${stamp}`);
  mkdirSync(quarantinedDir, { recursive: true });
  for (const item of localAccounts) {
    renameSync(item.file, join(quarantinedDir, item.file.split('/').pop()));
  }
}

if (doApply && planned.length) {
  const next = applyProxyMigration(registry, planned);
  const tmp = `${registryPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, registryPath); // 原子替换
}

if (asJson) {
  console.log(JSON.stringify({
    applied: doApply,
    registry: registryPath,
    planned,
    local_accounts: localAccounts,
    quarantined_dir: quarantinedDir,
  }, null, 2));
} else {
  console.log(`注册表：${registryPath}`);
  if (!planned.length) {
    console.log('✅ 无需迁移：没有「代理域 + 非 resend」的记录');
  } else {
    console.log(`${doApply ? '✅ 已迁移' : '🔍 待迁移'} ${planned.length} 条：`);
    for (const p of planned) {
      console.log(`  - ${p.email}  protocol ${p.from ?? '(缺失)'} → resend${doApply ? '' : '   [未写入]'}`);
    }
    if (!doApply) console.log('\n执行写入：加 --apply');
  }
  if (localAccounts.length) {
    console.log(`\n⚠️  代理邮箱残留本地 IMAP account 文件 ${localAccounts.length} 个：`);
    for (const a of localAccounts) console.log(`  - ${a.file}`);
    console.log(quarantinedDir
      ? `   已移动到：${quarantinedDir}`
      : '   这两个文件已无意义（代理邮箱不发 IMAP）；确认后可加 --quarantine-accounts 移走（是移动，不是删除）');
  }
}
