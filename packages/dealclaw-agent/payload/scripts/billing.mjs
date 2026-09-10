#!/usr/bin/env node
/**
 * DealClaw Billing CLI — universal billing hook for OpenClaw agents.
 *
 * Talks to credits-ledger (localhost:8081) — no auth needed on same host.
 *
 * Commands:
 *   node scripts/billing.mjs estimate  <tenantId> <skillId> [quantity]
 *   node scripts/billing.mjs settle    <tenantId> <skillId> <eventId> [quantity]
 *   node scripts/billing.mjs can-afford <tenantId> <skillId> [quantity]
 *   node scripts/billing.mjs balance   <tenantId>
 *   node scripts/billing.mjs wrap      <tenantId> <skillId> [quantity] -- <command...>
 *
 * Tenant lookup (auto-resolve from group/user):
 *   node scripts/billing.mjs resolve --group oc_xxx
 *   node scripts/billing.mjs resolve --user ou_xxx
 *   node scripts/billing.mjs estimate --group oc_xxx <skillId> [quantity]
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfgPath = resolve(__dirname, 'billing-config.json');

const BASE = process.env.DC_BILLING_URL || 'http://localhost:8081';

function loadConfig() {
  if (!existsSync(cfgPath)) return { groups: {}, users: {}, defaultBehavior: { unknownTenant: 'shadow' } };
  return JSON.parse(readFileSync(cfgPath, 'utf8'));
}

function saveConfig(cfg) {
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function resolveTenantFromCtx({ groupId, userId } = {}) {
  const cfg = loadConfig();
  if (userId && cfg.users[userId]) {
    const u = cfg.users[userId];
    return typeof u === 'string' ? u : (u.tenant || null);
  }
  if (groupId && cfg.groups[groupId]) return cfg.groups[groupId];
  return null;
}

function accId(tenant) {
  return `acct_${tenant}`;
}

// Service token for credits-ledger (internal service-to-service auth).
// Prefers env DC_BILLING_TOKEN; falls back to a local gitignored file.
const tokenPath = resolve(__dirname, '.billing-token');
function loadToken() {
  if (process.env.DC_BILLING_TOKEN) return process.env.DC_BILLING_TOKEN;
  try {
    if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  } catch { /* ignore */ }
  return null;
}

function authHeaders() {
  const token = loadToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function post(path, body) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || res.statusText), { status: res.status, code: data.code, data });
  return data;
}

async function get(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { status: res.status, data });
  return data;
}

function fmt(n) {
  return Number(n).toLocaleString();
}

// ─── Tenant Resolution ────────────────────────────────────

function parseLookupArgs(args) {
  // Parse --group <id> or --user <id> from args, return {args, tenant, groupId, userId}
  const result = { args: [], tenant: null, groupId: null, userId: null };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--group' || args[i] === '-g') && args[i + 1]) {
      result.groupId = args[++i];
    } else if ((args[i] === '--user' || args[i] === '-u') && args[i + 1]) {
      result.userId = args[++i];
    } else {
      result.args.push(args[i]);
    }
  }
  // Resolve if group or user provided
  const resolved = resolveTenantFromCtx({ groupId: result.groupId, userId: result.userId });
  if (resolved) result.tenant = resolved;
  return result;
}

// ─── Commands ─────────────────────────────────────────────

async function cmdEstimate(tenant, skill, quantity = 1) {
  const result = await post('/v1/billing/estimate', {
    tenantId: tenant,
    accountId: accId(tenant),
    skillId: skill,
    quantity: Number(quantity),
    metadata: { source: 'agent_billing_cli' },
  });
  if (!result.ok) throw new Error(result.error || 'Estimate failed');
  console.log(JSON.stringify(result));
  return result;
}

async function cmdSettle(tenant, skill, eventId, quantity = 1) {
  const result = await post('/v1/billing/settle', {
    tenantId: tenant,
    accountId: accId(tenant),
    skillId: skill,
    quantity: Number(quantity),
    estimatedEventId: eventId,
    resultSummary: 'agent_skill_completed',
  });
  if (!result.ok) throw new Error(result.error || 'Settle failed');
  console.log(JSON.stringify(result));
  return result;
}

async function cmdRecord(tenant, skill, quantity = 1) {
  // Fire-and-forget 计费埋点：estimate → settle，一次性记录本次 skill 消耗。
  // 用于 agent skill 交付完成后后台异步调用，永不 throw、静默失败。
  try {
    const est = await post('/v1/billing/estimate', {
      tenantId: tenant,
      accountId: accId(tenant),
      skillId: skill,
      quantity: Number(quantity),
      metadata: { source: 'agent_billing_record' },
    });
    if (!est.ok || !est.eventId) {
      console.error(`[billing] record estimate 失败: ${est.error || 'no eventId'}`);
      return;
    }
    const settled = await post('/v1/billing/settle', {
      tenantId: tenant,
      accountId: accId(tenant),
      skillId: skill,
      quantity: Number(quantity),
      estimatedEventId: est.eventId,
      resultSummary: 'agent_skill_completed',
    });
    if (!settled.ok) console.error(`[billing] record settle 失败: ${settled.error || 'settle failed'}`);
  } catch (e) {
    console.error(`[billing] record 失败(静默): ${e.message}`);
  }
}

async function cmdCanAfford(tenant, skill, quantity = 1) {
  const result = await post('/v1/billing/can-afford', {
    accountId: accId(tenant),
    skillId: skill,
    quantity: Number(quantity),
  });
  console.log(JSON.stringify(result));
  return result;
}

async function cmdBalance(tenant) {
  const result = await get(`/v1/accounts/${accId(tenant)}/full`);
  result.balanceFormatted = fmt(result.balance);
  result.availableFormatted = fmt(result.available);
  result.lifetimeConsumedFormatted = fmt(result.lifetimeConsumed);
  console.log(JSON.stringify(result));
  return result;
}

async function cmdWrap(tenant, skill, quantity, command) {
  let estimate;
  try {
    estimate = await cmdEstimate(tenant, skill, quantity);
  } catch (e) {
    console.error(`[billing] ❌ estimate failed: ${e.message}`);
    process.exit(1);
  }

  const { eventId, estimatedCredit, skillName } = estimate;
  console.error(`[billing] ⚡ ${skillName} × ${quantity} = 预估 ${fmt(estimatedCredit)} Credit`);

  const { spawn } = await import('node:child_process');
  const [cmd, ...rest] = command;
  const child = spawn(cmd, rest, { stdio: 'inherit', shell: true });
  
  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
    child.on('error', (err) => {
      console.error(`[billing] ❌ command failed: ${err.message}`);
      resolve(1);
    });
  });

  if (exitCode !== 0) {
    console.error(`[billing] ❌ command exited ${exitCode}, 未扣费`);
    process.exit(exitCode);
  }

  try {
    const settled = await cmdSettle(tenant, skill, eventId, quantity);
    console.error(`[billing] ✅ 扣费 ${fmt(settled.actualCredit)} Credit`);
  } catch (e) {
    console.error(`[billing] ❌ settle failed: ${e.message}`);
    process.exit(1);
  }
}

async function cmdAllBalances() {
  const cfg = loadConfig();
  const allTenants = [];
  for (const [gid, tid] of Object.entries(cfg.groups)) {
    if (!allTenants.includes(tid)) allTenants.push(tid);
  }
  for (const t of cfg.tenants ? Object.keys(cfg.tenants) : []) {
    if (!allTenants.includes(t)) allTenants.push(t);
  }
  if (allTenants.length === 0) {
    console.log(JSON.stringify({ tenants: [], note: 'No tenants in billing-config.json' }));
    return;
  }
  const results = [];
  for (const t of allTenants) {
    try {
      const b = await get(`/v1/accounts/${accId(t)}/full`);
      results.push({ tenant: t, balance: b.balance, available: b.available, lifetimeConsumed: b.lifetimeConsumed, planTier: b.planTier });
    } catch (e) {
      results.push({ tenant: t, error: e.message });
    }
  }
  console.log(JSON.stringify(results));
}

async function cmdDaily(tenant, days = 30) {
  const qs = new URLSearchParams();
  if (tenant) qs.set('tenantId', tenant);
  qs.set('days', String(days));
  const rows = await get(`/v1/billing/daily-usage?${qs.toString()}`);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log(JSON.stringify({ days: [], note: '近 N 天无计费记录' }));
    return;
  }
  const summary = {
    scope: tenant ? `tenant=${tenant}` : 'all-tenants',
    days: rows.length,
    totalConsumed: rows.reduce((s, r) => s + (r.consumedSettled ?? 0), 0),
    totalLive: rows.reduce((s, r) => s + (r.consumedLive ?? 0), 0),
    totalShadow: rows.reduce((s, r) => s + (r.consumedShadow ?? 0), 0),
    totalTasks: rows.reduce((s, r) => s + (r.taskCount ?? 0), 0),
    daily: rows.map((r) => ({
      day: r.day,
      tasks: r.taskCount,
      consumed: r.consumedSettled,
      live: r.consumedLive,
      shadow: r.consumedShadow,
    })),
  };
  console.log(JSON.stringify(summary));
}

// ─── Main ─────────────────────────────────────────────────

const [, , cmd, ...rawArgs] = process.argv;

async function main() {
  const lookup = parseLookupArgs(rawArgs);
  const args = lookup.args;

  switch (cmd) {
    case 'resolve': {
      // Just resolve tenant from group/user
      const { groupId, userId } = parseLookupArgs(rawArgs);
      const tenant = resolveTenantFromCtx({ groupId, userId });
      console.log(JSON.stringify({ tenant, groupId, userId }));
      break;
    }

    case 'estimate': {
      const isLookup = !!(lookup.groupId || lookup.userId);
      let tenant, skill, quantity;
      if (isLookup) {
        tenant = lookup.tenant;
        [skill, quantity] = args;
      } else {
        [tenant, skill, quantity] = args;
      }
      if (lookup.tenant) tenant = lookup.tenant;
      if (!tenant && (lookup.groupId || lookup.userId)) {
        tenant = 'shadow';  // 未绑定 → 统一 shadow，不写原始 id 污染 tenant_id
        console.error(`[billing] ⚠️ 未绑定 ${lookup.groupId ? '群组' : '用户'} ${lookup.groupId || lookup.userId}，shadow 记录消耗（不扣费）`);
      }
      if (!tenant || !skill) { console.error('Usage: billing.mjs estimate <tenantId|--group oc_xxx> <skillId> [quantity]'); process.exit(1); }
      await cmdEstimate(tenant, skill, quantity);
      break;
    }

    case 'settle': {
      const isLookup = !!(lookup.groupId || lookup.userId);
      let tenant, skill, eventId, quantity;
      if (isLookup) {
        tenant = lookup.tenant;
        [skill, eventId, quantity] = args;
      } else {
        [tenant, skill, eventId, quantity] = args;
      }
      if (lookup.tenant) tenant = lookup.tenant;
      if (!tenant && (lookup.groupId || lookup.userId)) {
        tenant = 'shadow';  // 未绑定 → 统一 shadow，不写原始 id 污染 tenant_id
        console.error(`[billing] ⚠️ 未绑定 ${lookup.groupId ? '群组' : '用户'} ${lookup.groupId || lookup.userId}，shadow 记录消耗（不扣费）`);
      }
      if (!tenant || !skill || !eventId) { console.error('Usage: billing.mjs settle <tenantId|--group oc_xxx> <skillId> <eventId> [quantity]'); process.exit(1); }
      await cmdSettle(tenant, skill, eventId, quantity);
      break;
    }

    case 'record': {
      const isLookup = !!(lookup.groupId || lookup.userId);
      let tenant, skill, quantity;
      if (isLookup) {
        tenant = lookup.tenant;
        [skill, quantity] = args;
      } else {
        [tenant, skill, quantity] = args;
      }
      if (lookup.tenant) tenant = lookup.tenant;
      if (!tenant && (lookup.groupId || lookup.userId)) {
        tenant = 'shadow';  // 未绑定 → 统一 shadow，不写原始 id 污染 tenant_id
        console.error(`[billing] ⚠️ 未绑定 ${lookup.groupId ? '群组' : '用户'} ${lookup.groupId || lookup.userId}，shadow 记录消耗（不扣费）`);
      }
      if (!tenant || !skill) { console.error('Usage: billing.mjs record <tenantId|--group oc_xxx|--user ou_xxx> <skillId> [quantity]'); process.exit(1); }
      await cmdRecord(tenant, skill, quantity || 1);
      break;
    }

    case 'can-afford': {
      const isLookup = !!(lookup.groupId || lookup.userId);
      let tenant, skill, quantity;
      if (isLookup) {
        tenant = lookup.tenant;
        [skill, quantity] = args;
      } else {
        [tenant, skill, quantity] = args;
      }
      if (lookup.tenant) tenant = lookup.tenant;
      if (!tenant && lookup.groupId) {
        console.log(JSON.stringify({ canAfford: true, note: 'Unknown tenant, allowing execution' }));
        process.exit(0);
      }
      if (!tenant || !skill) { console.error('Usage: billing.mjs can-afford <tenantId|--group oc_xxx> <skillId> [quantity]'); process.exit(1); }
      await cmdCanAfford(tenant, skill, quantity);
      break;
    }

    case 'balance': {
      let [tenant] = args;
      if (!tenant && lookup.groupId) {
        console.log(JSON.stringify({ error: 'Unknown tenant for this group', groupId: lookup.groupId }));
        process.exit(1);
      }
      if (!tenant) { console.error('Usage: billing.mjs balance <tenantId|--group oc_xxx>'); process.exit(1); }
      await cmdBalance(tenant);
      break;
    }

    case 'all-balances': {
      await cmdAllBalances();
      break;
    }

    case 'daily': {
      const isLookup = !!(lookup.groupId || lookup.userId);
      let tenant;
      let [days] = args;
      if (isLookup) {
        tenant = lookup.tenant;
      } else {
        // 第一个参数可能是个数字（days），也可能是 tenantId
        if (args[0] && /^\d+$/.test(args[0])) {
          days = args[0];
        } else {
          tenant = args[0];
          days = args[1];
        }
      }
      if (lookup.tenant) tenant = lookup.tenant;
      await cmdDaily(tenant, days ? Number(days) : 30);
      break;
    }

    case 'wrap': {
      const dashIdx = rawArgs.indexOf('--');
      if (dashIdx < 2) { console.error('Usage: billing.mjs wrap <tenantId|--group oc_xxx> <skillId> [quantity] -- <command...>'); process.exit(1); }
      const billingArgs = rawArgs.slice(0, dashIdx);
      const command = rawArgs.slice(dashIdx + 1);
      const wrapLookup = parseLookupArgs(billingArgs);
      const isLookup = !!(wrapLookup.groupId || wrapLookup.userId);
      let tenant, skill, quantity;
      if (isLookup) {
        tenant = wrapLookup.tenant;
        [skill, quantity] = wrapLookup.args;
      } else {
        [tenant, skill, quantity] = wrapLookup.args;
      }
      if (wrapLookup.tenant) tenant = wrapLookup.tenant;
      if (!tenant && (wrapLookup.groupId || wrapLookup.userId)) {
        tenant = wrapLookup.groupId || wrapLookup.userId;
        console.error(`[billing] ⚠️ 未绑定 ${wrapLookup.groupId ? '群组' : '用户'} ${tenant}，shadow 记录消耗（不扣费）`);
      }
      if (!tenant || !skill) { console.error('Usage: billing.mjs wrap <tenantId|--group oc_xxx> <skillId> [quantity] -- <command...>'); process.exit(1); }
      await cmdWrap(tenant, skill, quantity || 1, command);
      break;
    }

    case 'register-user': {
      // billing.mjs register-user <openId ou_xxx> <tenantId> [--union-id on_xxx]
      // 可选 --union-id 预留：将来客户买专属部署（多应用）时，同一人跨应用可识别，无需回补数据。
      const pos = [];
      let unionId = null;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--union-id' && args[i + 1]) unionId = args[++i];
        else pos.push(args[i]);
      }
      const [openId, tenantId] = pos;
      if (!openId || !tenantId) {
        console.error('Usage: billing.mjs register-user <openId ou_xxx> <tenantId> [--union-id on_xxx]');
        process.exit(1);
      }
      const cfg = loadConfig();
      cfg.users = cfg.users || {};
      const prev = cfg.users[openId];
      cfg.users[openId] = unionId ? { tenant: tenantId, unionId } : tenantId;
      cfg.lastUpdated = new Date().toISOString().slice(0, 10);
      saveConfig(cfg);
      console.log(JSON.stringify({ ok: true, openId, tenantId, unionId, previous: prev ?? null }));
      break;
    }

    case 'unregister-user': {
      const [openId] = args;
      if (!openId) { console.error('Usage: billing.mjs unregister-user <openId ou_xxx>'); process.exit(1); }
      const cfg = loadConfig();
      cfg.users = cfg.users || {};
      const prev = cfg.users[openId] ?? null;
      delete cfg.users[openId];
      cfg.lastUpdated = new Date().toISOString().slice(0, 10);
      saveConfig(cfg);
      console.log(JSON.stringify({ ok: true, openId, removed: prev }));
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Commands: estimate | settle | record | can-afford | balance | all-balances | daily | wrap | resolve | register-user | unregister-user');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[billing] ❌ ${e.message}`);
  process.exit(1);
});
