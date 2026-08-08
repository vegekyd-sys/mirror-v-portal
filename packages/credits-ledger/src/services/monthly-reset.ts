import { getPool } from '../db/pool.js';

export interface MonthlyResetResult {
  totalAccounts: number;
  resetAccounts: number;
  skippedAccounts: number;
  errors: Array<{ accountId: string; error: string }>;
}

/**
 * Proactive monthly usage reset.
 *
 * Finds all active accounts whose `month_reset_at` has passed, and resets
 * `monthly_used` to 0 while advancing `month_reset_at` to the next month boundary.
 *
 * Uses FOR UPDATE SKIP LOCKED to avoid blocking concurrent debits (which also
 * perform a lazy reset inside their own locked transaction).
 *
 * Safe to call at any frequency — idempotent, skips already-reset accounts.
 */
export async function runMonthlyReset(): Promise<MonthlyResetResult> {
  const client = await getPool().connect();
  const errors: Array<{ accountId: string; error: string }> = [];
  let resetAccounts = 0;
  let skippedAccounts = 0;

  try {
    // Count all active accounts
    const totalResult = await client.query(
      `SELECT COUNT(*) FROM credits_accounts WHERE status = 'active'`
    );
    const totalAccounts = Number(totalResult.rows[0].count);

    // Find accounts needing reset (SKIP LOCKED avoids deadlocks with concurrent debits)
    const overdueResult = await client.query(
      `SELECT id, monthly_used, month_reset_at
       FROM credits_accounts
       WHERE status = 'active'
         AND month_reset_at < NOW()
       FOR UPDATE SKIP LOCKED`
    );

    const nextMonthReset = `date_trunc('month', NOW()) + INTERVAL '1 month'`;

    for (const row of overdueResult.rows) {
      try {
        await client.query('BEGIN');

        // Double-check under lock (in case of concurrent lazy reset in debit())
        const check = await client.query(
          `SELECT monthly_used, month_reset_at FROM credits_accounts WHERE id = $1 FOR UPDATE`,
          [row.id]
        );

        if (check.rows.length === 0) {
          await client.query('ROLLBACK');
          skippedAccounts++;
          continue;
        }

        const current = new Date(check.rows[0].month_reset_at);
        if (current >= new Date()) {
          // Already reset by another process
          await client.query('ROLLBACK');
          skippedAccounts++;
          continue;
        }

        const oldMonthlyUsed = Number(check.rows[0].monthly_used);

        // Reset monthly_used, advance month_reset_at
        await client.query(
          `UPDATE credits_accounts
           SET monthly_used = 0,
               month_reset_at = ${nextMonthReset},
               updated_at = NOW()
           WHERE id = $1`,
          [row.id]
        );

        // Insert a system transaction record for audit trail
        await client.query(
          `INSERT INTO credits_transactions
           (id, account_id, type, amount, balance_before, balance_after, reference, description, category, idempotency_key)
           VALUES (gen_random_uuid(), $1, 'reset', 0, $2, 0,
                   'monthly_reset', 'Monthly usage reset', 'system',
                   $3)`,
          [row.id, oldMonthlyUsed, `reset:${row.id}:${new Date().toISOString().slice(0, 7)}`]
        );

        await client.query('COMMIT');
        resetAccounts++;
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        errors.push({ accountId: row.id, error: err.message || String(err) });
      }
    }

    return { totalAccounts, resetAccounts, skippedAccounts, errors };
  } finally {
    client.release();
  }
}

/**
 * @deprecated Backward-compat alias
 */
export const resetMonthlyUsage = runMonthlyReset;
