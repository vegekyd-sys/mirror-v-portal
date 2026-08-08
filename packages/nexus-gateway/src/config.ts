import type { KeyConfig, PlanTier } from './types/index.js';

export interface GatewayConfig {
  port: number;
  tenantId: string;
  platform: 'feishu' | 'dingtalk' | 'wecom';
  planTier: PlanTier;
  agentUrl: string;
  // B3 FIX: credits-ledger URL for HTTP debit/balance calls
  creditsLedgerUrl: string;
  keyConfig: KeyConfig;
  // B4 FIX: bot secret for signature verification
  botSecret?: string;
  allowedAppIds?: string[];
  initialCredits: number;
  // WSClient — Feishu app credentials for long-connection
  appId?: string;
  appSecret?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): GatewayConfig {
  const tenantId = required('DEALCLAW_TENANT_ID');
  const platform = (process.env.DEALCLAW_PLATFORM ?? 'feishu') as GatewayConfig['platform'];

  if (!['feishu', 'dingtalk', 'wecom'].includes(platform)) {
    throw new Error(`Unsupported DEALCLAW_PLATFORM: ${platform}`);
  }

  return {
    port: Number(process.env.PORT ?? 8080),
    tenantId,
    platform,
    planTier: (process.env.DEALCLAW_PLAN_TIER ?? 'starter') as PlanTier,
    agentUrl: required('DEALCLAW_AGENT_URL'),
    creditsLedgerUrl: process.env.CREDITS_LEDGER_URL ?? 'http://credits-ledger:8081',
    initialCredits: Number(process.env.DEALCLAW_INITIAL_CREDITS ?? 0),
    botSecret: process.env.DEALCLAW_BOT_SECRET,
    allowedAppIds: process.env.DEALCLAW_ALLOWED_APP_IDS?.split(',').map(s => s.trim()),
    appId: process.env.DEALCLAW_APP_ID,
    appSecret: process.env.DEALCLAW_APP_SECRET,
    keyConfig: {
      customerKeyRef: required('DEALCLAW_CUSTOMER_KEY_REF'),
      botCredentialRef: required('DEALCLAW_BOT_CREDENTIAL_REF'),
      creditsAccountId: required('DEALCLAW_CREDITS_ACCOUNT_ID'),
      configVersion: process.env.DEALCLAW_CONFIG_VERSION ?? '1',
    },
  };
}
