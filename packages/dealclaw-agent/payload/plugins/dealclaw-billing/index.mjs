/**
 * DealClaw Deterministic Billing Hook
 * ------------------------------------
 * 把「计费」从模型自觉升级为确定性触发 + 前置拦截：
 *   before_tool_call: can-afford 预检，余额不足直接 block（阻止 skill 执行）
 *   after_tool_call:  estimate → settle（真正扣费，带幂等去重）
 *
 * 触发信号（任一命中即计费，去重）：
 *   1. exec 调用 `dealclaw-billing-record.sh --group <chat_id> <skillId> [qty]`（no-op 意图信号）
 *   2. exec 运行了 billable skill 的脚本（命令路径含 `skills/dealclaw-<id>/`）
 *
 * 注意：不再匹配 `billing.mjs record/estimate` —— billing.mjs 是手动/运维工具，
 * 避免双计费或把 estimate 查询误判成计费。
 *
 * tenant 解析：优先用命令里的 --group <chat_id> 查 billing-config.json 的 groups
 * 映射；查不到则用 event.ctx.chatId；再查不到则 shadow（只记账不扣费）。
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** rev167 权威定价里的收费 skill（10 个）。免费 skill 不在此列。 */
const BILLABLE_SKILLS = new Set([
  'dealclaw-analyze-company',
  'dealclaw-market-report',
  'dealclaw-buyer-leads-push',
  'dealclaw-find-buyers',
  'dealclaw-exhibition-leads',
  'dealclaw-exhibition-invitation',
  'dealclaw-email-founder-direct',
  'dealclaw-lead-import',
  'dealclaw-email-growth-send',
  'dealclaw-smart-reply',
]);

const LEDGER = (
  process.env.DC_BILLING_URL ||
  process.env.CREDITS_LEDGER_URL ||
  process.env.DEALCLAW_CREDITS_LEDGER_URL ||
  'http://credits-ledger.dealclaw-prod:8081'
).replace(/\/$/, '');

const TOKEN = process.env.DC_BILLING_TOKEN || process.env.CREDITS_LEDGER_TOKEN || '';

// 去重：sessionKey + skillId → 最近计费时间戳。窗口内不重复计费。
const billed = new Map();
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 分钟

function loadTenantMap() {
  const candidates = [
    process.env.OPENCLAW_WORKSPACE_DIR
      ? resolve(process.env.OPENCLAW_WORKSPACE_DIR, 'scripts', 'billing-config.json')
      : null,
    resolve(__dirname, '..', '..', 'scripts', 'billing-config.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    } catch { /* try next */ }
  }
  return { groups: {}, users: {}, defaultBehavior: { unknownTenant: 'shadow' } };
}

function resolveTenant(chatId) {
  // 优先 chat_id → billing-config.json 映射（正确的多群归属，避免账户 id 串号）
  const cfg = loadTenantMap();
  if (chatId && cfg.groups && cfg.groups[chatId]) return cfg.groups[chatId];
  // 其次 per-tenant pod 兜底：DEALCLAW_TENANT_ID（仅当 chat_id 无法映射时）
  if (process.env.DEALCLAW_TENANT_ID) return process.env.DEALCLAW_TENANT_ID;
  return null;
}

/** 从 exec 命令里提取 skillId + 可能的 chat_id（--group）。 */
function detectSkill(cmd) {
  const s = String(cmd || '');

  // 1) billing-record.sh --group <chat_id> <skillId> [qty]
  //    （.sh 现在是 no-op 意图信号，插件检测到它才真正计费）
  let m = s.match(/dealclaw-billing-record\.sh\s+(?:--group\s+(\S+)\s+)?(dealclaw-[\w-]+)/);
  if (m && BILLABLE_SKILLS.has(m[2])) return { skillId: m[2], chatId: m[1] || null };

  // 2) 脚本路径 skills/dealclaw-<id>/...
  m = s.match(/skills\/dealclaw-([\w-]+)\//);
  if (m && BILLABLE_SKILLS.has(`dealclaw-${m[1]}`)) return { skillId: `dealclaw-${m[1]}`, chatId: null };

  // 注意：刻意不再匹配 billing.mjs record/estimate。
  // billing.mjs 是手动/运维工具（record 会自己 estimate→settle，estimate 只是查询）；
  // 若插件再匹配它，会导致双计费，或把 estimate 查询误判成计费。

  return null;
}

function ledgerHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  return headers;
}

/** 幂等 taskId：同 session + skill + 30min 时间桶内稳定，跨重复执行可去重。 */
function stableTaskId(tenant, skillId, sessionKey) {
  const bucket = Math.floor(Date.now() / DEDUP_WINDOW_MS);
  return `dc-hook:${tenant ?? 'shadow'}:${skillId}:${sessionKey ?? 'unknown'}:${bucket}`;
}

/**
 * 前置预检：can-afford（检查余额/订阅/月度额度）。
 * 返回 { allowed, reason }。can-afford API 故障时 fail-open（允许，settle 阶段再记账）。
 */
async function canAfford(skillId, tenant) {
  const accountId = tenant ? `acct_${tenant}` : 'acct_shadow';
  try {
    const res = await fetch(`${LEDGER}/v1/billing/can-afford`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: ledgerHeaders(),
      body: JSON.stringify({ accountId, skillId, quantity: 1 }),
    });
    if (!res.ok) {
      console.warn(`[dc-billing] can-afford returned ${res.status} — fail-open`);
      return { allowed: true, reason: null };
    }
    const data = await res.json().catch(() => ({}));
    if (data.canAfford === false) {
      return { allowed: false, reason: data.reason || 'Insufficient credits' };
    }
    return { allowed: true, reason: null };
  } catch (err) {
    console.warn(`[dc-billing] can-afford error — fail-open: ${err.message}`);
    return { allowed: true, reason: null };
  }
}

async function settle(skillId, chatId, ctxChatId, sessionKey) {
  // 去重
  const key = `${sessionKey}\u0000${skillId}`;
  const now = Date.now();
  const last = billed.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return;
  billed.set(key, now);

  const tenant = resolveTenant(chatId) || resolveTenant(ctxChatId) || null;
  const accountId = tenant ? `acct_${tenant}` : 'acct_shadow';
  const taskId = stableTaskId(tenant, skillId, sessionKey);

  try {
    // estimate
    const estRes = await fetch(`${LEDGER}/v1/billing/estimate`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: ledgerHeaders(),
      body: JSON.stringify({
        tenantId: tenant ?? 'shadow',
        accountId,
        taskId,
        skillId,
        quantity: 1,
        metadata: { source: 'dealclaw-billing-plugin', chatId: chatId || ctxChatId || null },
      }),
    });
    const est = await estRes.json().catch(() => ({}));
    if (!estRes.ok || !est.eventId) {
      console.error(`[dc-billing] estimate failed for ${skillId}: ${estRes.status} ${JSON.stringify(est)}`);
      return;
    }

    // settle
    const setRes = await fetch(`${LEDGER}/v1/billing/settle`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: ledgerHeaders(),
      body: JSON.stringify({
        tenantId: tenant ?? 'shadow',
        accountId,
        skillId,
        quantity: 1,
        estimatedEventId: est.eventId,
        resultSummary: 'agent_skill_completed',
        metadata: { source: 'dealclaw-billing-plugin', chatId: chatId || ctxChatId || null },
      }),
    });
    const set = await setRes.json().catch(() => ({}));
    if (!setRes.ok) {
      console.error(`[dc-billing] settle failed for ${skillId}: ${setRes.status} ${JSON.stringify(set)}`);
      return;
    }

    const mode = est.billingMode ?? set.billingMode ?? 'live';
    const credit = set.actualCredit ?? est.estimatedCredit ?? 0;
    console.log(`[dc-billing] ✅ ${skillId} × 1 = ${credit} credit (tenant=${tenant ?? 'shadow'}, mode=${mode})`);
  } catch (err) {
    console.error(`[dc-billing] billing error for ${skillId}: ${err.message}`);
  }
}

export default definePluginEntry({
  id: 'dealclaw-billing',
  name: 'DealClaw Deterministic Billing',
  description: 'Deterministically bills credits-ledger when a billable DealClaw skill executes (estimate→settle).',
  register(api) {
    // 前置拦截：余额不足直接 block skill 执行
    api.on('before_tool_call', async (event) => {
      if (event.toolName !== 'exec') return;
      const cmd = event.params?.command;
      if (!cmd) return;

      const hit = detectSkill(cmd);
      if (!hit) return;

      const ctx = event.ctx || {};
      const tenant = resolveTenant(hit.chatId) || resolveTenant(ctx.chatId) || null;

      // shadow 租户不拦截（无真实账户）
      if (!tenant) return;

      const check = await canAfford(hit.skillId, tenant);
      if (!check.allowed) {
        console.warn(`[dc-billing] BLOCK ${hit.skillId} for tenant=${tenant}: ${check.reason}`);
        return {
          block: true,
          blockReason: `余额不足，无法执行「${hit.skillId}」：${check.reason}`,
        };
      }
      return undefined;
    });

    // 后置结算：estimate → settle（真正扣费）
    api.on('after_tool_call', async (event) => {
      if (event.toolName !== 'exec') return;
      const cmd = event.params?.command;
      if (!cmd) return;

      const hit = detectSkill(cmd);
      if (!hit) return;

      const ctx = event.ctx || {};
      await settle(hit.skillId, hit.chatId, ctx.chatId, ctx.sessionKey || ctx.sessionId || 'unknown');
    });
  },
});
