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

    // Notification delivery (v0.4):
    // - platform / im_open_id: where lifecycle notifications get delivered.
    //   im_open_id is captured by nexus-gateway on the tenant's first bot message.
    await client.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'feishu';
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS im_open_id TEXT;

      -- The original CHECK constraint only allowed the initial five states, but
      -- ops-agent writes 'low_credits' and provisioning writes 'provisioning' /
      -- 'provisioning_failed'. Rebuild the constraint with the full lifecycle set.
      ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
      ALTER TABLE tenants ADD CONSTRAINT tenants_status_check CHECK (status IN (
        'pending','provisioning','provisioning_failed',
        'active','low_credits','suspended','grace','destroyed'
      ));

      -- Idempotent notification log. Owned by ops-agent; the UNIQUE dedup_key
      -- guarantees a lifecycle notification is delivered at most once per cycle.
      CREATE TABLE IF NOT EXISTS tenant_notifications (
        id                BIGSERIAL PRIMARY KEY,
        tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        notification_type TEXT NOT NULL,
        channel           TEXT NOT NULL DEFAULT 'bot',
        dedup_key         TEXT NOT NULL UNIQUE,
        message           TEXT NOT NULL,
        delivered         BOOLEAN NOT NULL DEFAULT FALSE,
        delivery_error    TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at      TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_notifications_tenant
        ON tenant_notifications(tenant_id, created_at DESC);
    `);

    // Per-tenant runtime configuration (v0.5):
    // Backs the admin-dashboard "runtime config" management page. Values are
    // AES-256-GCM encrypted (see services/crypto.ts) before storage and are
    // materialized as the tenant-config Secret in the tenant's namespace at
    // provisioning time.
    //
    // tenant_id NULL = global default (shared provider keys); a non-NULL
    // tenant_id row overrides the global value for that tenant. Two partial
    // unique indexes are needed because plain UNIQUE treats NULLs as distinct.
    await client.query(`
      CREATE TABLE IF NOT EXISTS runtime_configs (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       TEXT REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        config_key      TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        is_secret       BOOLEAN NOT NULL DEFAULT TRUE,
        description     TEXT,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_configs_global_key_uq
        ON runtime_configs(config_key) WHERE tenant_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_configs_tenant_key_uq
        ON runtime_configs(tenant_id, config_key) WHERE tenant_id IS NOT NULL;
    `);

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
