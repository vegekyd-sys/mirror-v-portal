import pg from 'pg';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { ensureDefaultTenant } from './services/default-tenant.js';
import { ensureCentralTestTenant } from './services/central-test-tenant.js';

async function main() {
  const config = loadConfig();

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
  });

  // Run migrations
  await migrate(pool);

  const app = createApp(pool, config);

  app.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({
      level: 'info',
      service: 'provisioning-service',
      port: config.port,
      dryRun: config.k8sDryRun,
      message: 'Provisioning Service started',
    }));
  });

  // Default tenant bootstrap — fire-and-forget so a failure can never keep
  // the service from starting. Idempotent; retried periodically so that a
  // fresh system completes provisioning once the admin configures the model
  // key (运行时配置) without needing a restart.
  ensureDefaultTenant(pool, config)
    .then((r) => console.log(`[default-tenant] boot ensure: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`))
    .catch((err) => console.error('[default-tenant] boot ensure error:', err));
  const defaultTenantTimer = setInterval(() => {
    ensureDefaultTenant(pool, config)
      .then((r) => {
        if (r.action !== 'already_ready' && r.action !== 'skipped') {
          console.log(`[default-tenant] periodic ensure: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`);
        }
      })
      .catch((err) => console.error('[default-tenant] periodic ensure error:', err));
  }, 10 * 60 * 1000);
  defaultTenantTimer.unref();

  // Central test tenant adoption — brings the legacy ArgoCD-managed
  // dealclaw-test gateway into the tenant registry / Feishu binding system.
  // Same fire-and-forget + idempotent + periodic-retry contract as above.
  ensureCentralTestTenant(pool, config)
    .then((r) => console.log(`[central-test-tenant] boot ensure: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`))
    .catch((err) => console.error('[central-test-tenant] boot ensure error:', err));
  const centralTestTimer = setInterval(() => {
    ensureCentralTestTenant(pool, config)
      .then((r) => {
        if (r.action !== 'already_ready' && r.action !== 'skipped') {
          console.log(`[central-test-tenant] periodic ensure: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`);
        }
      })
      .catch((err) => console.error('[central-test-tenant] periodic ensure error:', err));
  }, 10 * 60 * 1000);
  centralTestTimer.unref();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
