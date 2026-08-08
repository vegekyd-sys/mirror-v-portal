import pg from 'pg';

export async function migrate(pool?: pg.Pool): Promise<void> {
  const client = pool ?? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id       TEXT PRIMARY KEY,
        company_name    TEXT NOT NULL,
        contact_email    TEXT NOT NULL,
        contact_phone    TEXT,
        plan_tier       TEXT NOT NULL DEFAULT 'starter' CHECK (plan_tier IN ('starter','pro','enterprise')),
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','grace','destroyed')),
        k8s_namespace   TEXT,  -- shared namespace for all tenants; unique constraint removed
        credits_account_id TEXT,
        quota_agents    INTEGER NOT NULL DEFAULT 1,
        quota_credits_monthly BIGINT NOT NULL DEFAULT 1000000,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tenant_status_log (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        from_status     TEXT,
        to_status       TEXT NOT NULL,
        reason          TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

      -- Add app credential columns (v0.3)
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS app_id TEXT;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS app_secret TEXT;
      -- Drop per-tenant namespace unique constraint (now shared namespace)
      ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_k8s_namespace_key;
      CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(contact_email);
      CREATE INDEX IF NOT EXISTS idx_tenant_log_tenant ON tenant_status_log(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tenant_log_time ON tenant_status_log(created_at);
    `);

    // Add columns for ops-agent state machine (if they don't exist yet)
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_end TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ`);

    console.log(JSON.stringify({
      level: 'info',
      action: 'migrate',
      message: 'Tenant registry migration complete',
    }));
  } finally {
    if (!pool) await client.end();
  }
}

// Run directly
const isMain = process.argv[1]?.includes('migrate');
if (isMain) {
  migrate().then(() => process.exit(0)).catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
