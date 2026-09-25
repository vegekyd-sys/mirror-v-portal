import { query } from './pool.js';

/** Link Elastic instances to ledger accounts without granting paid credits. */
export async function setupElasticAccounts() {
  await query(`
    CREATE OR REPLACE FUNCTION nexus_create_elastic_account() RETURNS trigger AS $$
    BEGIN
      INSERT INTO credits_accounts
        (id, tenant_id, plan_tier, balance, month_reset_at, company_name)
      VALUES
        ('nexus_' || replace(NEW.id, '-', ''), NEW.id, 'start', 0,
         date_trunc('month', now()) + interval '1 month', NEW.name)
      ON CONFLICT (tenant_id) DO NOTHING;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await query('DROP TRIGGER IF EXISTS nexus_elastic_account_on_create ON elastic_tenants');
  await query(`
    CREATE TRIGGER nexus_elastic_account_on_create
    AFTER INSERT ON elastic_tenants
    FOR EACH ROW EXECUTE FUNCTION nexus_create_elastic_account()
  `);
  await query(`
    INSERT INTO credits_accounts
      (id, tenant_id, plan_tier, balance, month_reset_at, company_name)
    SELECT 'nexus_' || replace(id, '-', ''), id, 'start', 0,
           date_trunc('month', now()) + interval '1 month', name
    FROM elastic_tenants
    WHERE TRUE
    ON CONFLICT (tenant_id) DO NOTHING
  `);

  // Original DealClaw prices are reusable reference data, not approved
  // Mirror V commercial terms. Apply this once; later admin edits persist.
  await query('CREATE TABLE IF NOT EXISTS nexus_elastic_billing_setup (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const marker = await query('INSERT INTO nexus_elastic_billing_setup(id) VALUES(TRUE) ON CONFLICT DO NOTHING RETURNING id');
  if (marker.rowCount) {
    await query("UPDATE plan_templates SET status='frozen', updated_at=now()");
    await query("UPDATE skill_prices SET status='shadow', activation_status='unapproved', updated_at=now()");
  }
}
