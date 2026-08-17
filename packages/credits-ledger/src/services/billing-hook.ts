import { randomUUID } from 'node:crypto';
import { getPool, query } from '../db/pool.js';
import { getSkillPrice } from './skill-pricing.js';
import { debit } from './account.js';

export interface BillableAction {
  tenantId: string;
  accountId: string;          // credits_accounts.id
  taskId?: string;
  skillId: string;
  quantity: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface BillingResult {
  ok: boolean;
  eventId?: string;
  estimatedCredit?: number;
  actualCredit?: number;
  billingMode?: 'live' | 'shadow' | 'unapproved';
  skillName?: string;
  unitPrice?: number;
  isDefault?: boolean;
  transactionId?: string;
  error?: string;
  code?: string;
}

/**
 * Phase 1: Estimate — calculate expected credit before execution.
 * No balance change. Returns cost estimate.
 */
export async function estimateBilling(action: BillableAction): Promise<BillingResult> {
  try {
    const price = await getSkillPrice(action.skillId);
    if (!price) return { ok: false, error: `Unknown skill: ${action.skillId}`, code: 'UNKNOWN_SKILL' };

    const totalCredit = price.creditPerUnit * action.quantity;
    const billingMode = price.pricingStatus; // 'live' or 'shadow'
    const eventId = randomUUID();

    await query(
      `INSERT INTO skill_billing_events (id, tenant_id, task_id, skill_id, skill_name, quantity, credit_amount, unit_price, status, billing_mode, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'estimated', $9, $10)
       ON CONFLICT DO NOTHING`,
      [eventId, action.tenantId, action.taskId ?? null, action.skillId, price.skillName,
       action.quantity, totalCredit, price.creditPerUnit, billingMode, JSON.stringify(action.metadata ?? {})]
    );

    return {
      ok: true,
      eventId,
      estimatedCredit: totalCredit,
      billingMode: billingMode,
      skillName: price.skillName,
      unitPrice: price.creditPerUnit,
      isDefault: price.isDefault,
    };
  } catch (err) {
    console.error('[billing-hook] estimate failed:', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Phase 2: Execute & Settle — debit credits and record the settlement.
 * This is the core hook that wraps skill execution.
 *
 * Usage pattern (inside Agent):
 *   1. Call estimateBilling() to show user cost before execution
 *   2. Execute the skill
 *   3. Call settleBilling() to actually deduct credits
 */
export async function settleBilling(action: BillableAction & {
  estimatedEventId: string;
  resultSummary?: string;
}): Promise<BillingResult> {
  const { tenantId, accountId, skillId, quantity, taskId, estimatedEventId, resultSummary } = action;

  try {
    const price = await getSkillPrice(skillId);
    if (!price) return { ok: false, error: `Unknown skill: ${skillId}`, code: 'UNKNOWN_SKILL' };

    const totalCredit = price.creditPerUnit * quantity;

    // ── Shadow / unapproved billing: update event only, NO debit ──
    if (price.pricingStatus === 'shadow' || price.pricingStatus === 'unapproved') {
      await query(
        `UPDATE skill_billing_events
         SET status = 'settled',
             billing_mode = 'shadow',
             credit_amount = $1,
             result_summary = $2
         WHERE id = $3`,
        [totalCredit, resultSummary ?? null, estimatedEventId]
      );

      return {
        ok: true,
        eventId: estimatedEventId,
        actualCredit: 0, // shadow — no actual charge
        estimatedCredit: totalCredit,
        billingMode: 'shadow',
        skillName: price.skillName,
        unitPrice: price.creditPerUnit,
        isDefault: price.isDefault,
      };
    }

    // ── Live billing: debit credits normally ──
    const idempotencyKey = action.idempotencyKey ??
      `${accountId}_settle_${estimatedEventId}`;

    // Check subscription expiration and monthly allowance before debiting
    const pool = getPool();
    const { rows: acctRows } = await pool.query(
      `SELECT status, subscription_end, monthly_allowance, monthly_used FROM credits_accounts WHERE id = $1`,
      [accountId]
    );
    if (acctRows.length === 0) {
      return { ok: false, code: 'ACCOUNT_NOT_FOUND', error: 'Account not found' };
    }
    const acct = acctRows[0];

    if (acct.status === 'suspended' || acct.status === 'closed') {
      return {
        ok: false,
        code: 'ACCOUNT_SUSPENDED',
        error: `Account is ${acct.status}`,
        estimatedCredit: totalCredit,
      };
    }

    if (acct.subscription_end) {
      const now = new Date();
      const endDate = new Date(acct.subscription_end);
      if (endDate < now) {
        return {
          ok: false,
          code: 'SUBSCRIPTION_EXPIRED',
          error: `Subscription expired on ${endDate.toLocaleDateString('zh-CN')}`,
          estimatedCredit: totalCredit,
        };
      }
    }

    if (acct.monthly_allowance > 0 && Number(acct.monthly_used) >= Number(acct.monthly_allowance)) {
      return {
        ok: false,
        code: 'MONTHLY_LIMIT_EXCEEDED',
        error: `Monthly allowance of ${Number(acct.monthly_allowance).toLocaleString()} exhausted`,
        estimatedCredit: totalCredit,
      };
    }

    // Atomic debit from credits account
    const debitResult = await debit({
      accountId,
      amount: totalCredit,
      reference: `skill:${skillId}${taskId ? `|task:${taskId}` : ''}`,
      description: `${price.skillName} × ${quantity}`,
      category: `skill.${price.category}`,
      idempotencyKey,
    });

    if (!debitResult.ok) {
      // Insufficient credits or other debit failure
      return {
        ok: false,
        code: debitResult.code,
        error: debitResult.code === 'INSUFFICIENT_CREDITS'
          ? `余额不足：需要 ${totalCredit} Credit`
          : debitResult.code === 'MONTHLY_LIMIT_EXCEEDED'
            ? '月额度已用完'
            : '扣费失败',
        estimatedCredit: totalCredit,
      };
    }

    // Update the billing event to settled
    if ('transactionId' in debitResult) {
      await query(
        `UPDATE skill_billing_events
         SET status = 'settled',
             billing_mode = 'live',
             transaction_id = $1,
             result_summary = $2,
             credit_amount = $3
         WHERE id = $4`,
        [debitResult.transactionId, resultSummary ?? null, totalCredit, estimatedEventId]
      );
    }

    return {
      ok: true,
      eventId: estimatedEventId,
      actualCredit: totalCredit,
      billingMode: 'live',
      skillName: price.skillName,
      unitPrice: price.creditPerUnit,
      isDefault: price.isDefault,
      transactionId: 'transactionId' in debitResult ? debitResult.transactionId : undefined,
    };
  } catch (err) {
    console.error('[billing-hook] settle failed:', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Quick check: does this tenant have enough credits for this skill?
 * Also checks subscription expiration.
 */
export async function canAfford(
  accountId: string,
  skillId: string,
  quantity: number
): Promise<{ canAfford: boolean; estimatedCredit: number; balance: number; reason?: string }> {
  const price = await getSkillPrice(skillId);
  if (!price) return { canAfford: false, estimatedCredit: 0, balance: 0, reason: 'Unknown skill' };

  const pool = getPool();

  // Check subscription expiration
  const { rows: acctRows } = await pool.query(
    `SELECT balance, status, subscription_end, monthly_allowance, monthly_used FROM credits_accounts WHERE id = $1`,
    [accountId]
  );
  if (acctRows.length === 0) return { canAfford: false, estimatedCredit: 0, balance: 0, reason: 'Account not found' };

  const acct = acctRows[0];

  if (acct.status === 'suspended' || acct.status === 'closed') {
    return { canAfford: false, estimatedCredit: 0, balance: Number(acct.balance), reason: `Account is ${acct.status}` };
  }

  if (acct.subscription_end) {
    const now = new Date();
    const endDate = new Date(acct.subscription_end);
    if (endDate < now) {
      return { canAfford: false, estimatedCredit: 0, balance: Number(acct.balance), reason: 'Subscription expired' };
    }
  }

  // Monthly allowance check
  if (acct.monthly_allowance > 0) {
    const used = Number(acct.monthly_used);
    const allowance = Number(acct.monthly_allowance);
    if (used >= allowance) {
      return { canAfford: false, estimatedCredit: 0, balance: Number(acct.balance), reason: 'Monthly allowance exhausted' };
    }
  }

  // Shadow-priced or unapproved skills never deduct, so they're always "affordable"
  if (price.pricingStatus === 'shadow' || price.pricingStatus === 'unapproved') {
    const balance = Number(acct.balance);
    return { canAfford: true, estimatedCredit: 0, balance };
  }

  const estimatedCredit = price.creditPerUnit * quantity;
  const balance = Number(acct.balance);

  return { canAfford: balance >= estimatedCredit, estimatedCredit, balance, reason: balance < estimatedCredit ? 'Insufficient credits' : undefined };
}

/**
 * Get billing events for a tenant (used by admin/audit)
 */
export async function getBillingEvents(params: {
  tenantId: string;
  skillId?: string;
  status?: string;
  limit?: number;
}) {
  const conditions = ['tenant_id = $1'];
  const values: unknown[] = [params.tenantId];

  if (params.skillId) {
    conditions.push(`skill_id = $${values.length + 1}`);
    values.push(params.skillId);
  }
  if (params.status) {
    conditions.push(`status = $${values.length + 1}`);
    values.push(params.status);
  }

  const limit = params.limit ?? 50;
  const { rows } = await query(
    `SELECT * FROM skill_billing_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${values.length + 1}`,
    [...values, limit]
  );

  return rows.map((r: any) => ({
    id: r.id,
    tenantId: r.tenant_id,
    taskId: r.task_id,
    skillId: r.skill_id,
    skillName: r.skill_name,
    quantity: r.quantity,
    credit: Number(r.credit_amount),
    creditAmount: Number(r.credit_amount),
    unitPrice: r.unit_price ? Number(r.unit_price) : null,
    status: r.status,
    billingMode: r.billing_mode || 'live',
    transactionId: r.transaction_id,
    resultSummary: r.result_summary,
    createdAt: r.created_at,
  }));
}

/**
 * Get billing summary for a tenant
 */
export async function getTenantBillingSummary(tenantId: string) {
  const { rows } = await query(
    `SELECT
       COUNT(*) as total_events,
       SUM(CASE WHEN status = 'settled' THEN credit_amount ELSE 0 END) as total_consumed,
       SUM(CASE WHEN status = 'estimated' THEN credit_amount ELSE 0 END) as total_estimated,
       SUM(CASE WHEN status = 'settled' AND billing_mode = 'live' THEN credit_amount ELSE 0 END) as live_consumed,
       SUM(CASE WHEN status = 'settled' AND billing_mode = 'shadow' THEN credit_amount ELSE 0 END) as shadow_consumed,
       COUNT(DISTINCT skill_id) as unique_skills
     FROM skill_billing_events
     WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
    [tenantId]
  );

  const r = rows[0];
  return {
    tenantId,
    totalEvents: Number(r.total_events),
    totalConsumed: Number(r.total_consumed ?? 0),
    totalEstimated: Number(r.total_estimated ?? 0),
    liveConsumed: Number(r.live_consumed ?? 0),
    shadowConsumed: Number(r.shadow_consumed ?? 0),
    uniqueSkills: Number(r.unique_skills),
  };
}

/**
 * Daily consumption aggregation for the trend chart / daily report.
 * Groups settled billing events by calendar day (in the ledger's TZ).
 *
 * - taskCount: settled events that day
 * - consumedSettled: sum of credit_amount for settled events (shadow + live)
 * - consumedLive: only live-debited credit
 * - consumedShadow: only shadow-recorded credit
 */
export async function getDailyUsage(params: { tenantId?: string; days?: number }) {
  const days = params.days && params.days > 0 ? params.days : 30;
  const conditions = [`created_at > NOW() - INTERVAL '${days} days'`];
  const values: unknown[] = [];

  if (params.tenantId) {
    conditions.push(`tenant_id = $${values.length + 1}`);
    values.push(params.tenantId);
  }

  const { rows } = await query(
    `SELECT
       to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
       COUNT(*) FILTER (WHERE status = 'settled') AS task_count,
       COALESCE(SUM(CASE WHEN status = 'settled' THEN credit_amount ELSE 0 END), 0) AS consumed_settled,
       COALESCE(SUM(CASE WHEN status = 'settled' AND billing_mode = 'live' THEN credit_amount ELSE 0 END), 0) AS consumed_live,
       COALESCE(SUM(CASE WHEN status = 'settled' AND billing_mode = 'shadow' THEN credit_amount ELSE 0 END), 0) AS consumed_shadow
     FROM skill_billing_events
     WHERE ${conditions.join(' AND ')}
     GROUP BY date_trunc('day', created_at)
     ORDER BY date_trunc('day', created_at) ASC`,
    values
  );

  return rows.map((r: any) => ({
    day: r.day,
    taskCount: Number(r.task_count),
    consumedSettled: Number(r.consumed_settled),
    consumedLive: Number(r.consumed_live),
    consumedShadow: Number(r.consumed_shadow),
  }));
}

export async function getDailyUsageByTenant(params: { days?: number }) {
  const days = params.days && params.days > 0 ? params.days : 30;
  const { rows } = await query(
    `SELECT
       tenant_id,
       to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
       COUNT(*) FILTER (WHERE status = 'settled') AS task_count,
       COALESCE(SUM(CASE WHEN status = 'settled' THEN credit_amount ELSE 0 END), 0) AS consumed_settled,
       COALESCE(SUM(CASE WHEN status = 'settled' AND billing_mode = 'live' THEN credit_amount ELSE 0 END), 0) AS consumed_live,
       COALESCE(SUM(CASE WHEN status = 'settled' AND billing_mode = 'shadow' THEN credit_amount ELSE 0 END), 0) AS consumed_shadow
     FROM skill_billing_events
     WHERE created_at > NOW() - INTERVAL '${days} days'
     GROUP BY tenant_id, date_trunc('day', created_at)
     ORDER BY date_trunc('day', created_at) DESC, tenant_id ASC`
  );
  return rows.map((r: any) => ({
    tenantId: r.tenant_id,
    day: r.day,
    taskCount: Number(r.task_count),
    consumedSettled: Number(r.consumed_settled),
    consumedLive: Number(r.consumed_live),
    consumedShadow: Number(r.consumed_shadow),
  }));
}
