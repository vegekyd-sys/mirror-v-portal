function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export interface OpsConfig {
  port: number;
  databaseUrl: string;
  creditsLedgerUrl: string;
  /** Cron interval in minutes (default: 60 = hourly) */
  cronIntervalMinutes: number;
}

export function loadConfig(): OpsConfig {
  return {
    port: Number(process.env.PORT ?? 8083),
    databaseUrl: required('DATABASE_URL'),
    creditsLedgerUrl: process.env.CREDITS_LEDGER_URL ?? 'http://credits-ledger:8081',
    cronIntervalMinutes: Number(process.env.CRON_INTERVAL_MINUTES ?? 60),
  };
}
