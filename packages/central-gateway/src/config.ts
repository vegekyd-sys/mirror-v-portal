function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export interface CentralConfig {
  port: number;
  baseUrl: string;
  provisioningServiceUrl: string;
  provisioningApiToken?: string;
  agentUrl: string;
}

export function loadConfig(): CentralConfig {
  return {
    port: Number(process.env.PORT ?? 8085),
    baseUrl: process.env.BASE_URL ?? 'https://dealclaw.cn',
    provisioningServiceUrl: process.env.PROVISIONING_SERVICE_URL ?? 'http://provisioning-service:8082',
    provisioningApiToken: process.env.PROVISIONING_API_TOKEN,
    agentUrl: process.env.DEALCLAW_AGENT_URL ?? 'http://dealclaw-agent:18789',
  };
}
