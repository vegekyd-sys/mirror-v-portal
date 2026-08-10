import { randomUUID } from 'node:crypto';
import { getPool, query } from '../db/pool.js';
import { getSkillPrice, estimateCost } from './skill-pricing.js';
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
    const cost = await estimateCost(action.skillId, action.quantity);
    const eventId = randomUUID();
    const idempotencyKey = action.idempotencyKey ?? `${action.tenantId}_est_${action.skillId}_${Date.now()}`;

    await query(
      `INSERT INTO skill_billing_events (id, tenant_id, task_id, skill_id, skill_name, quantity, credit_amount, unit_price, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'estimated', $9)
       ON CONFLICT DO NOTHING`,
      [eventId, action.tenantId, action.taskId ?? null, action.skillId, cost.skillName,
       action.quantity, cost.totalCredit, cost.unitPrice, JSON.stringify(action.metadata ?? {})]
    );

    return {
      ok: true,
      eventId,
      estimatedCredit: cost.totalCredit,
      skillName: cost.skillName,
      unitPrice: cost.unitPrice,
      isDefault: cost.isDefault,
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
    const idempotencyKey = action.idempotencyKey ??
      `${accountId}_settle_${estimatedEventId}`;

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
 */
export async function canAfford(
  accountId: string,
  skillId: string,
  quantity: number
): Promise<{ canAfford: boolean; estimatedCredit: number; balance: number }> {
  const price = await getSkillPrice(skillId);
  if (!price) return { canAfford: false, estimatedCredit: 0, balance: 0 };

  const estimatedCredit = price.creditPerUnit * quantity;

  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT balance FROM credits_accounts WHERE id = $1',
    [accountId]
  );
  if (rows.length === 0) return { canAfford: false, estimatedCredit, balance: 0 };

  const balance = Number(rows[0].balance);
  return { canAfford: balance >= estimatedCredit, estimatedCredit, balance };
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
    creditAmount: Number(r.credit_amount),
    unitPrice: r.unit_price ? Number(r.unit_price) : null,
    status: r.status,
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
    uniqueSkills: Number(r.unique_skills),
  };
}
