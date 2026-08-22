/**
 * Default tenant bootstrap.
 *
 * The system always ships with one built-in "default tenant" used for
 * testing and as the first tenant on a fresh install. Guarantees:
 *
 *  - Idempotent: safe to run on every boot; creates the tenant only once.
 *  - Dependency-free: initialization needs NO external identifiers or
 *    secrets (no Feishu App ID/Secret). The tenant talks web chat only.
 *  - Fully per-tenant: the default tenant gets its OWN namespace
 *    (dealclaw-default) and a dedicated dealclaw-agent-default Deployment,
 *    provisioned through the exact same provisionTenant() path as any other
 *    tenant — no shared/central agent anymore. Its runtime config (LLM key
 *    etc.) comes from the runtime_configs table via the admin console
 *    (运行时配置), materialized as the tenant-config Secret in its namespace.
 *  - Self-heals: if the agent Deployment goes missing, the next ensure run
 *    re-provisions it. The rollout batch updater tracks this tenant like
 *    any other (k8s_namespace is set).
 */

import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { provisionTenant, tenantNamespace } from './provisioning.js';
import { createCreditsAccount } from './credits-account.js';
import { deploymentExists } from './k8s-client.js';
import { resolveTenantConfig } from './runtime-config.js';

export const DEFAULT_TENANT_ID = 'default';
export const DEFAULT_TENANT_COMPANY = '默认租户';
export const DEFAULT_TENANT_EMAIL = 'default@dealclaw.local';

export interface EnsureResult {
  action: 'created' | 'provisioned' | 'healed' | 'already_ready' | 'waiting_config' | 'failed' | 'skipped';
  status: string;
  detail?: string;
}

/**
 * Ensure the default tenant exists with its own per-tenant agent. Never
 * throws — callers run this at boot and must not crash the service.
 */
export async function ensureDefaultTenant(
  pool: pg.Pool,
  config: ProvisioningConfig,
): Promise<EnsureResult> {
  try {
    const ns = tenantNamespace(DEFAULT_TENANT_ID); // dealclaw-default
    const agentName = `dealclaw-agent-${DEFAULT_TENANT_ID}`;
    const agentEndpoint = `http://${agentName}.${ns}:18789`;

    // 1. Tenant row (idempotent insert) — per-tenant mode with its own
    //    namespace; web platform, so no nexus-gateway is deployed.
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
         VALUES ($1, $2, $3, 'web', 'starter', 'pending', $4, $5, 1, 1000000, TRUE, $6)`,
        [
          DEFAULT_TENANT_ID,
          DEFAULT_TENANT_COMPANY,
          DEFAULT_TENANT_EMAIL,
          ns,
          `acct_${DEFAULT_TENANT_ID}`,
          agentEndpoint,
        ],
      );
      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
         VALUES ($1, NULL, 'pending', 'Default tenant initialized — per-tenant agent mode')`,
        [DEFAULT_TENANT_ID],
      );
      console.log('[default-tenant] tenant row created (per-tenant agent mode)');
    } else if (rows[0].status === 'destroyed') {
      return { action: 'skipped', status: 'destroyed', detail: 'default tenant was destroyed; not re-creating' };
    } else {
      // 2. Migrate legacy rows: older versions pointed the default tenant at
      //    the central dealclaw-test agent (external mode, k8s_namespace
      //    NULL). Bring those rows onto the per-tenant layout.
      if (rows[0].k8s_namespace !== ns || rows[0].agent_endpoint !== agentEndpoint) {
        await pool.query(
          `UPDATE tenants
              SET agent_endpoint = $2,
                  k8s_namespace = $3,
                  platform = 'web',
                  status = CASE WHEN status = 'active' THEN 'pending' ELSE status END,
                  updated_at = NOW()
            WHERE tenant_id = $1 AND status <> 'destroyed'`,
          [DEFAULT_TENANT_ID, agentEndpoint, ns],
        );
        await pool.query(
          `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
           VALUES ($1, $2, 'pending', 'Migrating default tenant from central agent to per-tenant agent')`,
          [DEFAULT_TENANT_ID, rows[0].status],
        );
        console.log('[default-tenant] migrated from external-agent mode to per-tenant mode');
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

    // 4. Provision / self-heal the per-tenant agent. Dry-run mode (local
    //    dev / CI) plans resources only.
    if (config.k8sDryRun) {
      return { action: 'skipped', status: 'active', detail: `k8s dry-run mode — would provision ${agentName} in ${ns}` };
    }

    const agentExists = await deploymentExists(ns, agentName);
    if (agentExists && rows.length > 0 && rows[0].status === 'active' && rows[0].k8s_namespace === ns) {
      return { action: 'already_ready', status: 'active', detail: `agent endpoint: ${agentEndpoint}` };
    }

    // Runtime config (global defaults + tenant overrides, decrypted) is
    // required — the agent Pod cannot start without it (e.g. LLM key).
    let runtimeSecretData: Record<string, string>;
    try {
      runtimeSecretData = await resolveTenantConfig(pool, DEFAULT_TENANT_ID);
    } catch (err) {
      return {
        action: 'waiting_config',
        status: 'pending',
        detail: `runtime config unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!runtimeSecretData || Object.keys(runtimeSecretData).length === 0) {
      return {
        action: 'waiting_config',
        status: 'pending',
        detail: 'runtime config is empty — configure global defaults (e.g. DEEPSEEK_API_KEY) via the admin console (运行时配置)',
      };
    }

    await provisionTenant(
      {
        tenantId: DEFAULT_TENANT_ID,
        companyName: DEFAULT_TENANT_COMPANY,
        contactEmail: DEFAULT_TENANT_EMAIL,
        planTier: 'starter',
        quotaAgents: 1,
        quotaCreditsMonthly: 1_000_000,
        // web platform → no nexus-gateway; admin chat is proxied straight
        // to this tenant's own agent.
        platform: 'web',
      },
      {
        dryRun: false,
        runtimeNamespace: config.runtimeNamespace,
        imageRegistry: config.imageRegistry,
        nexusGatewayImageTag: config.nexusGatewayImageTag,
        dealclawAgentImageTag: config.dealclawAgentImageTag,
        agentPvcSize: config.agentPvcSize,
        agentPvcStorageClass: config.agentPvcStorageClass,
        agentPvcAccessMode: config.agentPvcAccessMode,
        runtimeSecretData,
      },
    );

    // 5. Mark active.
    await pool.query(
      `UPDATE tenants SET status = 'active', updated_at = NOW() WHERE tenant_id = $1 AND status <> 'destroyed'`,
      [DEFAULT_TENANT_ID],
    );
    await pool.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
       VALUES ($1, $2, 'active', $3)`,
      [DEFAULT_TENANT_ID, rows.length > 0 ? rows[0].status : null, agentExists ? 'agent Deployment self-healed' : 'Default tenant ready — per-tenant agent'],
    );

    return {
      action: rows.length === 0 ? 'created' : (agentExists ? 'healed' : 'provisioned'),
      status: 'active',
      detail: `agent endpoint: ${agentEndpoint}`,
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
