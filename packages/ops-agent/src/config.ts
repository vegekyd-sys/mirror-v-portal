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
  /** Provisioning-service API URL for rollout */
  provisioningServiceUrl: string;
  /** Auth token for provisioning-service API */
  provisioningApiToken: string;
  /** Desired dealclaw-agent image tag for rollout */
  rolloutDealclawAgentTag?: string;
  /** Desired nexus-gateway image tag for rollout */
  rolloutNexusGatewayTag?: string;
  /** Rollout check interval in minutes (default: 30) */
  rolloutIntervalMinutes: number;
}

export function loadConfig(): OpsConfig {
  return {
    port: Number(process.env.PORT ?? 8083),
    databaseUrl: required('DATABASE_URL'),
    creditsLedgerUrl: process.env.CREDITS_LEDGER_URL ?? 'http://credits-ledger:8081',
    cronIntervalMinutes: Number(process.env.CRON_INTERVAL_MINUTES ?? 60),
    provisioningServiceUrl: process.env.PROVISIONING_SERVICE_URL ?? 'http://provisioning-service:8082',
    provisioningApiToken: required('PROVISIONING_API_TOKEN'),
    rolloutDealclawAgentTag: process.env.ROLLOUT_DEALCLAW_AGENT_TAG,
    rolloutNexusGatewayTag: process.env.ROLLOUT_NEXUS_GATEWAY_TAG,
    rolloutIntervalMinutes: Number(process.env.ROLLOUT_INTERVAL_MINUTES ?? 30),
  };
}
