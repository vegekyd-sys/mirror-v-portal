/**
 * Central test tenant adoption (dealclaw-test).
 *
 * The central nexus-gateway used to be a plain ArgoCD-managed Deployment
 * reading its Feishu credentials from the tenant-config Secret — invisible
 * to the tenant registry and to the admin console's Feishu binding feature.
 * This module adopts that legacy gateway into the tenant system:
 *
 *  1. Reads the legacy credentials (DEALCLAW_APP_ID / DEALCLAW_APP_SECRET)
 *     from the tenant-config Secret in the control-plane namespace.
 *  2. Creates the tenants row (external-agent mode — the agent stays the
 *     central dealclaw-agent owned by ArgoCD, k8s_namespace stays NULL).
 *  3. Reuses bindTenantFeishuApp() so the binding goes through the exact
 *     same path as a console-initiated bind: credentials verified against
 *     the Feishu open API, materialized as the dealclaw-bot-dealclaw-test
 *     Secret, gateway deployed as nexus-gateway-dealclaw-test.
 *
 * After adoption the old ArgoCD-managed central gateway is removed from
 * GitOps (aochi) — the console-managed gateway fully replaces it.
 *
 * Guarantees:
 *  - Idempotent: safe on every boot; adopted at most once.
 *  - Respects an explicit admin unbind: unbindTenantFeishuApp() resets
 *    platform to 'web' + clears app_id; this module treats that as "leave
 *    it alone" and never re-binds.
 *  - Self-heals: if the tenants row is bound but the gateway Deployment
 *    is missing (e.g. manually deleted), it re-deploys using the ROW's
 *    credentials — the DB, not tenant-config, is the source of truth
 *    after adoption.
 *  - Never throws: callers run this at boot.
 */

import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import { getSecret, deploymentExists } from './k8s-client.js';
import { bindTenantFeishuApp } from './feishu-binding.js';
import { createCreditsAccount } from './credits-account.js';

export const CENTRAL_TEST_TENANT_ID = 'dealclaw-test';
export const CENTRAL_TEST_COMPANY = 'DealClaw Test（中央测试租户）';
export const CENTRAL_TEST_EMAIL = 'ops@dealclaw.local';

export interface CentralTestEnsureResult {
  action:
    | 'adopted'
    | 'already_ready'
    | 'healed'
    | 'skipped'
    | 'waiting_config'
    | 'failed';
  detail?: string;
}

/** Decode a K8s secret data value (base64) to a string, null-safe. */
function decodeSecretValue(data: Record<string, string> | undefined, key: string): string | undefined {
  const raw = data?.[key];
  if (!raw) return undefined;
  try {
    const value = Buffer.from(raw, 'base64').toString('utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Legacy Feishu credentials from the central tenant-config Secret. */
async function readLegacyCredentials(
  config: ProvisioningConfig,
): Promise<{ appId: string; appSecret: string } | null> {
  const secret = await getSecret(config.runtimeNamespace, 'tenant-config');
  const appId = decodeSecretValue(secret?.data, 'DEALCLAW_APP_ID');
  const appSecret = decodeSecretValue(secret?.data, 'DEALCLAW_APP_SECRET');
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export async function ensureCentralTestTenant(
  pool: pg.Pool,
  config: ProvisioningConfig,
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<CentralTestEnsureResult> {
  try {
    if (config.k8sDryRun) {
      return { action: 'skipped', detail: 'k8s dry-run mode' };
    }

    const { rows } = await pool.query(
      'SELECT tenant_id, status, platform, app_id, app_secret FROM tenants WHERE tenant_id = $1',
      [CENTRAL_TEST_TENANT_ID],
    );

    if (rows.length > 0 && rows[0].status === 'destroyed') {
      return { action: 'skipped', detail: 'tenant destroyed; not re-creating' };
    }

    // ── Case 1: fresh adoption (no tenants row yet) ──
    if (rows.length === 0) {
      const creds = await readLegacyCredentials(config);
      if (!creds) {
        return {
          action: 'waiting_config',
          detail: 'tenant-config has no DEALCLAW_APP_ID/DEALCLAW_APP_SECRET — nothing to adopt',
        };
      }

      await pool.query(
        `INSERT INTO tenants
           (tenant_id, company_name, contact_email, platform, plan_tier, status,
            k8s_namespace, credits_account_id, quota_agents, quota_credits_monthly,
            is_default, agent_endpoint)
         VALUES ($1, $2, $3, 'feishu', 'starter', 'active', NULL, $4, 1, 1000000, FALSE, $5)`,
        [
          CENTRAL_TEST_TENANT_ID,
          CENTRAL_TEST_COMPANY,
          CENTRAL_TEST_EMAIL,
          `acct_${CENTRAL_TEST_TENANT_ID}`,
          config.defaultTenantAgentUrl,
        ],
      );
      await pool.query(
        `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
         VALUES ($1, NULL, 'active', 'Adopted legacy central test tenant (external agent mode)')`,
        [CENTRAL_TEST_TENANT_ID],
      );
      console.log('[central-test-tenant] tenant row created (external agent mode)');

      // Credits account (idempotent; acct_dealclaw-test already exists on this
      // install because the legacy gateway billed against it).
      const credits = await createCreditsAccount({
        tenantId: CENTRAL_TEST_TENANT_ID,
        companyName: CENTRAL_TEST_COMPANY,
        contactEmail: CENTRAL_TEST_EMAIL,
        planTier: 'starter',
        creditsLedgerUrl: config.creditsLedgerUrl,
        creditsLedgerToken: config.creditsLedgerToken,
      });
      if (!credits.ok) {
        return { action: 'failed', detail: `credits account: ${credits.error}` };
      }

      const bound = await bindTenantFeishuApp(pool, config, CENTRAL_TEST_TENANT_ID, creds, fetchImpl);
      return {
        action: 'adopted',
        detail: `gateway ${bound.gatewayDeployment} in ${bound.gatewayNamespace} → ${bound.agentUrl}`,
      };
    }

    const row = rows[0];

    // ── Case 2: admin explicitly unbound it — respect that, never re-bind ──
    if (!row.app_id && row.platform === 'web') {
      return { action: 'skipped', detail: 'unbound by admin; not re-binding' };
    }

    // ── Case 3: row exists but the initial bind never completed — retry ──
    if (!row.app_id) {
      const creds = await readLegacyCredentials(config);
      if (!creds) {
        return { action: 'waiting_config', detail: 'tenant-config has no legacy Feishu credentials' };
      }
      const bound = await bindTenantFeishuApp(pool, config, CENTRAL_TEST_TENANT_ID, creds, fetchImpl);
      return {
        action: 'adopted',
        detail: `gateway ${bound.gatewayDeployment} in ${bound.gatewayNamespace} → ${bound.agentUrl}`,
      };
    }

    // ── Case 4: bound — self-heal a missing gateway using the ROW's creds ──
    const gatewayName = `nexus-gateway-${CENTRAL_TEST_TENANT_ID}`;
    const gwExists = await deploymentExists(config.runtimeNamespace, gatewayName);
    if (gwExists) {
      return { action: 'already_ready' };
    }

    if (!row.app_secret) {
      return { action: 'failed', detail: 'gateway missing and row has no app_secret to re-bind with' };
    }
    const healed = await bindTenantFeishuApp(pool, config, CENTRAL_TEST_TENANT_ID, {
      appId: row.app_id,
      appSecret: row.app_secret,
    }, fetchImpl);
    return {
      action: 'healed',
      detail: `gateway ${healed.gatewayDeployment} re-deployed in ${healed.gatewayNamespace}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[central-test-tenant] ensure failed:', message);
    return { action: 'failed', detail: message };
  }
}
