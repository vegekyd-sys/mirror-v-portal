import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { runMonthlyReset } from './services/monthly-reset.js';

const PORT = Number(process.env.PORT ?? 8081);

async function main() {
  await migrate();

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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({
      level: 'info',
      service: 'credits-ledger',
      port: PORT,
      message: 'Credits Ledger started',
    }));
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
