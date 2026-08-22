/**
 * Default tenant bootstrap.
 *
 * The system always ships with one built-in "default tenant" used for
 * testing and as the first tenant on a fresh install. Guarantees:
 *
 *  - Idempotent: safe to run on every boot; creates the tenant only once.
 *  - Dependency-free: initialization needs NO external identifiers or
 *    secrets (no Feishu App ID/Secret). The tenant talks web chat only.
 *  - Progressive: if no LLM runtime config exists yet (e.g. a brand-new
 *    system), the tenant row + credits account are still created; K8s
 *    provisioning is deferred until the admin configures the model key
 *    (runtime config page) and this routine runs again (boot or manual).
 */

import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { createCreditsAccount } from './credits-account.js';
import { resolveTenantConfig } from './runtime-config.js';
import { provisionTenant } from './provisioning.js';

export const DEFAULT_TENANT_ID = 'default';
export const DEFAULT_TENANT_COMPANY = '默认租户';
export const DEFAULT_TENANT_EMAIL = 'default@dealclaw.local';

export interface EnsureResult {
  action: 'created' | 'provisioned' | 'already_ready' | 'waiting_config' | 'failed' | 'skipped';
  status: string;
  detail?: string;
}

/**
 * Ensure the default tenant exists and is as far along the lifecycle as
 * the current configuration allows. Never throws — callers run this at
 * boot and must not crash the service.
 */
export async function ensureDefaultTenant(
  pool: pg.Pool,
  config: ProvisioningConfig,
): Promise<EnsureResult> {
  try {
    // 1. Tenant row (idempotent insert)
    const { rows } = await pool.query(
      'SELECT tenant_id, status FROM tenants WHERE tenant_id = $1',
      [DEFAULT_TENANT_ID],
    );

    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO tenants
           (tenant_id, company_name, contact_email, platform, plan_tier, status,
            k8s_namespace, credits_account_id, quota_agents, quota_credits_monthly, is_default)
         VALUES ($1, $2, $3, 'web', 'starter', 'pending', $4, $5, 1, 1000000, TRUE)`,
        [
          DEFAULT_TENANT_ID,
          DEFAULT_TENANT_COMPANY,
          DEFAULT_TENANT_EMAIL,
          `dealclaw-${DEFAULT_TENANT_ID}`,
          `acct_${DEFAULT_TENANT_ID}`,
        ],
      );
      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
         VALUES ($1, NULL, 'pending', 'Default tenant initialized')`,
        [DEFAULT_TENANT_ID],
      );
      console.log('[default-tenant] tenant row created');
    } else if (rows[0].status === 'destroyed') {
      return { action: 'skipped', status: 'destroyed', detail: 'default tenant was destroyed; not re-creating' };
    } else if (rows[0].status === 'active') {
      return { action: 'already_ready', status: 'active' };
    }

    const currentStatus = rows.length > 0 ? rows[0].status : 'pending';

    // 2. Credits account (idempotent)
    const credits = await createCreditsAccount({
      tenantId: DEFAULT_TENANT_ID,
      companyName: DEFAULT_TENANT_COMPANY,
      contactEmail: DEFAULT_TENANT_EMAIL,
      planTier: 'starter',
      creditsLedgerUrl: config.creditsLedgerUrl,
      creditsLedgerToken: config.creditsLedgerToken,
    });
    if (!credits.ok) {
      return { action: 'failed', status: currentStatus, detail: `credits account: ${credits.error}` };
    }

    // 3. Runtime config gate — provisioning needs at least the model key.
    // Without it we stay pending and retry later (boot or manual trigger),
    // keeping initialization free of any external dependency.
    let runtimeSecretData: Record<string, string> = {};
    if (!config.k8sDryRun) {
      try {
        runtimeSecretData = await resolveTenantConfig(pool, DEFAULT_TENANT_ID);
      } catch {
        runtimeSecretData = {};
      }
    }
    if (!config.k8sDryRun && !runtimeSecretData.DEEPSEEK_API_KEY) {
      if (currentStatus !== 'pending') {
        await pool.query(
          `UPDATE tenants SET status = 'pending', updated_at = NOW() WHERE tenant_id = $1`,
          [DEFAULT_TENANT_ID],
        );
      }
      return {
        action: 'waiting_config',
        status: 'pending',
        detail: 'waiting for runtime config (DEEPSEEK_API_KEY) — configure it in 运行时配置, then retry',
      };
    }

    // 4. Provision K8s runtime (no Feishu credentials — web chat only)
    const provisionResult = await provisionTenant(
      {
        tenantId: DEFAULT_TENANT_ID,
        companyName: DEFAULT_TENANT_COMPANY,
        contactEmail: DEFAULT_TENANT_EMAIL,
        planTier: 'starter',
        quotaAgents: 1,
        quotaCreditsMonthly: 1_000_000,
        platform: 'web',
      },
      {
        dryRun: config.k8sDryRun,
        runtimeNamespace: config.runtimeNamespace,
        imageRegistry: config.imageRegistry,
        nexusGatewayImageTag: config.nexusGatewayImageTag,
        dealclawAgentImageTag: config.dealclawAgentImageTag,
        runtimeSecretData,
      },
    );

    await pool.query(
      `UPDATE tenants SET status = 'active', updated_at = NOW() WHERE tenant_id = $1`,
      [DEFAULT_TENANT_ID],
    );
    await pool.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
       VALUES ($1, $2, 'active', 'Default tenant provisioning completed')`,
      [DEFAULT_TENANT_ID, currentStatus],
    );
    console.log(`[default-tenant] provisioned in ${provisionResult.namespace}`);

    return {
      action: rows.length === 0 ? 'created' : 'provisioned',
      status: 'active',
      detail: provisionResult.warnings.join('; ') || undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[default-tenant] ensure failed:', message);
    // Record provisioning_failed so the console can surface + retry it.
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
