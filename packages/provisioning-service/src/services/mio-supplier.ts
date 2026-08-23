/**
 * Per-tenant Mio CDP supplier identifier management.
 *
 * The supplier id is the credential tenant skills use when calling the Mio
 * CDP API (X-Supplier-Id / MIO_CDP_SUPPLIER_ID env var — see the _client.py
 * scripts inside dealclaw-agent payload skills). It is stored on the
 * tenants row and injected into the `dealclaw-agent-config-<tenant>` Secret
 * (envFrom of the dealclaw-agent Deployment).
 *
 * Uniqueness: one supplier id maps to one live customer — enforced both by a
 * pre-check here (friendly 409 with the conflicting tenant's name) and by the
 * partial unique index tenants_mio_supplier_uq in the DB.
 */

import type pg from 'pg';
import {
  getSecret,
  putSecret,
  restartDeployment,
} from './k8s-client.js';
import { updateSkillEnvSecret } from './skill-env.js';
import type { ProvisioningConfig } from '../config.js';

export const MIO_SUPPLIER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class MioSupplierError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MioSupplierError';
  }
}

export interface MioSupplierResult {
  ok: true;
  tenantId: string;
  supplierId: string | null;
  /** True when the tenant agent Deployment was rolled to pick up the new env. */
  restarted: boolean;
  agentSecret: string | null;
}

interface TenantRow {
  tenant_id: string;
  company_name: string | null;
  status: string;
  k8s_namespace: string | null;
  agent_endpoint: string | null;
  plan_tier: string;
  quota_credits_monthly: string;
  credits_account_id: string | null;
  mio_cdp_supplier_id: string | null;
}

/** Decode a K8s secret's base64 `data` into raw string values. */
function decodeSecretData(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    try {
      out[k] = Buffer.from(v, 'base64').toString('utf8');
    } catch {
      // keep undecodable entries as-is (shouldn't happen for stringData secrets)
      out[k] = v;
    }
  }
  return out;
}

/**
 * Set (or clear, when supplierId is empty/null) a tenant's Mio CDP supplier
 * id: DB row + agent-config Secret + agent Pod rollout.
 */
export async function updateTenantMioSupplier(
  pool: pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  supplierId: string | null | undefined,
): Promise<MioSupplierResult> {
  const trimmed = (supplierId ?? '').trim();
  if (trimmed && !MIO_SUPPLIER_ID_PATTERN.test(trimmed)) {
    throw new MioSupplierError(
      400,
      'BAD_SUPPLIER_ID',
      'Mio CDP 供应商 ID 格式不正确（1–64 位字母、数字、下划线或连字符）',
    );
  }
  const next = trimmed || null;

  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id, company_name, status, k8s_namespace, agent_endpoint,
            plan_tier, quota_credits_monthly, credits_account_id, mio_cdp_supplier_id
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    throw new MioSupplierError(404, 'NOT_FOUND', '租户不存在');
  }
  const tenant = rows[0];
  if (tenant.status === 'destroyed') {
    throw new MioSupplierError(400, 'TENANT_DESTROYED', '租户已销毁，无法修改');
  }
  if (tenant.mio_cdp_supplier_id === next) {
    // Idempotent no-op.
    return { ok: true, tenantId, supplierId: next, restarted: false, agentSecret: null };
  }

  if (next) {
    const { rows: conflicts } = await pool.query(
      `SELECT tenant_id, company_name FROM tenants
        WHERE mio_cdp_supplier_id = $1 AND tenant_id <> $2 AND status <> 'destroyed'`,
      [next, tenantId],
    );
    if (conflicts.length) {
      throw new MioSupplierError(
        409,
        'SUPPLIER_ID_TAKEN',
        `该 Mio CDP 供应商 ID 已绑定客户「${conflicts[0].company_name || conflicts[0].tenant_id}」，一个供应商 ID 只能对应一个客户`,
      );
    }
  }

  await pool.query(
    `UPDATE tenants SET mio_cdp_supplier_id = $1, updated_at = NOW() WHERE tenant_id = $2`,
    [next, tenantId],
  );

  // External-agent tenants (agent_endpoint) have no agent-config secret of
  // their own — the central agent's env is managed via ArgoCD/GitOps.
  const hasOwnAgent = Boolean(tenant.k8s_namespace) && !tenant.agent_endpoint;

  if (config.k8sDryRun || !hasOwnAgent) {
    await pool.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
       VALUES ($1, $2, $2, $3)`,
      [
        tenantId,
        tenant.status,
        hasOwnAgent
          ? `DRY_RUN: Mio CDP supplier id ${next ? `set to ${next}` : 'cleared'}`
          : `Mio CDP supplier id ${next ? `set to ${next}` : 'cleared'} (no per-tenant agent — secret not updated)`,
      ],
    );
    return { ok: true, tenantId, supplierId: next, restarted: false, agentSecret: null };
  }

  // Merge MIO_CDP_SUPPLIER_ID into the existing agent-config Secret. K8s GET
  // returns base64 data and PUT (stringData) replaces the whole content, so
  // decode → modify → put to keep the other keys (TENANT_ID, PLAN_TIER, …).
  const namespace = tenant.k8s_namespace as string;
  const agentSecretName = `dealclaw-agent-config-${tenantId}`;
  const existing = await getSecret(namespace, agentSecretName);
  const data = existing ? decodeSecretData(existing.data) : {
    DEALCLAW_TENANT_ID: tenantId,
    DEALCLAW_PLAN_TIER: tenant.plan_tier,
    DEALCLAW_INITIAL_CREDITS: String(tenant.quota_credits_monthly ?? 0),
  };
  if (next) {
    data.MIO_CDP_SUPPLIER_ID = next;
  } else {
    delete data.MIO_CDP_SUPPLIER_ID;
  }
  await putSecret(namespace, agentSecretName, data);

  // Also refresh the skill-env Secret (.env) — shell skill scripts read
  // MIO_CDP_SUPPLIER_ID from work/mio-api/.env and pick the new value up on
  // their next invocation without waiting for the rollout below.
  try {
    await updateSkillEnvSecret(pool, config, tenantId);
  } catch (err) {
    console.warn(`skill-env refresh after supplier-id update failed for ${tenantId}:`, err);
  }

  // Roll the agent Pod so the running container picks up the new env var.
  const agentDeployment = `dealclaw-agent-${tenantId}`;
  let restarted = false;
  try {
    restarted = await restartDeployment(namespace, agentDeployment);
  } catch (err: unknown) {
    const e = err as any;
    if (!/404|not found/i.test(e?.message || '')) throw err;
  }

  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [tenantId, tenant.status, `Mio CDP supplier id ${next ? `set to ${next}` : 'cleared'} — secret ${agentSecretName}${restarted ? ` updated, agent ${agentDeployment} restarted` : ' updated'}`],
  );

  return { ok: true, tenantId, supplierId: next, restarted, agentSecret: agentSecretName };
}
