// scripts/founder-direct/lib/email-routing.mjs
// 邮箱路由判据 —— 唯一真源（脚本 / skill 文案 / 服务端规则必须一致）
//
// 判据（2026-09-14 统一）：
//   代理邮箱 = 域名是 dealclaw.io 或其任意子域（mail. / bde. / send. …），
//              外加旧域 mail.dealclaw.com
//   个人邮箱 = 其它所有域名（163 / qq / exmail / gmail / 企业自建域名 …）
//
// 优先级：
//   1. 代理域硬判据（最高）—— 代理域内不存在 SMTP/IMAP 收信路径；
//      注册表若写着 smtp，即旧错误记录（stale），按 resend 处理并提示迁移
//   2. 注册表 email-registry.json 的 protocol=resend|smtp —— 只对非代理域生效
//   3. 常见个人邮箱域 → smtp
//   4. 其它外部域 → DNS MX 兜底 —— 只对非代理域做
//
// 为什么代理域绝不能走 MX 兜底：
//   bde.dealclaw.io 这类 Resend 收信域「必然有 MX」，MX 存在会被判成 smtp，
//   于是代理邮箱被走到本地 IMAP 链路（2026-09-14 的实际故障）。

import { resolveMx } from 'node:dns/promises';

export const RESEND_PROXY_SUFFIX = '.dealclaw.io';
export const RESEND_PROXY_ROOTS = new Set(['dealclaw.io', 'mail.dealclaw.com']);

export const PERSONAL_SMTP_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com',
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com', 'foxmail.com',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'zoho.com', 'zoho.eu',
]);

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function domainOf(email) {
  const s = normalizeEmail(email);
  const at = s.lastIndexOf('@');
  return at < 0 ? '' : s.slice(at + 1);
}

/** 代理域判据：dealclaw.io 及其任意子域（含旧域 mail.dealclaw.com）。 */
export function isResendProxyDomain(domain) {
  const d = String(domain ?? '').trim().toLowerCase();
  if (!d) return false;
  return RESEND_PROXY_ROOTS.has(d) || d.endsWith(RESEND_PROXY_SUFFIX);
}

export function lookupRecord(email, registry) {
  if (!registry) return undefined;
  const raw = String(email ?? '');
  return registry[raw] ?? registry[normalizeEmail(email)];
}

/**
 * 同步判定：注册表 + 代理域 + 已知个人域（不做 DNS）。
 * 用于发信侧（send-direct.mjs）选路。
 */
export function isResendProxyEmail(email, registry = {}) {
  if (isResendProxyDomain(domainOf(email))) return true;
  const record = lookupRecord(email, registry);
  return record?.protocol === 'resend';
}

/** 本地 account 文件名（与 bind-email.mjs 的历史规则一致）。 */
export function accountFileFor(email) {
  return `${normalizeEmail(email).replace(/[@.]/g, '_')}.json`;
}

async function defaultMxProbe(domain) {
  try {
    const mx = await resolveMx(domain);
    return Boolean(mx && mx.length > 0);
  } catch {
    return false;
  }
}

/**
 * 判定邮箱应走的协议。
 * @returns {{email:string,domain:string,protocol:'resend'|'smtp'|null,source:string,note:string,stale:boolean,probed:boolean}}
 */
export async function classifyEmailProtocol(email, { registry = {}, mxProbe = defaultMxProbe } = {}) {
  const domain = domainOf(email);
  if (!domain) {
    return { email, domain: '', protocol: null, source: 'invalid', note: '邮箱地址不合法', stale: false, probed: false };
  }

  const record = lookupRecord(email, registry);
  const recorded = record && (record.protocol === 'resend' || record.protocol === 'smtp')
    ? record.protocol
    : null;

  // 1. 代理域硬判据
  if (isResendProxyDomain(domain)) {
    const stale = recorded === 'smtp';
    return {
      email,
      domain,
      protocol: 'resend',
      source: stale ? 'proxy-domain-override' : 'proxy-domain',
      note: stale
        ? '代理域判据覆盖注册表旧记录（protocol=smtp）→ Resend'
        : 'DealClaw 代理邮箱 → Resend',
      stale,
      probed: false,
    };
  }

  // 2. 注册表（仅非代理域）
  if (recorded) {
    return { email, domain, protocol: recorded, source: 'registry', note: record?.note || '', stale: false, probed: false };
  }

  // 3. 已知个人邮箱域
  if (PERSONAL_SMTP_DOMAINS.has(domain)) {
    return { email, domain, protocol: 'smtp', source: 'known-personal', note: '个人邮箱 → SMTP', stale: false, probed: false };
  }

  // 4. 外部域 MX 兜底
  const hasMx = await mxProbe(domain);
  return {
    email,
    domain,
    protocol: hasMx ? 'smtp' : 'resend',
    source: 'mx-probe',
    note: hasMx ? 'DNS 探测：有 MX → SMTP' : 'DNS 探测：无 MX → Resend',
    stale: false,
    probed: true,
  };
}

/** 找出注册表里「代理域 + 非 resend」的旧错误记录。幂等：已是 resend 的不返回。 */
export function planProxyMigration(registry = {}) {
  const entries = [];
  for (const [email, record] of Object.entries(registry || {})) {
    const domain = domainOf(email) || String(record?.domain ?? '').toLowerCase();
    if (!isResendProxyDomain(domain)) continue;
    if (record?.protocol === 'resend') continue;
    entries.push({ email, domain, from: record?.protocol ?? null, to: 'resend' });
  }
  return entries.sort((a, b) => a.email.localeCompare(b.email));
}

/** 生成迁移后的注册表副本（不改原对象）。 */
export function applyProxyMigration(registry = {}, entries = [], { migratedAt = new Date().toISOString() } = {}) {
  const next = JSON.parse(JSON.stringify(registry || {}));
  for (const entry of entries) {
    const current = next[entry.email] || {};
    next[entry.email] = {
      ...current,
      protocol: 'resend',
      domain: entry.domain,
      bound_at: current.bound_at || migratedAt.slice(0, 10),
      note: [current.note, `迁移：代理域 → Resend（原 protocol=${entry.from ?? '缺失'}）`]
        .filter(Boolean)
        .join(' | '),
      migrated_from: entry.from ?? null,
      migrated_at: migratedAt,
    };
  }
  return next;
}
