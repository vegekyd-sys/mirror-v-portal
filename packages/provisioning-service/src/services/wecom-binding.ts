/**
 * WeCom (企业微信) bot binding — credential-based direct connection.
 *
 * Unlike Feishu (open-api verification) and personal WeChat (QR login), the
 * WeCom bot credentials are entered verbatim by the admin in the console. The
 * agent's `wecom-openclaw-plugin` owns the WeCom bot long connection, so the
 * credentials are materialized as the `dealclaw-wecom-<tenantId>` Secret and
 * injected via envFrom into the agent Deployment.
 *
 * The plane is strict: the WeCom plugin only runs inside the agent on the
 * OpenClaw message plane (`DEALCLAW_MESSAGE_PLANE=openclaw`). There is no
 * nexus-gateway bridge for WeCom, so binding is refused unless the tenant is
 * already on the openclaw plane — fail-closed, mirroring write-config.mjs.
 *
 * Security: `bot_id` is a non-sensitive identifier kept on the binding row for
 * display; the `secret` lives ONLY in the K8s Secret and is never written to
 * the DB. Unbinding rotates the Secret to placeholder values (rather than
 * deleting it) because the agent's envFrom still references it.
 */

import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type { ProvisioningConfig } from '../config.js';
import {
  putSecret,
  restartDeployment,
  patchDeploymentEnvVar,
  patchDeploymentEnvFromSecret,
} from './k8s-client.js';

export interface WeComBindingInfo {
  tenantId: string;
  bound: boolean;
  botId: string | null;
  status: string;
  boundAt: string | null;
  lastError: string | null;
}

export interface WeComBindResult {
  ok: true;
  tenantId: string;
  botId: string;
  /** true when the agent Deployment was rolled to activate the credentials */
  restarted: boolean;
}

export interface WeComUnbindResult {
  ok: true;
  tenantId: string;
  /** true when the agent Deployment was rolled to drop the channel */
  restarted: boolean;
}

export class WeComBindingError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'WeComBindingError';
    this.status = status;
    this.code = code;
  }
}

/** Minimal pool interface so tests can stub the DB. */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface TenantRow {
  tenant_id: string;
  status: string;
  k8s_namespace: string | null;
  message_plane: string | null;
  agent_endpoint: string | null;
}

/** Read the current WeCom binding state of a tenant (defaults to unbound). */
export async function getTenantWeComBinding(pool: Queryable, tenantId: string): Promise<WeComBindingInfo> {
  const { rows } = await pool.query(
    `SELECT tenant_id, bot_id, status, bound_at FROM wecom_bindings WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    return { tenantId, bound: false, botId: null, status: 'unbound', boundAt: null, lastError: null };
  }
  const r = rows[0];
  return {
    tenantId,
    bound: r.status === 'bound',
    botId: r.bot_id ?? null,
    status: r.status,
    boundAt: r.bound_at ?? null,
    lastError: null,
  };
}

/**
 * Bind (or re-bind) a WeCom bot to a tenant's agent. Throws WeComBindingError
 * for all user-facing failures.
 */
export async function bindTenantWeCom(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  input: { botId: string; secret: string },
  fetchImpl: FetchLike = fetch,
): Promise<WeComBindResult> {
  const botId = (input.botId || '').trim();
  const secret = (input.secret || '').trim();

  if (!botId || botId.length < 8 || botId.length > 128) {
    throw new WeComBindingError(400, 'BAD_BOT_ID', 'Bot ID 不能为空（8–128 个字符）');
  }
  if (!secret || secret.length < 8 || secret.length > 128) {
    throw new WeComBindingError(400, 'BAD_SECRET', 'Secret 不能为空（8–128 个字符）');
  }

  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id, status, k8s_namespace, message_plane, agent_endpoint
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    throw new WeComBindingError(404, 'NOT_FOUND', '租户不存在');
  }
  const tenant = rows[0];
  if (tenant.status === 'destroyed') {
    throw new WeComBindingError(400, 'TENANT_DESTROYED', '租户已销毁，无法绑定');
  }
  if (tenant.message_plane !== 'openclaw') {
    throw new WeComBindingError(
      400,
      'PLANE_NOT_OPENCLAW',
      '企业微信需 OpenClaw 直连消息面，请先在飞书绑定区切换到 OpenClaw 模式',
    );
  }

  // One WeCom bot must only be bound to one tenant — two agents holding the
  // same bot credentials would both spin up the wecom plugin and fight over
  // the bot's long connection / webhook callback.
  const { rows: conflicts } = await pool.query(
    `SELECT tenant_id FROM wecom_bindings
      WHERE bot_id = $1 AND tenant_id <> $2 AND status = 'bound'`,
    [botId, tenantId],
  );
  if (conflicts.length) {
    throw new WeComBindingError(409, 'CREDENTIAL_CONFLICT', '该企业微信机器人已绑定到其他租户，请先解绑');
  }

  const ns = tenant.k8s_namespace || config.runtimeNamespace;
  const agentName = `dealclaw-agent-${tenantId}`;
  const secretName = `dealclaw-wecom-${tenantId}`;
  const agentUrl = tenant.agent_endpoint
    ? String(tenant.agent_endpoint).replace(/\/$/, '')
    : `http://${agentName}.${tenant.k8s_namespace}:18789`;

  let restarted = false;
  if (!config.k8sDryRun) {
    // 1. Upsert the bot Secret (re-binding rotates credentials).
    await putSecret(ns, secretName, {
      DEALCLAW_WECOM_BOT_ID: botId,
      DEALCLAW_WECOM_SECRET: secret,
    });
    // 2. Ensure the agent references the Secret via envFrom (idempotent).
    await patchDeploymentEnvFromSecret(ns, agentName, secretName);
    // 3. Turn the WeCom channel switch on (write-config.mjs is fail-closed).
    await patchDeploymentEnvVar(ns, agentName, 'DEALCLAW_WECOM_BOUND', '1');
    // 4. Roll the agent — write-config.mjs reads env only at pod start.
    restarted = await restartDeployment(ns, agentName);

    // 5. Wait for /healthz (36 × 5s) so we don't report "bound" before the
    //    agent has actually booted the wecom plugin.
    const maxAttempts = 36;
    const delayMs = 5000;
    let ready = false;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const hRes = await fetchImpl(`${agentUrl}/healthz`, { signal: AbortSignal.timeout(5_000) });
        if (hRes.ok) { ready = true; break; }
      } catch { /* not ready yet */ }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!ready) {
      throw new WeComBindingError(503, 'AGENT_NOT_READY', 'Agent 重启后未就绪，请稍后重试');
    }
  }

  // Upsert the binding row: bot_id is non-sensitive and kept for display;
  // the secret never touches the DB.
  await pool.query(
    `INSERT INTO wecom_bindings (tenant_id, bot_id, status, bound_at, updated_at)
     VALUES ($1, $2, 'bound', NOW(), NOW())
     ON CONFLICT (tenant_id) DO UPDATE
       SET bot_id = $2, status = 'bound', bound_at = NOW(), unbound_at = NULL, updated_at = NOW()`,
    [tenantId, botId],
  );

  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [
      tenantId,
      tenant.status,
      config.k8sDryRun
        ? `DRY_RUN: WeCom bot bound (${botId}); agent would roll in ${ns}`
        : `WeCom bot bound: ${botId} — agent rolled in ${ns} (plane=openclaw)`,
    ],
  );

  return { ok: true, tenantId, botId, restarted };
}

/**
 * Unbind a tenant's WeCom bot. The Secret is rotated to placeholder values
 * (NOT deleted — the agent's envFrom still references it) and the agent is
 * rolled so write-config.mjs drops the wecom channel on boot. Fire-and-forget:
 * no /healthz wait, mirroring the unbind semantics of wechat-binding.
 */
export async function unbindTenantWeCom(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
): Promise<WeComUnbindResult> {
  const binding = await getTenantWeComBinding(pool, tenantId);

  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id, status, k8s_namespace, message_plane, agent_endpoint
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    throw new WeComBindingError(404, 'NOT_FOUND', '租户不存在');
  }
  const tenant = rows[0];
  if (tenant.status === 'destroyed') {
    throw new WeComBindingError(400, 'TENANT_DESTROYED', '租户已销毁');
  }
  if (!binding.bound) {
    throw new WeComBindingError(404, 'NOT_BOUND', '该租户当前未绑定企业微信');
  }

  const ns = tenant.k8s_namespace || config.runtimeNamespace;
  const agentName = `dealclaw-agent-${tenantId}`;
  const secretName = `dealclaw-wecom-${tenantId}`;

  let restarted = false;
  if (!config.k8sDryRun) {
    // Flip the channel switch off first (its env patch rolls the agent).
    await patchDeploymentEnvVar(ns, agentName, 'DEALCLAW_WECOM_BOUND', '0');
    // Rotate the Secret to placeholders — envFrom still references it, so we
    // must keep the Secret alive but strip the real credentials.
    await putSecret(ns, secretName, {
      DEALCLAW_WECOM_BOT_ID: `placeholder-${tenantId}`,
      DEALCLAW_WECOM_SECRET: uuidv4(),
    });
    restarted = await restartDeployment(ns, agentName);
  }

  await pool.query(
    `UPDATE wecom_bindings SET status = 'disabled', unbound_at = NOW(), updated_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId],
  );

  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [
      tenantId,
      tenant.status,
      `WeCom bot unbound: ${binding.botId} — agent rolled, credentials rotated to placeholder`,
    ],
  );

  return { ok: true, tenantId, restarted };
}
