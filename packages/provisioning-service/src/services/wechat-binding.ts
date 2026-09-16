/**
 * WeChat (personal WeChat) binding — admin-console counterpart of the
 * Feishu binding, adapted for QR-login-based personal WeChat accounts.
 *
 * Key differences from Feishu binding:
 *  1. Credentials are NOT appId/appSecret — they are a bot_token obtained
 *     via QR scan. The scan MUST run inside the Agent Pod (plugin's auth.login
 *     lives in the gateway process context). So provisioning delegates to
 *     the Agent's internal /internal/wechat/login/* endpoints.
 *  2. The token is persisted by the plugin into the PVC state directory,
 *     NOT in tenants.app_secret or a K8s Secret. This table only tracks
 *     binding status + account_id.
 *  3. Unbinding clears the account files from the PVC (via the Agent bridge)
 *     and restarts the agent so the plugin drops its monitor.
 *  4. The gateway is kept (LLM egress proxy) — same as Feishu unbind.
 */

import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { restartDeployment, patchDeploymentEnvVar } from './k8s-client.js';

export interface WeChatBindingInfo {
  tenantId: string;
  bound: boolean;
  accountId: string | null;
  weixinUserId: string | null;
  status: string;
  boundAt: string | null;
  lastError: string | null;
}

export interface WeChatBindingError extends Error {
  status: number;
  code: string;
}

export class WeChatBindingError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'WeChatBindingError';
    this.status = status;
    this.code = code;
  }
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface TenantRow {
  tenant_id: string;
  status: string;
  k8s_namespace: string | null;
  agent_endpoint: string | null;
  message_plane: string | null;
}

// 扫码会话的硬 deadline 是 Agent bridge 的 LOGIN_WAIT_TIMEOUT_MS（8 分钟）。
// 这里额外留 2 分钟余量，用于吸收时钟偏差与最后一次状态轮询的传播延迟。
const VALIDATING_TTL_MS = 10 * 60_000;

/**
 * Read the current WeChat binding state of a tenant.
 *
 * 惰性过期（lazy expiry）：如果 DB 里残留 `validating` 且超过 TTL（例如管理员
 * 发起扫码后未点「关闭」而是直接关闭页面/浏览器，导致 cancel 请求未发出），
 * 这里会在读取时自动回退为 `unbound`，避免「扫码中…」badge 与按钮永久卡死。
 */
export async function getTenantWeChatBinding(pool: Queryable, tenantId: string): Promise<WeChatBindingInfo | null> {
  const { rows } = await pool.query(
    `SELECT tenant_id, account_id, weixin_user_id, status, bound_at, last_error, updated_at
       FROM wechat_bindings WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  );
  if (!rows.length) {
    return unboundInfo(tenantId);
  }
  const r = rows[0];

  if (r.status === 'validating') {
    const updatedAt = r.updated_at ? new Date(r.updated_at).getTime() : 0;
    const stale = !updatedAt || Date.now() - updatedAt > VALIDATING_TTL_MS;
    if (stale) {
      await pool.query(
        `UPDATE wechat_bindings
           SET status = 'unbound', session_id = NULL, last_error = '扫码会话超时自动失效',
               updated_at = NOW()
         WHERE tenant_id = $1 AND status = 'validating'`,
        [tenantId],
      );
      return unboundInfo(tenantId);
    }
  }

  return {
    tenantId,
    bound: r.status === 'active' || r.status === 'bound',
    accountId: r.account_id ?? null,
    weixinUserId: r.weixin_user_id ?? null,
    status: r.status,
    boundAt: r.bound_at ?? null,
    lastError: r.last_error ?? null,
  };
}

function unboundInfo(tenantId: string): WeChatBindingInfo {
  return {
    tenantId,
    bound: false,
    accountId: null,
    weixinUserId: null,
    status: 'unbound',
    boundAt: null,
    lastError: null,
  };
}

/**
 * Start a WeChat QR-login session. Delegates to the Agent's internal bridge.
 * Returns the QR code URL for the admin console to display.
 */
export async function startWeChatLogin(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ sessionId: string; qrcodeUrl: string; expiresAt: string }> {
  const tenant = await getTenantRow(pool, tenantId);
  if (tenant.status === 'destroyed') {
    throw new WeChatBindingError(400, 'TENANT_DESTROYED', '租户已销毁，无法绑定');
  }

  // Check existing active binding
  const existing = await getTenantWeChatBinding(pool, tenantId);
  if (existing && existing.bound) {
    throw new WeChatBindingError(409, 'ALREADY_BOUND', '该租户已绑定微信，请先解绑');
  }
  if (existing && existing.status === 'validating') {
    throw new WeChatBindingError(409, 'SESSION_ACTIVE', '已有进行中的扫码会话');
  }

  // Resolve agent URL
  const { agentUrl, gatewayNs, agentName } = resolveAgentEndpoints(config, tenant);

  // ── Phase 1: Prepare the agent ─────────────────────────────────────
  // The agent must have DEALCLAW_WECHAT_BOUND=1 in its env so that:
  //  - entrypoint.sh runs ensure_wechat_trusted (installs the plugin)
  //  - write-config.mjs generates channels["openclaw-weixin"] + plugin entries
  // Patch the env and restart the agent (scale-0-then-1). If the env is
  // already set, the restart is a no-op skip.
  if (!config.k8sDryRun && tenant.k8s_namespace) {
    const patched = await patchDeploymentEnvVar(gatewayNs, agentName, 'DEALCLAW_WECHAT_BOUND', '1');
    if (patched) {
      // Env changed → wait for agent to come back up (write-config + plugin install)
      await restartDeployment(gatewayNs, agentName);
      // Wait for /healthz (max ~3 min for plugin install + gateway start)
      const maxAttempts = 36;
      const delayMs = 5000;
      let ready = false;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const hRes = await fetchImpl(`${agentUrl}/healthz`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (hRes.ok) { ready = true; break; }
        } catch { /* not ready yet */ }
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (!ready) {
        throw new WeChatBindingError(503, 'AGENT_NOT_READY', 'Agent 重启后未就绪，请稍后重试');
      }
    }
  }

  // ── Phase 2: Start QR login via the Agent bridge ──────────────────
  // Call Agent bridge: POST /internal/wechat/login/start
  const bridgeUrl = `${agentUrl}/internal/wechat/login/start`;
  let res: Response;
  try {
    res = await fetchImpl(bridgeUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PROVISIONING_API_TOKEN || ''}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: unknown) {
    const e = err as Error;
    throw new WeChatBindingError(502, 'AGENT_UNREACHABLE', `无法连接 Agent 执行扫码：${e?.message || err}（请确认 Agent 正在运行）`);
  }

  const body = await res.json().catch(() => ({} as any));
  if (!res.ok) {
    throw new WeChatBindingError(res.status, body?.code || 'AGENT_ERROR', body?.message || `Agent 返回 HTTP ${res.status}`);
  }

  // Persist session
  await pool.query(
    `INSERT INTO wechat_bindings (tenant_id, status, session_id, last_error)
     VALUES ($1, 'validating', $2, NULL)
     ON CONFLICT (tenant_id) DO UPDATE
       SET status = 'validating', session_id = $2, last_error = NULL,
           updated_at = NOW()`,
    [tenantId, body.sessionId],
  );

  return {
    sessionId: body.sessionId,
    qrcodeUrl: body.qrcodeUrl,
    expiresAt: body.expiresAt,
  };
}

/**
 * Poll the WeChat login status from the Agent bridge.
 */
export async function getWeChatLoginStatus(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  sessionId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{
  status: string;
  message: string;
  accountId?: string;
  weixinUserId?: string;
  qrcodeUrl?: string;
  error?: string;
}> {
  const tenant = await getTenantRow(pool, tenantId);
  const { agentUrl } = resolveAgentEndpoints(config, tenant);

  const bridgeUrl = `${agentUrl}/internal/wechat/login/status/${sessionId}`;
  let res: Response;
  try {
    res = await fetchImpl(bridgeUrl, {
      headers: { 'Authorization': `Bearer ${process.env.PROVISIONING_API_TOKEN || ''}` },
      signal: AbortSignal.timeout(40_000), // long-poll friendly
    });
  } catch (err: unknown) {
    const e = err as Error;
    throw new WeChatBindingError(502, 'AGENT_UNREACHABLE', `无法查询扫码状态：${e?.message || err}`);
  }

  const body = await res.json().catch(() => ({} as any));
  if (!res.ok) {
    throw new WeChatBindingError(res.status, body?.code || 'AGENT_ERROR', body?.message || `Agent 返回 HTTP ${res.status}`);
  }

  // If completed, persist the binding
  if (body.status === 'completed' && body.accountId) {
    await pool.query(
      `UPDATE wechat_bindings
         SET status = 'bound', account_id = $1, weixin_user_id = $2,
             bound_at = NOW(), session_id = NULL, last_error = NULL,
             updated_at = NOW()
       WHERE tenant_id = $3 AND session_id = $4`,
      [body.accountId, body.weixinUserId, tenantId, sessionId],
    );

    // Check if agent is healthy (channel started) → mark active
    try {
      const healthRes = await fetchImpl(`${agentUrl}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (healthRes.ok) {
        await pool.query(
          `UPDATE wechat_bindings SET status = 'active', updated_at = NOW()
           WHERE tenant_id = $1 AND account_id = $2`,
          [tenantId, body.accountId],
        );
      }
    } catch {
      // Agent not ready yet — stays 'bound', will be marked active on next poll
    }

    await pool.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
       VALUES ($1, $2, $2, $3)`,
      [tenantId, tenant.status, `WeChat bound: account=${body.accountId} — agent bridge confirmed login`],
    );
  }

  return {
    status: body.status,
    message: body.message,
    accountId: body.accountId,
    weixinUserId: body.weixinUserId,
    qrcodeUrl: body.qrcodeUrl,
    error: body.error,
  };
}

/**
 * Cancel a pending WeChat login session.
 */
export async function cancelWeChatLogin(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  sessionId: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const tenant = await getTenantRow(pool, tenantId);
  const { agentUrl } = resolveAgentEndpoints(config, tenant);

  try {
    await fetchImpl(`${agentUrl}/internal/wechat/login/cancel/${sessionId}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.PROVISIONING_API_TOKEN || ''}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Best-effort cancel — the session will expire on the Agent side
  }

  await pool.query(
    `UPDATE wechat_bindings SET status = 'unbound', session_id = NULL, updated_at = NOW()
     WHERE tenant_id = $1 AND session_id = $2`,
    [tenantId, sessionId],
  );
}

/**
 * Unbind a tenant's WeChat account. Clears the account files from the Agent
 * PVC and restarts the agent so the plugin drops its monitor.
 * The gateway is KEPT (LLM egress proxy) — same as Feishu unbind.
 */
export async function unbindTenantWeChat(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true; restarted: boolean }> {
  const tenant = await getTenantRow(pool, tenantId);
  if (tenant.status === 'destroyed') {
    throw new WeChatBindingError(400, 'TENANT_DESTROYED', '租户已销毁');
  }

  const binding = await getTenantWeChatBinding(pool, tenantId);
  if (!binding || (!binding.bound && binding.status !== 'active' && binding.status !== 'bound')) {
    throw new WeChatBindingError(404, 'NOT_BOUND', '该租户当前未绑定微信');
  }

  const { agentUrl, gatewayNs, agentName } = resolveAgentEndpoints(config, tenant);

  await pool.query(
    `UPDATE wechat_bindings SET status = 'disabling', updated_at = NOW()
     WHERE tenant_id = $1 AND status IN ('bound','active')`,
    [tenantId],
  );

  // Call Agent bridge to clear account files
  if (binding.accountId) {
    try {
      await fetchImpl(`${agentUrl}/internal/wechat/unbind`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.PROVISIONING_API_TOKEN || ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ accountId: binding.accountId }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.warn('[wechat-binding] agent unbind call failed (will still restart):', String(err));
    }
  }

  // Restart agent (scale-0-then-1) so the plugin reloads without the account
  let restarted = false;
  if (!config.k8sDryRun && tenant.k8s_namespace) {
    restarted = await restartDeployment(gatewayNs, agentName);
  }

  await pool.query(
    `UPDATE wechat_bindings
       SET status = 'disabled', unbound_at = NOW(), updated_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId],
  );

  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [tenantId, tenant.status, `WeChat unbound: account=${binding.accountId} — agent restarted, gateway kept as LLM egress proxy`],
  );

  return { ok: true, restarted };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getTenantRow(pool: Queryable, tenantId: string): Promise<TenantRow> {
  const { rows } = await pool.query(
    `SELECT tenant_id, status, k8s_namespace, agent_endpoint, message_plane
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  ) as { rows: TenantRow[] };
  if (!rows.length) {
    throw new WeChatBindingError(404, 'NOT_FOUND', '租户不存在');
  }
  return rows[0];
}

function resolveAgentEndpoints(
  config: ProvisioningConfig,
  tenant: TenantRow,
): { agentUrl: string; gatewayNs: string; agentName: string } {
  const gatewayNs = tenant.k8s_namespace || config.runtimeNamespace;
  const agentName = `dealclaw-agent-${tenant.tenant_id}`;
  const agentUrl = tenant.agent_endpoint
    ? String(tenant.agent_endpoint).replace(/\/$/, '')
    : `http://${agentName}.${tenant.k8s_namespace}:18789`;
  return { agentUrl, gatewayNs, agentName };
}
