/**
 * Default tenant bootstrap.
 *
 * The system always ships with one built-in "default tenant" used for
 * testing and as the first tenant on a fresh install. Guarantees:
 *
 *  - Idempotent: safe to run on every boot; creates the tenant only once.
 *  - Dependency-free: initialization needs NO external identifiers or
 *    secrets (no Feishu App ID/Secret). The tenant talks web chat only.
 *  - Reuses the central agent: the default tenant does NOT get its own
 *    dealclaw-agent Deployment. Its agent_endpoint points at the central
 *    dealclaw-test agent (ArgoCD-managed, DEALCLAW_TENANT_ID=dealclaw-test)
 *    running in the control-plane namespace — the same Pod that already
 *    serves as the central test agent. Its LLM key/model come from that
 *    Deployment's tenant-config Secret; no per-tenant K8s resources are
 *    created here, so k8s_namespace stays NULL and the rollout batch
 *    updater automatically skips this tenant (ArgoCD owns its image).
 */

import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { createCreditsAccount } from './credits-account.js';

export const DEFAULT_TENANT_ID = 'default';
export const DEFAULT_TENANT_COMPANY = '默认租户';
export const DEFAULT_TENANT_EMAIL = 'default@dealclaw.local';

export interface EnsureResult {
  action: 'created' | 'provisioned' | 'already_ready' | 'waiting_config' | 'failed' | 'skipped';
  status: string;
  detail?: string;
}

/**
 * Ensure the default tenant exists and points at the central dealclaw-test
 * agent. Never throws — callers run this at boot and must not crash the
 * service.
 */
export async function ensureDefaultTenant(
  pool: pg.Pool,
  config: ProvisioningConfig,
): Promise<EnsureResult> {
  try {
    // 1. Tenant row (idempotent insert) — no k8s_namespace, agent is external.
    const { rows } = await pool.query(
      'SELECT tenant_id, status, agent_endpoint, k8s_namespace FROM tenants WHERE tenant_id = $1',
      [DEFAULT_TENANT_ID],
    );

    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO tenants
           (tenant_id, company_name, contact_email, platform, plan_tier, status,
            k8s_namespace, credits_account_id, quota_agents, quota_credits_monthly,
            is_default, agent_endpoint)
         VALUES ($1, $2, $3, 'web', 'starter', 'active', NULL, $4, 1, 1000000, TRUE, $5)`,
        [
          DEFAULT_TENANT_ID,
          DEFAULT_TENANT_COMPANY,
          DEFAULT_TENANT_EMAIL,
          `acct_${DEFAULT_TENANT_ID}`,
          config.defaultTenantAgentUrl,
        ],
      );
      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
         VALUES ($1, NULL, 'active', 'Default tenant initialized — reuses central dealclaw-test agent')`,
        [DEFAULT_TENANT_ID],
      );
      console.log('[default-tenant] tenant row created (external agent mode)');
    } else if (rows[0].status === 'destroyed') {
      return { action: 'skipped', status: 'destroyed', detail: 'default tenant was destroyed; not re-creating' };
    } else {
      // 2. Migrate legacy rows: older versions self-provisioned a
      //    dealclaw-agent-default Pod in the dealclaw-default namespace.
      //    Point the row at the central agent and drop the per-tenant
      //    namespace so the rollout updater stops tracking it.
      if (!rows[0].agent_endpoint || rows[0].k8s_namespace) {
        await pool.query(
          `UPDATE tenants
              SET agent_endpoint = $2,
                  k8s_namespace = NULL,
                  status = 'active',
                  updated_at = NOW()
            WHERE tenant_id = $1 AND status <> 'destroyed'`,
          [DEFAULT_TENANT_ID, config.defaultTenantAgentUrl],
        );
        console.log('[default-tenant] migrated to external agent mode (central dealclaw-test)');
      }
      if (rows[0].status === 'active') {
        return { action: 'already_ready', status: 'active' };
      }
    }

    // 3. Credits account (idempotent)
    const credits = await createCreditsAccount({
      tenantId: DEFAULT_TENANT_ID,
      companyName: DEFAULT_TENANT_COMPANY,
      contactEmail: DEFAULT_TENANT_EMAIL,
      planTier: 'starter',
      creditsLedgerUrl: config.creditsLedgerUrl,
      creditsLedgerToken: config.creditsLedgerToken,
    });
    if (!credits.ok) {
      return { action: 'failed', status: 'pending', detail: `credits account: ${credits.error}` };
    }

    // 4. No K8s provisioning: the agent is the central dealclaw-test
    //    Deployment owned by ArgoCD. Just make sure the row is active.
    const currentStatus = rows.length > 0 ? rows[0].status : null;
    if (currentStatus !== 'active') {
      await pool.query(
        `UPDATE tenants SET status = 'active', updated_at = NOW() WHERE tenant_id = $1`,
        [DEFAULT_TENANT_ID],
      );
      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
         VALUES ($1, $2, 'active', 'Default tenant ready — external agent (central dealclaw-test)')`,
        [DEFAULT_TENANT_ID, currentStatus],
      );
    }

    return {
      action: rows.length === 0 ? 'created' : 'provisioned',
      status: 'active',
      detail: `agent endpoint: ${config.defaultTenantAgentUrl}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[default-tenant] ensure failed:', message);
    try {
      await pool.query(
        `UPDATE tenants SET status = 'provisioning_failed', updated_at = NOW()
         WHERE tenant_id = $1 AND status NOT IN ('active', 'destroyed')`,
        [DEFAULT_TENANT_ID],
      );
    } catch { /* best effort */ }
    return { action: 'failed', status: 'provisioning_failed', detail: message };
  }
}
