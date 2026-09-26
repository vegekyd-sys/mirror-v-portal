function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export interface CentralConfig {
  port: number;
  host: string;
  baseUrl: string;
  portalBaseUrl: string;
  provisioningServiceUrl: string;
  provisioningApiToken?: string;
  /** Shared secret guarding the internal notify relay (ops-agent → central-gateway) */
  internalApiToken?: string;
}

export function loadConfig(): CentralConfig {
  return {
    port: Number(process.env.PORT ?? 8085),
    host: process.env.HOST ?? '0.0.0.0',
    baseUrl: process.env.BASE_URL ?? 'https://dealclaw.cn',
    portalBaseUrl: process.env.PORTAL_BASE_URL ?? 'https://mirror-v-portal.vercel.app',
    provisioningServiceUrl: process.env.PROVISIONING_SERVICE_URL ?? 'http://provisioning-service:8082',
    provisioningApiToken: process.env.PROVISIONING_API_TOKEN,
    internalApiToken: process.env.INTERNAL_API_TOKEN,
  };
}
