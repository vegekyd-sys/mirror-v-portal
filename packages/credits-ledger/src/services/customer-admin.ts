import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { createAccount } from './account.js';

export interface PlanTemplate {
  planId: string;
  planName: string;
  tier: string;
  annualFeeYuan: number;
  initialCredit: number;
  seatsMin: number;
  seatsMax: number;
  renewalDiscount: number;
  renewalPricePer100k: number;
  monthlyAllowance: number;
  features: string | null;
}

function rowToPlan(r: any): PlanTemplate {
  return {
    planId: r.plan_id,
    planName: r.plan_name,
    tier: r.tier,
    annualFeeYuan: Number(r.annual_fee_yuan),
    initialCredit: Number(r.initial_credit),
    seatsMin: Number(r.seats_min),
    seatsMax: Number(r.seats_max),
    renewalDiscount: Number(r.renewal_discount),
    renewalPricePer100k: Number(r.renewal_price_per_100k),
    monthlyAllowance: Number(r.monthly_allowance),
    features: r.features,
  };
}

/** List all plan templates */
export async function listPlans(): Promise<PlanTemplate[]> {
  const { rows } = await query('SELECT * FROM plan_templates ORDER BY sort_order');
  return rows.map(rowToPlan);
}

/** Get a single plan template */
export async function getPlan(planId: string): Promise<PlanTemplate | null> {
  const { rows } = await query('SELECT * FROM plan_templates WHERE plan_id = $1', [planId]);
  return rows.length > 0 ? rowToPlan(rows[0]) : null;
}

/** Create a customer account with plan assignment */
export async function createCustomer(params: {
  tenantId: string;
  companyName?: string;
  contactName?: string;
  contactEmail?: string;
  planId: string;
}): Promise<{
  ok: boolean;
  accountId?: string;
  balance?: number;
  planName?: string;
  error?: string;
}> {
  const plan = await getPlan(params.planId);
  if (!plan) return { ok: false, error: `Unknown plan: ${params.planId}` };

  const accountId = `acct_${params.tenantId}`;
  const now = new Date();
  const yearLater = new Date(now);
  yearLater.setFullYear(yearLater.getFullYear() + 1);

  try {
    // Create or update the account
    await query(
      `INSERT INTO credits_accounts (id, tenant_id, plan_tier, balance, monthly_allowance, month_reset_at,
         company_name, contact_name, contact_email, subscription_start, subscription_end, plan_id, lifetime_credited)
       VALUES ($1, $2, $3, $4, $5, date_trunc('month', NOW()) + INTERVAL '1 month', $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         plan_tier = EXCLUDED.plan_tier,
         balance = credits_accounts.balance + EXCLUDED.balance,
         monthly_allowance = EXCLUDED.monthly_allowance,
         company_name = COALESCE(EXCLUDED.company_name, credits_accounts.company_name),
         contact_name = COALESCE(EXCLUDED.contact_name, credits_accounts.contact_name),
         contact_email = COALESCE(EXCLUDED.contact_email, credits_accounts.contact_email),
         subscription_start = EXCLUDED.subscription_start,
         subscription_end = EXCLUDED.subscription_end,
         plan_id = EXCLUDED.plan_id,
         lifetime_credited = credits_accounts.lifetime_credited + EXCLUDED.lifetime_credited,
         status = 'active',
         updated_at = NOW()`,
      [
        accountId, params.tenantId, plan.tier, plan.initialCredit, plan.monthlyAllowance,
        params.companyName ?? null, params.contactName ?? null, params.contactEmail ?? null,
        now.toISOString(), yearLater.toISOString(), plan.planId, plan.initialCredit,
      ]
    );

    return {
      ok: true,
      accountId,
      balance: plan.initialCredit,
      planName: plan.planName,
    };
  } catch (err) {
    console.error('[customer-admin] createCustomer failed:', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Top-up credits to a customer */
export async function topupCredits(params: {
  tenantId: string;
  amount: number;
  reason?: string;
}): Promise<{ ok: boolean; balanceBefore?: number; balanceAfter?: number; error?: string }> {
  const { rows } = await query(
    'SELECT balance, id FROM credits_accounts WHERE tenant_id = $1 OR id = $2',
    [params.tenantId, `acct_${params.tenantId}`]
  );
  if (rows.length === 0) return { ok: false, error: 'Account not found' };

  const balanceBefore = Number(rows[0].balance);
  const accountId = rows[0].id;
  const balanceAfter = balanceBefore + params.amount;

  await query(
    `UPDATE credits_accounts SET balance = $2, lifetime_credited = lifetime_credited + $3, updated_at = NOW() WHERE id = $1`,
    [accountId, balanceAfter, params.amount]
  );

  // Record in ledger
  const txnId = randomUUID();
  await query(
    `INSERT INTO credits_transactions (id, account_id, type, amount, balance_before, balance_after, reference, description, idempotency_key)
     VALUES ($1, $2, 'credit', $3, $4, $5, $6, $7, $8)`,
    [txnId, accountId, params.amount, balanceBefore, balanceAfter,
     `admin:topup`, params.reason ?? '管理员手动充值', `topup_${params.tenantId}_${Date.now()}`]
  );

  return { ok: true, balanceBefore, balanceAfter };
}

/** Get customer summary with consumption stats */
export async function getCustomerSummary(tenantId: string) {
  const { rows } = await query(
    `SELECT a.*,
            (SELECT COUNT(*) FROM skill_billing_events WHERE tenant_id = $1 AND status = 'settled') as total_tasks,
            (SELECT COALESCE(SUM(credit_amount), 0) FROM skill_billing_events WHERE tenant_id = $1 AND status = 'settled') as total_consumed,
            (SELECT COALESCE(SUM(credit_amount), 0) FROM skill_billing_events WHERE tenant_id = $1 AND status = 'settled' AND created_at > NOW() - INTERVAL '30 days') as consumed_30d
     FROM credits_accounts a WHERE a.tenant_id = $2 OR a.id = $3`,
    [tenantId, tenantId, `acct_${tenantId}`]
  );

  if (rows.length === 0) return null;

  const r = rows[0];
  const plan = r.plan_id ? await getPlan(r.plan_id) : null;

  return {
    tenantId,
    companyName: r.company_name,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    planTier: r.plan_tier,
    planName: plan?.planName ?? null,
    planDetails: plan ? {
      annualFee: plan.annualFeeYuan,
      renewalPrice: plan.renewalPricePer100k,
      renewalDiscount: plan.renewalDiscount,
      seatsRange: `${plan.seatsMin}-${plan.seatsMax}`,
    } : null,
    balance: Number(r.balance),
    monthlyAllowance: Number(r.monthly_allowance),
    monthlyUsed: Number(r.monthly_used),
    lifetimeCredited: Number(r.lifetime_credited),
    lifetimeConsumed: Number(r.lifetime_consumed),
    subscriptionStart: r.subscription_start,
    subscriptionEnd: r.subscription_end,
    status: r.status,
    totalTasks: Number(r.total_tasks),
    totalConsumed: Number(r.total_consumed),
    consumed30d: Number(r.consumed_30d),
    updatedAt: r.updated_at,
  };
}

/** List all customers */
export async function listCustomers(status?: string) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    conditions.push(`status = $${params.length + 1}`);
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT a.*,
            (SELECT COALESCE(SUM(credit_amount), 0) FROM skill_billing_events WHERE tenant_id = a.tenant_id AND status = 'settled') as total_consumed,
            (SELECT COUNT(*) FROM skill_billing_events WHERE tenant_id = a.tenant_id AND status = 'settled') as total_tasks
     FROM credits_accounts a ${where} ORDER BY a.created_at DESC`,
    params
  );

  return rows.map((r: any) => ({
    accountId: r.id,
    tenantId: r.tenant_id,
    companyName: r.company_name,
    planTier: r.plan_tier,
    planId: r.plan_id,
    balance: Number(r.balance),
    monthlyAllowance: Number(r.monthly_allowance),
    monthlyUsed: Number(r.monthly_used),
    lifetimeConsumed: Number(r.lifetime_consumed),
    totalConsumed: Number(r.total_consumed),
    totalTasks: Number(r.total_tasks),
    status: r.status,
    subscriptionEnd: r.subscription_end,
    createdAt: r.created_at,
  }));
}
