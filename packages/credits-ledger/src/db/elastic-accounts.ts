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

/** Mirror completed Elastic turns into zero-credit shadow usage records. */
export async function reconcileElasticUsage() {
  await query(`
    INSERT INTO skill_billing_events
      (id, tenant_id, task_id, skill_id, skill_name, quantity,
       credit_amount, unit_price, status, billing_mode, result_summary,
       metadata, created_at)
    SELECT r.id::text, r.tenant_id, r.id::text, 'gateway.chat',
           'Agent 对话', 1, 0, 0, 'settled', 'shadow', 'Agent 对话完成',
           jsonb_build_object('channel', r.channel, 'templateId', t.template_id),
           coalesce(r.completed_at, r.created_at)
    FROM elastic_runs r
    JOIN elastic_tenants t ON t.id = r.tenant_id
    WHERE r.status = 'succeeded'
    ON CONFLICT (id) DO NOTHING
  `);
}
