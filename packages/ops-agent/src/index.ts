import pg from 'pg';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { runCronCycle } from './services/cron.js';
import { runRolloutCycle } from './services/rollout.js';

async function main() {
  const config = loadConfig();

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
  });

  const app = createApp(pool, config);

  app.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({
      level: 'info',
      service: 'ops-agent',
      port: config.port,
      cronIntervalMinutes: config.cronIntervalMinutes,
      message: 'Ops Agent started',
    }));
  });

  // Start cron loop
  const cronMs = config.cronIntervalMinutes * 60 * 1000;
  console.log(JSON.stringify({
    level: 'info',
    action: 'cron-start',
    intervalMinutes: config.cronIntervalMinutes,
    nextRunIn: `${config.cronIntervalMinutes} minutes`,
  }));

  setInterval(async () => {
    try {
      const start = Date.now();
      const result = await runCronCycle(pool, config);
      console.log(JSON.stringify({
        level: 'info',
        action: 'cron-cycle',
        ...result,
      }));
    } catch (err) {
      console.error('Cron error:', err);
    }
  }, cronMs);

  // Run first status cycle after 30s
  setTimeout(async () => {
    try {
      const result = await runCronCycle(pool, config);
      console.log(JSON.stringify({
        level: 'info',
        action: 'cron-initial',
        ...result,
      }));
    } catch (err) {
      console.error('Initial cron error:', err);
    }
  }, 30_000);

  // ── Rollout cron (separate interval from status-scan cron) ──
  const rolloutMs = config.rolloutIntervalMinutes * 60 * 1000;
  console.log(JSON.stringify({
    level: 'info',
    action: 'rollout-cron-start',
    intervalMinutes: config.rolloutIntervalMinutes,
    nexusGatewayTag: config.rolloutNexusGatewayTag || '(not set)',
    dealclawAgentTag: config.rolloutDealclawAgentTag || '(not set)',
  }));

  setInterval(async () => {
    try {
      const results = await runRolloutCycle(config);
      if (results.length > 0) {
        console.log(JSON.stringify({
          level: 'info',
          action: 'rollout-cycle',
          results,
        }));
      }
    } catch (err) {
      console.error('Rollout cron error:', err);
    }
  }, rolloutMs);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down ops-agent...');
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
