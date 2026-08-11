import { randomUUID } from 'node:crypto';
import { getPool, query } from '../db/pool.js';

export interface Account {
  id: string;
  tenantId: string;
  planTier: string;
  balance: number;
  monthlyAllowance: number;
  monthlyUsed: number;
  monthResetAt: Date;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function rowToAccount(r: any): Account {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    planTier: r.plan_tier,
    balance: Number(r.balance),
    monthlyAllowance: Number(r.monthly_allowance),
    monthlyUsed: Number(r.monthly_used),
    monthResetAt: r.month_reset_at,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getAccount(accountId: string): Promise<Account | null> {
  const { rows } = await query('SELECT * FROM credits_accounts WHERE id = $1', [accountId]);
  return rows.length > 0 ? rowToAccount(rows[0]) : null;
}

export async function getBalance(accountId: string): Promise<{
  accountId: string;
  balance: number;
  planTier: string;
  monthlyAllowance: number;
  monthlyUsed: number;
  updatedAt: Date;
} | null> {
  const { rows } = await query(
    `SELECT id, balance, plan_tier, monthly_allowance, monthly_used, updated_at
     FROM credits_accounts WHERE id = $1`,
    [accountId]
  );
  if (rows.length === 0) return null;
  return {
    accountId: rows[0].id,
    balance: Number(rows[0].balance),
    planTier: rows[0].plan_tier,
    monthlyAllowance: Number(rows[0].monthly_allowance),
    monthlyUsed: Number(rows[0].monthly_used),
    updatedAt: rows[0].updated_at,
  };
}

/**
 * B1 FIX: Atomic debit inside a transaction with SELECT FOR UPDATE.
 * B6 FIX: Check and auto-reset monthly_used if month_reset_at has passed.
 * B7 FIX: Enforce monthly_allowance check.
 */
export async function debit(params: {
  accountId: string;
  amount: number;
  reference: string;
  description?: string;
  category?: string;
  idempotencyKey: string;
}): Promise<
  | { ok: true; balanceBefore: number; balanceAfter: number; transactionId: string }
  | { ok: false; code: 'INSUFFICIENT_CREDITS'; balance: number; required: number }
  | { ok: false; code: 'MONTHLY_LIMIT_EXCEEDED'; monthlyUsed: number; monthlyAllowance: number; required: number }
  | { ok: false; code: 'ACCOUNT_NOT_FOUND' }
  | { ok: true; idempotent: true; transactionId: string }
> {
  const { accountId, amount, reference, description, category, idempotencyKey } = params;
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    // Lock the account row to prevent race conditions
    const lockResult = await client.query(
      'SELECT balance, monthly_used, monthly_allowance, month_reset_at FROM credits_accounts WHERE id = $1 FOR UPDATE',
      [accountId]
    );
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'ACCOUNT_NOT_FOUND' };
    }

    // Check idempotency under lock
    const existing = await client.query(
      'SELECT id FROM credits_transactions WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return { ok: true, idempotent: true, transactionId: existing.rows[0].id };
    }

    let { balance, monthly_used, monthly_allowance, month_reset_at } = lockResult.rows[0];
    balance = Number(balance);
    monthly_used = Number(monthly_used);
    monthly_allowance = Number(monthly_allowance);

    // B6: Auto-reset monthly_used if the month has rolled over
    if (new Date(month_reset_at) < new Date()) {
      await client.query(
        `UPDATE credits_accounts
         SET monthly_used = 0,
             month_reset_at = date_trunc('month', NOW()) + INTERVAL '1 month'
         WHERE id = $1`,
        [accountId]
      );
      monthly_used = 0;
    }

    // Check total balance
    if (balance < amount) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'INSUFFICIENT_CREDITS', balance, required: amount };
    }

    // B7: Check monthly allowance
    if (monthly_allowance > 0 && monthly_used + amount > monthly_allowance) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'MONTHLY_LIMIT_EXCEEDED',
        monthlyUsed: monthly_used,
        monthlyAllowance: monthly_allowance,
        required: amount,
      };
    }

    const balanceBefore = balance;
    const balanceAfter = balance - amount;

    // Atomic update
    await client.query(
      `UPDATE credits_accounts
       SET balance = $2,
           monthly_used = monthly_used + $3,
           lifetime_consumed = lifetime_consumed + $3,
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, balanceAfter, amount]
    );

    // Insert transaction record
    const txnId = randomUUID();
    await client.query(
      `INSERT INTO credits_transactions
       (id, account_id, type, amount, balance_before, balance_after, reference, description, category, idempotency_key)
       VALUES ($1, $2, 'debit', $3, $4, $5, $6, $7, $8, $9)`,
      [txnId, accountId, amount, balanceBefore, balanceAfter, reference, description || null, category || null, idempotencyKey]
    );

    await client.query('COMMIT');
    return { ok: true, balanceBefore, balanceAfter, transactionId: txnId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * B1 FIX: Credit inside a transaction with SELECT FOR UPDATE.
 */
export async function credit(params: {
  accountId: string;
  amount: number;
  reference: string;
  description?: string;
  idempotencyKey: string;
}): Promise<
  | { ok: true; balanceBefore: number; balanceAfter: number; transactionId: string }
  | { ok: false; code: 'ACCOUNT_NOT_FOUND' }
  | { ok: true; idempotent: true; transactionId: string }
> {
  const { accountId, amount, reference, description, idempotencyKey } = params;
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    const lockResult = await client.query(
      'SELECT balance FROM credits_accounts WHERE id = $1 FOR UPDATE',
      [accountId]
    );
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'ACCOUNT_NOT_FOUND' };
    }

    const existing = await client.query(
      'SELECT id FROM credits_transactions WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return { ok: true, idempotent: true, transactionId: existing.rows[0].id };
    }

    const balanceBefore = Number(lockResult.rows[0].balance);
    const balanceAfter = balanceBefore + amount;

    await client.query(
      `UPDATE credits_accounts
       SET balance = $2,
           lifetime_credited = lifetime_credited + $3,
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, balanceAfter, amount]
    );

    const txnId = randomUUID();
    await client.query(
      `INSERT INTO credits_transactions
       (id, account_id, type, amount, balance_before, balance_after, reference, description, idempotency_key)
       VALUES ($1, $2, 'credit', $3, $4, $5, $6, $7, $8)`,
      [txnId, accountId, amount, balanceBefore, balanceAfter, reference, description || null, idempotencyKey]
    );

    await client.query('COMMIT');
    return { ok: true, balanceBefore, balanceAfter, transactionId: txnId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getHistory(params: {
  accountId: string;
  from?: string;
  to?: string;
  limit?: number;
}) {
  const { accountId, from, to, limit = 50 } = params;
  const conditions = ['account_id = $1'];
  const values: unknown[] = [accountId];

  if (from) {
    conditions.push(`created_at >= $${values.length + 1}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`created_at <= $${values.length + 1}`);
    values.push(to);
  }

  const { rows } = await query(
    `SELECT * FROM credits_transactions
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${values.length + 1}`,
    [...values, limit]
  );

  const countResult = await query(
    `SELECT COUNT(*) FROM credits_transactions WHERE ${conditions.join(' AND ')}`,
    values
  );

  return {
    accountId,
    transactions: rows.map(r => ({
      id: r.id,
      type: r.type,
      amount: Number(r.amount),
      balanceBefore: Number(r.balance_before),
      balanceAfter: Number(r.balance_after),
      reference: r.reference,
      description: r.description,
      category: r.category,
      timestamp: r.created_at,
    })),
    total: Number(countResult.rows[0].count),
  };
}

export async function getUsage(accountId: string, month: string) {
  const { rows } = await query(
    `SELECT a.monthly_allowance, a.monthly_used, u.category, u.total_used, u.call_count
     FROM credits_accounts a
     LEFT JOIN credits_monthly_usage u ON u.account_id = a.id AND u.month = $2
     WHERE a.id = $1`,
    [accountId, month]
  );

  if (rows.length === 0) return null;

  return {
    accountId,
    month,
    monthlyAllowance: Number(rows[0].monthly_allowance),
    totalUsed: Number(rows[0].monthly_used),
    breakdown: Object.fromEntries(
      rows.filter((r: any) => r.category).map((r: any) => [r.category, Number(r.total_used)])
    ),
  };
}

export async function createAccount(params: {
  id: string;
  tenantId: string;
  planTier: string;
  monthlyAllowance: number;
}) {
  await query(
    `INSERT INTO credits_accounts (id, tenant_id, plan_tier, monthly_allowance, month_reset_at)
     VALUES ($1, $2, $3, $4, date_trunc('month', NOW()) + INTERVAL '1 month')
     ON CONFLICT DO NOTHING`,
    [params.id, params.tenantId, params.planTier, params.monthlyAllowance]
  );
}

/**
 * Freeze credits for guaranteed delivery obligations (e.g. 慧展权益).
 * Frozen credits are deducted from available balance but remain in the account.
 */
export async function freezeCredits(params: {
  accountId: string;
  amount: number;
  reason: string;
  reference: string;
}): Promise<
  | { ok: true; availableBefore: number; availableAfter: number; frozenBefore: number; frozenAfter: number }
  | { ok: false; code: 'ACCOUNT_NOT_FOUND' | 'INSUFFICIENT_AVAILABLE'; available: number; frozen: number; required: number }
> {
  const { accountId, amount, reason, reference } = params;
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    const lockResult = await client.query(
      'SELECT balance, frozen_credits FROM credits_accounts WHERE id = $1 FOR UPDATE',
      [accountId]
    );
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'ACCOUNT_NOT_FOUND', available: 0, frozen: 0, required: amount };
    }

    const balance = Number(lockResult.rows[0].balance);
    const frozenBefore = Number(lockResult.rows[0].frozen_credits);
    const available = balance - frozenBefore;

    if (available < amount) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'INSUFFICIENT_AVAILABLE', available, frozen: frozenBefore, required: amount };
    }

    const frozenAfter = frozenBefore + amount;
    await client.query(
      `UPDATE credits_accounts
       SET frozen_credits = $2, frozen_reason = $3, updated_at = NOW()
       WHERE id = $1`,
      [accountId, frozenAfter, reason]
    );

    // Log as a freeze transaction
    const txnId = randomUUID();
    await client.query(
      `INSERT INTO credits_transactions
       (id, account_id, type, amount, balance_before, balance_after, reference, description, category, idempotency_key)
       VALUES ($1, $2, 'freeze', $3, $4, $5, $6, $7, 'freeze', $8)`,
      [txnId, accountId, amount, frozenBefore, frozenAfter, reference,
       `冻结: ${reason} (available: ${available} → ${available - amount})`,
       `freeze_${accountId}_${Date.now()}`]
    );

    await client.query('COMMIT');
    return {
      ok: true,
      availableBefore: available,
      availableAfter: available - amount,
      frozenBefore,
      frozenAfter,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Unfreeze credits (release reserved obligation).
 */
export async function unfreezeCredits(params: {
  accountId: string;
  amount: number;
  reason: string;
  reference: string;
}): Promise<
  | { ok: true; availableBefore: number; availableAfter: number; frozenBefore: number; frozenAfter: number }
  | { ok: false; code: 'ACCOUNT_NOT_FOUND' | 'INSUFFICIENT_FROZEN'; available: number; frozen: number; requested: number }
> {
  const { accountId, amount, reason, reference } = params;
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    const lockResult = await client.query(
      'SELECT balance, frozen_credits FROM credits_accounts WHERE id = $1 FOR UPDATE',
      [accountId]
    );
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'ACCOUNT_NOT_FOUND', available: 0, frozen: 0, requested: amount };
    }

    const balance = Number(lockResult.rows[0].balance);
    const frozenBefore = Number(lockResult.rows[0].frozen_credits);

    if (frozenBefore < amount) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'INSUFFICIENT_FROZEN', available: balance - frozenBefore, frozen: frozenBefore, requested: amount };
    }

    const frozenAfter = frozenBefore - amount;
    await client.query(
      `UPDATE credits_accounts
       SET frozen_credits = $2, frozen_reason = CASE WHEN frozen_credits - $2 <= 0 THEN NULL ELSE frozen_reason END, updated_at = NOW()
       WHERE id = $1`,
      [accountId, frozenAfter]
    );

    const txnId = randomUUID();
    await client.query(
      `INSERT INTO credits_transactions
       (id, account_id, type, amount, balance_before, balance_after, reference, description, category, idempotency_key)
       VALUES ($1, $2, 'unfreeze', $3, $4, $5, $6, $7, 'unfreeze', $8)`,
      [txnId, accountId, amount, frozenBefore, frozenAfter, reference,
       `解冻: ${reason}`,
       `unfreeze_${accountId}_${Date.now()}`]
    );

    await client.query('COMMIT');
    return {
      ok: true,
      availableBefore: balance - frozenBefore,
      availableAfter: balance - frozenAfter,
      frozenBefore,
      frozenAfter,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get full account info including frozen credits.
 */
export async function getAccountFull(accountId: string): Promise<{
  id: string;
  balance: number;
  frozen: number;
  available: number;
  lifetimeConsumed: number;
  lifetimeCredited: number;
  frozenReason: string | null;
  planTier: string;
  status: string;
} | null> {
  const { rows } = await query(
    `SELECT id, balance, frozen_credits, frozen_reason, lifetime_consumed, lifetime_credited,
            plan_tier, status
     FROM credits_accounts WHERE id = $1`,
    [accountId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const balance = Number(r.balance);
  const frozen = Number(r.frozen_credits);
  return {
    id: r.id,
    balance,
    frozen,
    available: balance - frozen,
    lifetimeConsumed: Number(r.lifetime_consumed),
    lifetimeCredited: Number(r.lifetime_credited),
    frozenReason: r.frozen_reason,
    planTier: r.plan_tier,
    status: r.status,
  };
}
