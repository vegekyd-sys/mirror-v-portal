import pg from 'pg';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { syncImageReleases } from './services/registry-sync.js';
import { pruneAuditLogs } from './services/audit.js';
import { attachPodExecWebSocket } from './ws/pod-exec.js';

async function main() {
  const config = loadConfig();

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
  });

  // Run migrations
  await migrate(pool);

  const app = createApp(pool, config);

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({
      level: 'info',
      service: 'provisioning-service',
      port: config.port,
      dryRun: config.k8sDryRun,
      message: 'Provisioning Service started',
    }));
  });

  // Pod exec WebSocket (/v1/tenants/:id/exec) — Express can't upgrade WS,
  // so the ws server attaches to the raw HTTP server. No-op in dry-run mode
  // (k8s exec is cluster-only; the upgrade handler rejects with 404).
  attachPodExecWebSocket(server);

  // Registry sync — the image release registry's source of truth is the
  // container registry (replaces the removed Jenkins post-build hook).
  // Fire-and-forget + idempotent + periodic (every 30 min) so newly built
  // images appear in the admin console's 镜像版本 page without any manual
  // step; admins can also trigger POST /v1/admin/image-releases/sync.
  const runRegistrySync = (trigger: string) =>
    syncImageReleases(pool, config)
      .then((r) => {
        const summary = r.results
          .map((s) => `${s.service}: ${s.ok ? `+${s.inserted}/${s.discovered}` : `ERR ${s.error}`}`)
          .join('; ');
        console.log(`[registry-sync] ${trigger}: ${r.ok ? 'ok' : 'partial failure'} — ${summary}`);
      })
      .catch((err) => console.error(`[registry-sync] ${trigger} error:`, err));
  runRegistrySync('boot');
  const registrySyncTimer = setInterval(() => runRegistrySync('periodic'), 30 * 60 * 1000);
  registrySyncTimer.unref();

  // Audit log retention — prune rows older than 180 days, daily. Volume is
  // small (admin operations only; chat ingest is excluded), so a simple
  // interval keeps the table bounded without external tooling.
  const AUDIT_RETENTION_DAYS = 180;
  const runAuditPrune = (trigger: string) =>
    pruneAuditLogs(pool, AUDIT_RETENTION_DAYS)
      .then((deleted) => {
        if (deleted > 0) console.log(`[audit] ${trigger}: pruned ${deleted} rows older than ${AUDIT_RETENTION_DAYS}d`);
      })
      .catch((err) => console.error(`[audit] ${trigger} error:`, err));
  runAuditPrune('boot');
  const auditPruneTimer = setInterval(() => runAuditPrune('daily'), 24 * 60 * 60 * 1000);
  auditPruneTimer.unref();

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
