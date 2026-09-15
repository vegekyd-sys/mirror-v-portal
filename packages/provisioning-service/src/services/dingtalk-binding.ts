/**
 * DingTalk (钉钉) bot binding — credential-based direct connection.
 *
 * Symmetric with the WeCom binding (see wecom-binding.ts): the admin enters
 * the DingTalk robot's Client ID + Client Secret verbatim, which are
 * materialized as the `dealclaw-dingtalk-<tenantId>` Secret and injected via
 * envFrom into the agent Deployment. The agent's `dingtalk-connector` plugin
 * owns the DingTalk bot connection.
 *
 * Same fail-closed plane rule: the DingTalk connector only runs inside the
 * agent on the OpenClaw message plane (`DEALCLAW_MESSAGE_PLANE=openclaw`).
 * There is no nexus-gateway bridge for DingTalk, so binding is refused unless
 * the tenant is already on the openclaw plane.
 *
 * Security: `client_id` is a non-sensitive identifier kept on the binding row
 * for display; the `clientSecret` lives ONLY in the K8s Secret and is never
 * written to the DB. Unbinding rotates the Secret to placeholders.
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

export interface DingTalkBindingInfo {
  tenantId: string;
  bound: boolean;
  clientId: string | null;
  status: string;
  boundAt: string | null;
  lastError: string | null;
}

export interface DingTalkBindResult {
  ok: true;
  tenantId: string;
  clientId: string;
  /** true when the agent Deployment was rolled to activate the credentials */
  restarted: boolean;
}

export interface DingTalkUnbindResult {
  ok: true;
  tenantId: string;
  /** true when the agent Deployment was rolled to drop the channel */
  restarted: boolean;
}

export class DingTalkBindingError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DingTalkBindingError';
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

/** Read the current DingTalk binding state of a tenant (defaults to unbound). */
export async function getTenantDingTalkBinding(pool: Queryable, tenantId: string): Promise<DingTalkBindingInfo> {
  const { rows } = await pool.query(
    `SELECT tenant_id, client_id, status, bound_at FROM dingtalk_bindings WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    return { tenantId, bound: false, clientId: null, status: 'unbound', boundAt: null, lastError: null };
  }
  const r = rows[0];
  return {
    tenantId,
    bound: r.status === 'bound',
    clientId: r.client_id ?? null,
    status: r.status,
    boundAt: r.bound_at ?? null,
    lastError: null,
  };
}

/**
 * Bind (or re-bind) a DingTalk bot to a tenant's agent. Throws
 * DingTalkBindingError for all user-facing failures.
 */
export async function bindTenantDingTalk(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  input: { clientId: string; clientSecret: string },
  fetchImpl: FetchLike = fetch,
): Promise<DingTalkBindResult> {
  const clientId = (input.clientId || '').trim();
  const clientSecret = (input.clientSecret || '').trim();

  if (!clientId || clientId.length < 8 || clientId.length > 128) {
    throw new DingTalkBindingError(400, 'BAD_CLIENT_ID', 'Client ID 不能为空（8–128 个字符）');
  }
  if (!clientSecret || clientSecret.length < 8 || clientSecret.length > 128) {
    throw new DingTalkBindingError(400, 'BAD_CLIENT_SECRET', 'Client Secret 不能为空（8–128 个字符）');
  }

  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id, status, k8s_namespace, message_plane, agent_endpoint
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    throw new DingTalkBindingError(404, 'NOT_FOUND', '租户不存在');
  }
  const tenant = rows[0];
  if (tenant.status === 'destroyed') {
    throw new DingTalkBindingError(400, 'TENANT_DESTROYED', '租户已销毁，无法绑定');
  }
  if (tenant.message_plane !== 'openclaw') {
    throw new DingTalkBindingError(
      400,
      'PLANE_NOT_OPENCLAW',
      '钉钉需 OpenClaw 直连消息面，请先在飞书绑定区切换到 OpenClaw 模式',
    );
  }

  // One DingTalk bot must only be bound to one tenant — two agents holding
  // the same bot credentials would both spin up the dingtalk connector and
  // fight over the bot's long connection / webhook callback.
  const { rows: conflicts } = await pool.query(
    `SELECT tenant_id FROM dingtalk_bindings
      WHERE client_id = $1 AND tenant_id <> $2 AND status = 'bound'`,
    [clientId, tenantId],
  );
  if (conflicts.length) {
    throw new DingTalkBindingError(409, 'CREDENTIAL_CONFLICT', '该钉钉机器人已绑定到其他租户，请先解绑');
  }

  const ns = tenant.k8s_namespace || config.runtimeNamespace;
  const agentName = `dealclaw-agent-${tenantId}`;
  const secretName = `dealclaw-dingtalk-${tenantId}`;
  const agentUrl = tenant.agent_endpoint
    ? String(tenant.agent_endpoint).replace(/\/$/, '')
    : `http://${agentName}.${tenant.k8s_namespace}:18789`;

  let restarted = false;
  if (!config.k8sDryRun) {
    // 1. Upsert the bot Secret (re-binding rotates credentials).
    await putSecret(ns, secretName, {
      DEALCLAW_DINGTALK_CLIENT_ID: clientId,
      DEALCLAW_DINGTALK_CLIENT_SECRET: clientSecret,
    });
    // 2. Ensure the agent references the Secret via envFrom (idempotent).
    await patchDeploymentEnvFromSecret(ns, agentName, secretName);
    // 3. Turn the DingTalk channel switch on (write-config.mjs is fail-closed).
    await patchDeploymentEnvVar(ns, agentName, 'DEALCLAW_DINGTALK_BOUND', '1');
    // 4. Roll the agent — write-config.mjs reads env only at pod start.
    restarted = await restartDeployment(ns, agentName);

    // 5. Wait for /healthz (36 × 5s) so we don't report "bound" before the
    //    agent has actually booted the dingtalk connector.
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
      throw new DingTalkBindingError(503, 'AGENT_NOT_READY', 'Agent 重启后未就绪，请稍后重试');
    }
  }

  // Upsert the binding row: client_id is non-sensitive and kept for display;
  // the clientSecret never touches the DB.
  await pool.query(
    `INSERT INTO dingtalk_bindings (tenant_id, client_id, status, bound_at, updated_at)
     VALUES ($1, $2, 'bound', NOW(), NOW())
     ON CONFLICT (tenant_id) DO UPDATE
       SET client_id = $2, status = 'bound', bound_at = NOW(), unbound_at = NULL, updated_at = NOW()`,
    [tenantId, clientId],
  );

  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [
      tenantId,
      tenant.status,
      config.k8sDryRun
        ? `DRY_RUN: DingTalk bot bound (${clientId}); agent would roll in ${ns}`
        : `DingTalk bot bound: ${clientId} — agent rolled in ${ns} (plane=openclaw)`,
    ],
  );

  return { ok: true, tenantId, clientId, restarted };
}

/**
 * Unbind a tenant's DingTalk bot. The Secret is rotated to placeholder values
 * (NOT deleted — the agent's envFrom still references it) and the agent is
 * rolled so write-config.mjs drops the dingtalk channel on boot.
 * Fire-and-forget: no /healthz wait.
 */
export async function unbindTenantDingTalk(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
): Promise<DingTalkUnbindResult> {
  const binding = await getTenantDingTalkBinding(pool, tenantId);

  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id, status, k8s_namespace, message_plane, agent_endpoint
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    throw new DingTalkBindingError(404, 'NOT_FOUND', '租户不存在');
  }
  const tenant = rows[0];
  if (tenant.status === 'destroyed') {
    throw new DingTalkBindingError(400, 'TENANT_DESTROYED', '租户已销毁');
  }
  if (!binding.bound) {
    throw new DingTalkBindingError(404, 'NOT_BOUND', '该租户当前未绑定钉钉');
  }

  const ns = tenant.k8s_namespace || config.runtimeNamespace;
  const agentName = `dealclaw-agent-${tenantId}`;
  const secretName = `dealclaw-dingtalk-${tenantId}`;

  let restarted = false;
  if (!config.k8sDryRun) {
    // Flip the channel switch off first (its env patch rolls the agent).
    await patchDeploymentEnvVar(ns, agentName, 'DEALCLAW_DINGTALK_BOUND', '0');
    // Rotate the Secret to placeholders — envFrom still references it, so we
    // must keep the Secret alive but strip the real credentials.
    await putSecret(ns, secretName, {
      DEALCLAW_DINGTALK_CLIENT_ID: `placeholder-${tenantId}`,
      DEALCLAW_DINGTALK_CLIENT_SECRET: uuidv4(),
    });
    restarted = await restartDeployment(ns, agentName);
  }

  await pool.query(
    `UPDATE dingtalk_bindings SET status = 'disabled', unbound_at = NOW(), updated_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId],
  );

  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [
      tenantId,
      tenant.status,
      `DingTalk bot unbound: ${binding.clientId} — agent rolled, credentials rotated to placeholder`,
    ],
  );

  return { ok: true, tenantId, restarted };
}
