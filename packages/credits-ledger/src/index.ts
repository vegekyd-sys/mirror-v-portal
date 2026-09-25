import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { reconcileElasticUsage, setupElasticAccounts } from './db/elastic-accounts.js';
import { runMonthlyReset } from './services/monthly-reset.js';

const PORT = Number(process.env.PORT ?? 8081);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  await migrate();
  if (process.env.NEXUS_ELASTIC_MODE === '1') {
    await setupElasticAccounts();
    await reconcileElasticUsage();
    setInterval(() => {
      void reconcileElasticUsage().catch(error => console.error('Elastic shadow usage reconciliation failed:', error));
    }, 60_000).unref();
  }

  // Run monthly reset on startup to catch any overdue accounts
  try {
    const result = await runMonthlyReset();
    if (result.resetAccounts > 0 || result.errors.length > 0) {
      console.log(JSON.stringify({
        level: 'info',
        action: 'monthly-reset-startup',
        ...result,
      }));
    }
  } catch (err) {
    console.error('Startup monthly reset failed:', err);
  }

  const app = createApp();

  app.listen(PORT, HOST, () => {
    console.log(JSON.stringify({
      level: 'info',
      service: 'credits-ledger',
      port: PORT,
      host: HOST,
      message: 'Credits Ledger started',
    }));
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
