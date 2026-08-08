import { query } from './pool.js';

export async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS credits_accounts (
      id                VARCHAR(64) PRIMARY KEY,
      tenant_id         VARCHAR(64) NOT NULL UNIQUE,
      plan_tier         VARCHAR(16) NOT NULL,
      balance           BIGINT NOT NULL DEFAULT 0,
      monthly_allowance BIGINT NOT NULL DEFAULT 0,
      monthly_used      BIGINT NOT NULL DEFAULT 0,
      month_reset_at    TIMESTAMPTZ NOT NULL,
      lifetime_credited BIGINT NOT NULL DEFAULT 0,
      lifetime_consumed BIGINT NOT NULL DEFAULT 0,
      status            VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_credits_accounts_tenant ON credits_accounts(tenant_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_credits_accounts_status ON credits_accounts(status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS credits_transactions (
      id              VARCHAR(64) PRIMARY KEY,
      account_id      VARCHAR(64) NOT NULL REFERENCES credits_accounts(id),
      type            VARCHAR(16) NOT NULL,
      amount          BIGINT NOT NULL,
      balance_before  BIGINT NOT NULL,
      balance_after   BIGINT NOT NULL,
      reference       VARCHAR(128) NOT NULL,
      description     TEXT,
      category        VARCHAR(32),
      idempotency_key VARCHAR(128) NOT NULL,
      metadata        JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credits_txn_idempotent ON credits_transactions(idempotency_key)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_credits_txn_account ON credits_transactions(account_id, created_at DESC)`);

  await query(`
    CREATE TABLE IF NOT EXISTS credits_monthly_usage (
      account_id  VARCHAR(64) NOT NULL,
      month       VARCHAR(7) NOT NULL,
      category    VARCHAR(32) NOT NULL,
      total_used  BIGINT NOT NULL DEFAULT 0,
      call_count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, month, category)
    )
  `);

  console.log('Migrations complete');
}
