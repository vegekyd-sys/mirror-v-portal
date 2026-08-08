import pg from 'pg';
import type { TenantState } from '../services/state-machine.js';

/**
 * Fetch all active tenants from the provisioning registry.
 * Transforms DB columns into the TenantState shape expected by the state machine.
 */
export async function fetchTenants(pool: pg.Pool): Promise<TenantState[]> {
  const { rows } = await pool.query(`
    SELECT
      tenant_id,
      company_name,
      status,
      plan_tier,
      quota_credits_monthly,
      created_at,
      updated_at,
      subscription_end,
      suspended_at,
      grace_until
    FROM tenants
    WHERE status NOT IN ('destroyed')
    ORDER BY tenant_id
  `);

  const now = new Date();

  return rows.map((row: any) => {
    const createdAt = new Date(row.created_at);
    const updatedAt = new Date(row.updated_at);
    const daysInStatus = Math.floor((now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));

    return {
      id: row.tenant_id,
      status: (row.status === 'pending' || row.status === 'provisioning') ? row.status : row.status,
      creditsBalance: 0, // filled by credits-ledger API
      monthlyAllowance: Number(row.quota_credits_monthly ?? 1_000_000),
      monthlyUsed: 0, // filled by credits-ledger API
      subscriptionEnd: row.subscription_end ? new Date(row.subscription_end) : new Date(now.getFullYear() + 1, 0, 1),
      suspendedAt: row.suspended_at ? new Date(row.suspended_at) : null,
      graceUntil: row.grace_until ? new Date(row.grace_until) : null,
      daysInCurrentStatus: Math.max(0, daysInStatus),
      hasPaymentPending: false,
    };
  });
}
