import pg from 'pg';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';

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
