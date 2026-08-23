#!/usr/bin/env node
// scripts/resend/domain-setup.mjs
// 企业邮箱域名配置工具 — DealClaw 入驻流程 v2
//
// 核心改进：DNS 托管商自动检测 + 平台专属引导 + 一键复制格式
//
// Usage:
//   export RESEND_API_KEY=re_xxx
//   node scripts/resend/domain-setup.mjs step1 --email tian@company.com
//   node scripts/resend/domain-setup.mjs step2 --domain company.com
//   node scripts/resend/domain-setup.mjs step3e --domain company.com
//   node scripts/resend/domain-setup.mjs step4 --domain company.com
//   node scripts/resend/domain-setup.mjs dns-detect --domain company.com

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── API key resolution ──────────────────────────────────────────
function getApiKey(args) {
  const flagIdx = args.indexOf('--key');
  if (flagIdx >= 0 && args[flagIdx + 1]) return args[flagIdx + 1];
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  const envFile = resolve(__dirname, '.env');
  if (existsSync(envFile)) {
    const lines = readFileSync(envFile, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^RESEND_API_KEY=(.+)/);
      if (m) return m[1].trim();
    }
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────
const BASE = 'https://api.resend.com';

async function resendApi(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Resend API error ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ── State persistence ────────────────────────────────────────────
function stateDir(rootDomain) {
  return resolve(__dirname, 'domains', rootDomain);
}

function loadState(rootDomain) {
  const p = resolve(stateDir(rootDomain), 'state.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function saveState(rootDomain, data) {
  const dir = stateDir(rootDomain);
  mkdirSync(dir, { recursive: true });
  const existing = loadState(rootDomain) || {};
  const merged = { ...existing, ...data, updated_at: new Date().toISOString() };
  writeFileSync(resolve(dir, 'state.json'), JSON.stringify(merged, null, 2));
  return merged;
}

// ── Public email domain blacklist ────────────────────────────────
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'qq.com', 'vip.qq.com', 'foxmail.com',
  '163.com', '126.com', 'yeah.net',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.com.cn', 'ymail.com',
  'sina.com', 'sina.cn', 'vip.sina.com',
  'sohu.com', 'sogou.com',
  'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com',
  'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru',
  'yandex.com', 'yandex.ru',
  'zoho.com', 'fastmail.com', 'tutanota.com',
  'aol.com', 'aim.com',
]);

// ── dig A/MX/TXT check (local) ──────────────────────────────────
function digRecord(type, name) {
  try {
    const out = execSync(`dig +short ${type} "${name}"`, { encoding: 'utf8', timeout: 5000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// ── DNS provider detection ──────────────────────────────────────
function detectDnsProvider(rootDomain) {
  const nsRecords = digRecord('NS', rootDomain);
  if (!nsRecords) return { key: 'unknown', name: '未知 DNS 托管商', url: null, patterns: [] };

  const ns = nsRecords.toLowerCase();

  const platforms = [
    { key: 'aliyun', name: '阿里云 DNS', url: 'https://dns.console.aliyun.com/#/dns/domain/list', patterns: ['aliyun.com', 'hichina.com'] },
    { key: 'dnspod', name: 'DNSPod / 腾讯云 DNS', url: 'https://console.dnspod.cn/dns', patterns: ['dnspod.net', 'dnspod.com'] },
    { key: 'cloudflare', name: 'Cloudflare', url: 'https://dash.cloudflare.com/', patterns: ['cloudflare.com'] },
    { key: 'godaddy', name: 'GoDaddy', url: 'https://dcc.godaddy.com/manage/', patterns: ['domaincontrol.com', 'godaddy.com'] },
    { key: 'namecheap', name: 'Namecheap', url: 'https://ap.www.namecheap.com/domains/', patterns: ['namecheap.com', 'registrar-servers.com'] },
    { key: 'route53', name: 'AWS Route 53', url: 'https://console.aws.amazon.com/route53/', patterns: ['awsdns-'] },
    { key: 'hostinger', name: 'Hostinger', url: 'https://hpanel.hostinger.com/', patterns: ['hostinger.com'] },
    { key: 'namecom', name: 'Name.com', url: 'https://www.name.com/account/domain/', patterns: ['name.com'] },
    { key: 'google', name: 'Google Domains / Cloud DNS', url: 'https://console.cloud.google.com/net-services/dns/', patterns: ['googledomains.com', 'google.com'] },
    { key: 'azure', name: 'Azure DNS', url: 'https://portal.azure.com/', patterns: ['azure-dns.com', 'azure-dns.net'] },
    { key: 'dynadot', name: 'Dynadot', url: 'https://www.dynadot.com/domain/', patterns: ['dynadot.com'] },
    { key: 'porkbun', name: 'Porkbun', url: 'https://porkbun.com/account/', patterns: ['porkbun.com'] },
    { key: 'namesilo', name: 'NameSilo', url: 'https://www.namesilo.com/account/', patterns: ['namesilo.com'] },
    { key: 'bluehost', name: 'Bluehost', url: 'https://my.bluehost.com/', patterns: ['bluehost.com'] },
    { key: 'dreamhost', name: 'DreamHost', url: 'https://panel.dreamhost.com/', patterns: ['dreamhost.com'] },
    { key: 'iwantmyname', name: 'iWantMyName', url: 'https://iwantmyname.com/', patterns: ['iwantmyname.net'] },
  ];

  for (const p of platforms) {
    for (const pat of p.patterns) {
      if (ns.includes(pat)) return p;
    }
  }

  return { key: 'unknown', name: '未知 DNS 托管商', url: null, patterns: [] };
}

// ── Platform-specific guides ────────────────────────────────────
const PLATFORM_GUIDES = {
  aliyun: {
    steps: [
      '打开阿里云 DNS 控制台',
      '在域名列表中找到 {domain}，点击右侧「解析设置」',
      '点击「添加记录」按钮',
      '按下方逐一添加记录',
      '每条添加后点击「确认」，全部添加后等待 1-2 分钟生效',
    ],
    tip: '💡 主机记录填写时，阿里云会自动补全域名后缀，只需填前缀部分即可。',
  },
  dnspod: {
    steps: [
      '打开 DNSPod 控制台',
      '在域名列表中找到 {domain}，点击进入解析设置',
      '点击「添加记录」',
      '按下方逐一添加记录',
      '保存后等待 1-2 分钟生效',
    ],
    tip: '💡 DNSPod 的「线路类型」保持默认即可；TTL 选「自动」或默认 600。',
  },
  cloudflare: {
    steps: [
      '打开 Cloudflare Dashboard，选择 {domain}',
      '点击左侧「DNS」→「Records」',
      '点击「Add record」',
      '按下方逐一添加记录（⚠️ 切换 Proxy 为 DNS only）',
      '保存后通常 1 分钟内生效',
    ],
    tip: '⚠️ 重要：添加时切换 Proxy status 为「DNS only」（灰色云朵），不要用 Proxied（橙色云朵）。',
  },
  godaddy: {
    steps: [
      '打开 GoDaddy Domain Portfolio',
      '找到 {domain}，点击「DNS」',
      '点击「Add New Record」',
      '按下方逐一添加',
      '保存后等待几分钟生效',
    ],
    tip: '💡 GoDaddy 的 TTL 默认 600 即可。',
  },
  unknown: {
    steps: [
      '登录你的域名 DNS 管理后台',
      '找到 {domain} 的 DNS / 解析设置页面',
      '添加下方列出的记录',
      '保存后等待 1-2 分钟生效',
    ],
    tip: '💡 如果不确定在哪里配置，通常是购买域名的服务商后台（阿里云/腾讯云/GoDaddy 等）→ DNS 管理/解析设置。',
  },
};

function getPlatformGuide(platform, rootDomain) {
  const guide = PLATFORM_GUIDES[platform.key] || PLATFORM_GUIDES.unknown;
  return {
    ...guide,
    steps: guide.steps.map(s => s.replace(/\{domain\}/g, rootDomain)),
    platformName: platform.name,
    url: platform.url,
  };
}

// ── Copy-friendly single record format ──────────────────────────
function formatSingleRecord(r, rootDomain) {
  const fullName = r.name.includes('.') ? r.name : `${r.name}.${rootDomain}`;
  const lines = [];
  lines.push(`类型: ${r.type}`);
  lines.push(`主机记录: ${fullName}`);
  lines.push(`记录值 (完整): ${r.value}`);
  if (r.priority !== undefined) lines.push(`优先级: ${r.priority}`);
  lines.push(`TTL: ${r.ttl === 'Auto' ? '自动/默认' : r.ttl}`);
  // Integrity check — value must not be truncated
  if (r.value.includes('…') || r.value.includes('...')) {
    lines.push('⚠️ 警告：记录值可能被截断！请检查原始 API 响应。');
  }
  return lines.join('\n');
}

// ── Pretty print DNS records (legacy) ────────────────────────────
function formatRecords(records, domainLabel) {
  const lines = [];
  lines.push(`\n📋 ${domainLabel} DNS 记录：`);
  lines.push('─'.repeat(72));
  for (const r of records) {
    const ttl = r.ttl === 'Auto' ? '自动' : r.ttl;
    const priority = r.priority !== undefined ? `[优先级 ${r.priority}]` : '';
    const fullName = r.name.includes('.') ? r.name : `${r.name}.${domainLabel}`;
    lines.push(`  类型: ${r.type.padEnd(6)} | 主机记录: ${fullName}`);
    lines.push(`  值:    ${r.value}`);
    if (priority) lines.push(`  备注:  ${priority} | TTL: ${ttl}`);
    else lines.push(`  TTL:   ${ttl}`);
    lines.push('');
  }
  lines.push('─'.repeat(72));
  return lines.join('\n');
}

// ── Step 1: Validate email, set sender identity ────────────────
async function step1(email, displayName, fromEmail) {
  if (!email || !email.includes('@')) throw new Error('请输入有效的邮箱地址');
  const domain = email.split('@')[1].toLowerCase().trim();
  if (PUBLIC_DOMAINS.has(domain)) {
    throw new Error(`❌ ${domain} 是公共邮箱域名，不支持企业邮箱配置。请使用公司域名邮箱。`);
  }

  const sendDomain = `send.${domain}`;
  const replyDomain = `reply.${domain}`;

  const name = displayName || email.split('@')[0];
  const emailAddr = fromEmail || `noreply@${sendDomain}`;
  const fromAddress = `${name} <${emailAddr}>`;

  const state = saveState(domain, {
    email,
    display_name: name,
    from_address: fromAddress,
    root_domain: domain,
    send_domain: sendDomain,
    reply_domain: replyDomain,
    status: 'validated',
  });

  console.log(`✅ Step 1 — 邮箱验证完成`);
  console.log(`   企业邮箱: ${email}`);
  console.log(`   ⚠️ 确认发件人: ${name}`);
  console.log(`   ⚠️ 确认发件地址: ${fromAddress}`);
  console.log(`   根域名:   ${domain}`);
  console.log();
  console.log(`💡 如需修改：`);
  console.log(`   sender --domain ${domain} --name "英文名" [--email user@${sendDomain}]`);
  return state;
}

// ── Step 2: Create Resend domains ────────────────────────────────
async function step2(rootDomain) {
  const state = loadState(rootDomain);
  if (!state) throw new Error(`未找到 ${rootDomain} 的配置，请先运行 step1`);

  const { send_domain, reply_domain } = state;

  console.log(`🔄 正在创建发信域名: ${send_domain} ...`);
  const sendResult = await resendApi('POST', '/domains', {
    name: send_domain,
    region: 'us-east-1',
  });
  console.log(`   ✅ 创建成功 (id: ${sendResult.id}, status: ${sendResult.status})`);

  let replyResult = null;
  try {
    console.log(`🔄 正在创建收信域名: ${reply_domain} ...`);
    replyResult = await resendApi('POST', '/domains', {
      name: reply_domain,
      region: 'us-east-1',
    });
    console.log(`   ✅ 创建成功 (id: ${replyResult.id}, status: ${replyResult.status})`);
  } catch (err) {
    if (err.message.includes('Upgrade')) {
      console.log(`   ⚠️  免费 plan 仅支持 1 个域名，将启用单域名双用途模式。`);
      console.log(`   🔄 正在更新 ${send_domain}，同时开启 receiving ...`);
      await resendApi('PATCH', `/domains/${sendResult.id}`, {
        capabilities: { sending: 'enabled', receiving: 'enabled' },
      });
      const updated = await resendApi('GET', `/domains/${sendResult.id}`);
      console.log(`   ✅ 已更新 (capabilities: sending+receiving)`);

      saveState(rootDomain, {
        send_domain_id: sendResult.id,
        reply_domain_id: sendResult.id,
        send_records: updated.records || [],
        reply_records: [],
        note: `单域名双用途: ${send_domain} 同时处理发信+收信`,
        status: 'dns_pending',
      });

      console.log();
      console.log(`✅ Step 2 完成 — 单域名双用途模式`);
      console.log(`   ${send_domain} — 发信 ✅ + 收信 ✅`);
      printGuidedDnsConfig(rootDomain);
      return { sendResult: updated, replyResult: null };
    }
    throw err;
  }

  saveState(rootDomain, {
    send_domain_id: sendResult.id,
    reply_domain_id: replyResult.id,
    send_records: sendResult.records || [],
    reply_records: replyResult.records || [],
    status: 'dns_pending',
  });

  console.log();
  console.log(`✅ Step 2 完成 — 双域名模式`);
  console.log(`   ${send_domain} — 发信`);
  console.log(`   ${reply_domain} — 收信`);
  printGuidedDnsConfig(rootDomain);
  return { sendResult, replyResult };
}

// ── Print guided DNS config (shared by step2 & step3e) ──────────
function printGuidedDnsConfig(rootDomain) {
  const state = loadState(rootDomain);
  if (!state) return;

  const allRecords = [
    ...(state.send_records || []).map(r => ({ ...r, _domain: state.send_domain || rootDomain })),
    ...(state.reply_records || []).map(r => ({ ...r, _domain: state.reply_domain || rootDomain })),
  ];
  if (allRecords.length === 0) return;

  // Detect platform
  const platform = detectDnsProvider(rootDomain);
  const guide = getPlatformGuide(platform, rootDomain);

  console.log();
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  📌 Step 3 — ${guide.platformName} DNS 配置`);
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();
  if (guide.url) console.log(`  🔗 控制台: ${guide.url}`);
  console.log();

  for (let i = 0; i < guide.steps.length; i++) {
    console.log(`  ${i + 1}️⃣  ${guide.steps[i]}`);
  }
  console.log();
  console.log(`  ${guide.tip}`);
  console.log();
  console.log('───────────────────────────────────────────────────────────────────');
  console.log('  📋 需添加的 DNS 记录：');
  console.log('───────────────────────────────────────────────────────────────────');

  for (let i = 0; i < allRecords.length; i++) {
    const r = allRecords[i];
    const purpose = r.record === 'DKIM' ? '🔐 DKIM 签名（防伪造）'
      : r.record === 'SPF' && r.type === 'MX' ? '📨 SPF MX（退信处理）'
      : r.record === 'SPF' && r.type === 'TXT' ? '✅ SPF TXT（发信授权）'
      : r.record === 'Receiving' ? '📥 收信 MX（买家回复入口）'
      : r.record === 'Tracking' ? '📊 追踪（打开/点击）'
      : `📌 ${r.record || r.type}`;

    console.log(`\n  ── 记录 ${i + 1}/${allRecords.length}: ${purpose} ──`);
    console.log(formatSingleRecord(r, rootDomain));
  }

  console.log();
  console.log('───────────────────────────────────────────────────────────────────');
  console.log(`  💡 全部添加保存后运行验证：`);
  console.log(`    node scripts/resend/domain-setup.mjs step4 --domain ${rootDomain}`);
}

// ── Step 3 Enhanced: re-print guided DNS config ─────────────────
async function step3Enhanced(rootDomain) {
  const state = loadState(rootDomain);
  if (!state) throw new Error(`未找到 ${rootDomain} 的配置`);
  printGuidedDnsConfig(rootDomain);
}

// ── Step 4: DNS verification ─────────────────────────────────────
async function step4(rootDomain, target) {
  const state = loadState(rootDomain);
  if (!state) throw new Error(`未找到 ${rootDomain} 的配置`);

  const domains = [];
  if (!target || target === 'send') {
    domains.push({ type: 'send', id: state.send_domain_id, name: state.send_domain, records: state.send_records });
  }
  if (!target || target === 'reply') {
    if (state.reply_domain_id && state.reply_domain_id !== state.send_domain_id) {
      domains.push({ type: 'reply', id: state.reply_domain_id, name: state.reply_domain, records: state.reply_records });
    }
  }

  let allPassed = true;
  const results = [];

  for (const d of domains) {
    console.log(`\n🔍 检查 ${d.name}（${d.type === 'send' ? '发信' : '收信'}）...`);

    let localOk = 0;
    let localFail = 0;
    const localChecks = [];

    for (const r of (d.records || [])) {
      const fullName = r.name.includes('.') ? r.name : `${r.name}.${rootDomain}`;
      const result = digRecord(r.type, fullName);
      if (result) {
        localOk++;
        localChecks.push({ record: r, fullName, passed: true, result });
      } else {
        localFail++;
        localChecks.push({ record: r, fullName, passed: false });
      }
    }

    const localRatio = `${localOk}/${localOk + localFail}`;
    if (localFail > 0) {
      console.log(`   ⚠️  本地 DNS: ${localRatio} 可解析`);
      for (const c of localChecks.filter(c => !c.passed)) {
        console.log(`      未解析: ${c.fullName} (${c.record.type})`);
      }
      allPassed = false;
    } else {
      console.log(`   ✅ 本地 DNS: ${localRatio} 全部可解析`);
    }

    if (d.id) {
      console.log(`   🔄 触发 Resend 验证...`);
      try {
        const verifyResult = await resendApi('POST', `/domains/${d.id}/verify`);
        const updated = await resendApi('GET', `/domains/${d.id}`);
        console.log(`   📊 状态: ${updated.status}`);

        results.push({
          domain: d.name, type: d.type, domain_id: d.id,
          status: updated.status,
          local_dns: localFail === 0 ? 'all_resolved' : 'partial',
        });

        if (updated.status === 'verified') {
          console.log(`   🎉 ${d.name} 验证通过！`);
        } else if (updated.status === 'failed') {
          console.log(`   ❌ 验证失败，请检查 DNS 记录。`);
          allPassed = false;
        } else {
          console.log(`   ⏳ 验证中（通常几分钟），稍后可重跑 step4。`);
        }
      } catch (err) {
        console.log(`   ❌ 验证失败: ${err.message}`);
        allPassed = false;
      }
    }
  }

  const newStatus = allPassed ? 'verified'
    : results.some(r => r.status === 'verified') ? 'partial_verified' : 'dns_pending';
  saveState(rootDomain, { status: newStatus });

  console.log();
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  📊 验证总结');
  console.log('═══════════════════════════════════════════════════════════════════');
  for (const r of results) {
    const icon = r.status === 'verified' ? '✅' : r.status === 'pending' ? '⏳' : '❌';
    console.log(`  ${icon} ${(r.domain || '').padEnd(35)} | ${r.status}`);
  }
  return results;
}

// ── Status ───────────────────────────────────────────────────────
async function cmdStatus(rootDomain) {
  const domains = [];
  if (rootDomain) {
    const s = loadState(rootDomain);
    if (!s) { console.log(`未找到 ${rootDomain} 的配置`); return; }
    domains.push({ root: rootDomain, state: s });
  } else {
    const dir = resolve(__dirname, 'domains');
    if (!existsSync(dir)) { console.log('暂无已配置的域名'); return; }
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of entries) {
      const s = loadState(d.name);
      if (s) domains.push({ root: d.name, state: s });
    }
  }
  for (const { root, state } of domains) {
    console.log(`\n📧 ${state.email || '?'}  (根域名: ${root})`);
    console.log(`   状态: ${state.status || '?'}`);
    console.log(`   发件地址: ${state.from_address || '未设置'}`);
    console.log(`   发信: ${state.send_domain || '?'}  (${state.send_domain_id || '?'})`);
    console.log(`   收信: ${state.reply_domain || '?'}  (${state.reply_domain_id || '?'})`);
    if (state.note) console.log(`   备注: ${state.note}`);
    console.log(`   更新: ${state.updated_at || '?'}`);
  }
}

// ── Entry ─────────────────────────────────────────────────────────
const apiKey = getApiKey(process.argv);
if (!apiKey) {
  console.error('❌ RESEND_API_KEY 未设置。');
  console.error('   1. export RESEND_API_KEY=re_xxx');
  console.error('   2. node ... --key re_xxx');
  console.error('   3. scripts/resend/.env 中添加 RESEND_API_KEY=re_xxx');
  process.exit(1);
}
const API_KEY = apiKey;

const command = process.argv[2];
const parseArg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

try {
  switch (command) {
    case 'step1': { await step1(parseArg('--email'), parseArg('--name'), parseArg('--from-email')); break; }
    case 'sender': {
      const domain = parseArg('--domain');
      const name = parseArg('--name');
      const emailAddr = parseArg('--email') || `noreply@send.${domain}`;
      if (!domain || !name) throw new Error('用法: sender --domain company.com --name "新名字" [--email agent@example.company.com]');
      const fromAddress = `${name} <${emailAddr}>`;
      saveState(domain, { display_name: name, from_address: fromAddress });
      console.log(`✅ 发件人已更新: ${fromAddress}`);
      break;
    }
    case 'send': {
      const domain = parseArg('--domain');
      const to = parseArg('--to');
      const subject = parseArg('--subject') || '无主题';
      const htmlFile = parseArg('--html-file');
      const html = parseArg('--html');
      if (!domain || !to) throw new Error('用法: send --domain company.com --to buyer@x.com --subject "Hi" [--html "<p>..</p>"] [--html-file path]');
      const state = loadState(domain);
      if (!state || state.status !== 'verified') throw new Error(`${domain} 未验证，请先完成 step1-4`);
      const from = state.from_address || `DealClaw <noreply@${state.send_domain}>`;
      let bodyHtml = html;
      if (htmlFile) {
        const { readFileSync } = await import('node:fs');
        bodyHtml = readFileSync(htmlFile, 'utf8');
      }
      const email = { from, to: [to], subject };
      if (bodyHtml) email.html = bodyHtml;
      const result = await resendApi('POST', '/emails', email);
      console.log(`✅ 已发送: ${result.id}`);
      console.log(`   发件: ${from}`);
      console.log(`   收件: ${to}`);
      break;
    }
    case 'step2': { await step2(parseArg('--domain')); break; }
    case 'step3': case 'step3e': { await step3Enhanced(parseArg('--domain')); break; }
    case 'step4': { await step4(parseArg('--domain'), parseArg('--target')); break; }
    case 'status': { await cmdStatus(parseArg('--domain')); break; }
    case 'list': { await cmdStatus(null); break; }
    case 'dns-detect': {
      const d = parseArg('--domain');
      console.log(JSON.stringify(detectDnsProvider(d), null, 2));
      break;
    }
    default:
      console.log('DealClaw 企业邮箱域名配置工具 v2');
      console.log();
      console.log('用法:');
      console.log('  step1 --email user@company.com [--name "发件人名字"]');
      console.log('  step2 --domain company.com               创建 Resend 域名+显示 DNS 引导');
      console.log('  step3e --domain company.com              重新显示 DNS 配置引导');
      console.log('  step4 --domain company.com               DNS 验证（dig + Resend verify）');
      console.log('  sender --domain company.com --name "名"   修改发件人名字');
      console.log('  send --domain company.com --to ...       从已配置域名发信');
      console.log('  dns-detect --domain company.com          检测 DNS 托管商');
      console.log('  status [--domain company.com]            查看配置状态');
      console.log('  list                                     列出所有已配置域名');
  }
} catch (err) {
  console.error(`\n❌ 错误: ${err.message}`);
  process.exit(1);
}
