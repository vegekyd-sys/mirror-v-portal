import pg from 'pg';
import type { TenantState } from '../services/state-machine.js';

/**
 * Fetch all active tenants from the provisioning registry.
 * Transforms DB columns into the TenantState shape expected by the state machine.
 */
export async function fetchTenants(pool: pg.Pool): Promise<TenantState[]> {
  const { rows } = await pool.query(`
    SELECT
      t.tenant_id,
      t.company_name,
      t.status,
      t.plan_tier,
      t.quota_credits_monthly,
      t.created_at,
      t.subscription_end,
      t.suspended_at,
      t.grace_until,
      -- Last status change per the audit log. tenants.updated_at is bumped by
      -- unrelated writes (contact writeback, credential updates, rollouts) and
      -- would silently reset grace/suspend countdowns, so it must not be used.
      (SELECT l.created_at FROM tenant_status_log l
        WHERE l.tenant_id = t.tenant_id
        ORDER BY l.created_at DESC LIMIT 1) AS last_status_change
    FROM tenants t
    WHERE t.status NOT IN ('destroyed')
    ORDER BY t.tenant_id
  `);

  const now = new Date();

  return rows.map((row: any) => {
    const statusSince = new Date(row.last_status_change ?? row.created_at);
    const daysInStatus = Math.floor((now.getTime() - statusSince.getTime()) / (1000 * 60 * 60 * 24));

    return {
      id: row.tenant_id,
      status: row.status,
      creditsBalance: 0, // filled by credits-ledger API
      monthlyAllowance: Number(row.quota_credits_monthly ?? 1_000_000),
      monthlyUsed: 0, // filled by credits-ledger API
      // NULL = no expiry configured → state machine skips expiry checks.
      subscriptionEnd: row.subscription_end ? new Date(row.subscription_end) : null,
      suspendedAt: row.suspended_at ? new Date(row.suspended_at) : null,
      graceUntil: row.grace_until ? new Date(row.grace_until) : null,
      daysInCurrentStatus: Math.max(0, daysInStatus),
      hasPaymentPending: false,
    };
  });
}
