import pg from 'pg';
import { fetchTenants } from '../db/query.js';
import { enrichWithCredits } from './credits-check.js';
import { computeTransition, type TenantState, type TransitionResult } from './state-machine.js';
import { executeActions } from './actions.js';
import type { OpsConfig } from '../config.js';

export interface CronResult {
  timestamp: string;
  scanned: number;
  transitions: TransitionResult[];
  errors: string[];
  durationMs: number;
}

/**
 * Full cron cycle: fetch tenants → enrich credits → compute transitions →
 * execute actions → write back status to DB.
 */
export async function runCronCycle(
  pool: pg.Pool,
  config: OpsConfig,
): Promise<CronResult> {
  const start = Date.now();
  const errors: string[] = [];

  try {
    // 1. Fetch tenants from provisioning DB
    const tenants = await fetchTenants(pool);

    // 2. Enrich with real credits balances
    if (tenants.length > 0) {
      const creditsMap = await enrichWithCredits(
        config.creditsLedgerUrl,
        tenants.map(t => t.id),
        config.creditsLedgerToken,
      );
      for (const t of tenants) {
        const info = creditsMap.get(t.id);
        if (info) {
          t.creditsBalance = info.balance;
          t.monthlyUsed = info.monthlyUsed;
          t.monthlyAllowance = info.monthlyAllowance || t.monthlyAllowance;
        }
      }
    }

    // 3. Compute transitions, execute actions, write back DB
    const transitions: TransitionResult[] = [];
    for (const tenant of tenants) {
      try {
        const result = computeTransition(tenant);
        if (!result) continue;

        transitions.push(result);

        // Execute actions (notifications, pod operations)
        const actionResults = await executeActions(tenant.id, result.actions, config, pool);

        // Write back status change to DB
        if (result.from !== result.to) {
          await writeTenantStatus(pool, tenant.id, result, actionResults);
        }
      } catch (err: any) {
        errors.push(`Tenant ${tenant.id}: ${err.message}`);
      }
    }

    return {
      timestamp: new Date().toISOString(),
      scanned: tenants.length,
      transitions,
      errors,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    errors.push(`Cron cycle failed: ${err.message}`);
    return {
      timestamp: new Date().toISOString(),
      scanned: 0,
      transitions: [],
      errors,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Update tenant status in provisioning DB and record the transition log.
 * Sets timestamp columns (suspended_at, grace_until) as appropriate.
 */
async function writeTenantStatus(
  pool: pg.Pool,
  tenantId: string,
  transition: TransitionResult,
  actionResults: string[],
): Promise<void> {
  const now = new Date();
  const reason = `${transition.reason} | actions: ${actionResults.join(', ') || 'none'}`;

  // Build SET clause with timestamp columns
  const setClauses: string[] = ['status = $1', 'updated_at = $2'];
  const params: any[] = [transition.to, now];
  let paramIdx = 3;

  if (transition.to === 'suspended') {
    setClauses.push(`suspended_at = $${paramIdx++}`);
    params.push(now);
  }
  if (transition.to === 'grace') {
    const graceUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    setClauses.push(`grace_until = $${paramIdx++}`);
    params.push(graceUntil);
  }

  params.push(tenantId);
  await pool.query(
    `UPDATE tenants SET ${setClauses.join(', ')} WHERE tenant_id = $${paramIdx}`,
    params,
  );

  // Record status log
  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, transition.from, transition.to, reason],
  );

  console.log(JSON.stringify({
    level: 'info',
    action: 'status_writeback',
    tenantId,
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
  }));
}
