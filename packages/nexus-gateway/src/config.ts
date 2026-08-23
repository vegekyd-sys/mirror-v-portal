import type { KeyConfig, PlanTier } from './types/index.js';

export interface GatewayConfig {
  port: number;
  tenantId: string;
  /** 'web' = no IM channel; the gateway runs as the tenant's LLM egress proxy only. */
  platform: 'feishu' | 'dingtalk' | 'wecom' | 'web';
  planTier: PlanTier;
  agentUrl: string;
  // B3 FIX: credits-ledger URL for HTTP debit/balance calls
  creditsLedgerUrl: string;
  // B3 FIX: shared service token for credits-ledger auth (optional)
  creditsLedgerToken?: string;
  keyConfig: KeyConfig;
  // B4 FIX: bot secret for signature verification
  botSecret?: string;
  allowedAppIds?: string[];
  initialCredits: number;
  // WSClient — Feishu app credentials for long-connection
  appId?: string;
  appSecret?: string;
  // Contact writeback — where to report the sender's im_open_id so ops-agent
  // lifecycle notifications can be delivered (see central-gateway notify relay).
  provisioningServiceUrl?: string;
  provisioningApiToken?: string;
  /**
   * LLM egress proxy — provider name → real upstream base URL. Injected via
   * the `llm-proxy-config` Secret (env LLM_UPSTREAMS, JSON) written by
   * provisioning-service at provider-library push time. Empty when the tenant
   * has no library configured (proxy routes then 404).
   */
  llmUpstreams: Record<string, string>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): GatewayConfig {
  const tenantId = required('DEALCLAW_TENANT_ID');
  const platform = (process.env.DEALCLAW_PLATFORM ?? 'feishu') as GatewayConfig['platform'];

  if (!['feishu', 'dingtalk', 'wecom', 'web'].includes(platform)) {
    throw new Error(`Unsupported DEALCLAW_PLATFORM: ${platform}`);
  }

  // LLM egress proxy upstream map — JSON { "<providerName>": "<baseUrl>" }.
  // Written by provisioning-service into the llm-proxy-config Secret.
  let llmUpstreams: Record<string, string> = {};
  const upstreamsRaw = (process.env.LLM_UPSTREAMS || '').trim();
  if (upstreamsRaw) {
    try {
      const parsed = JSON.parse(upstreamsRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && /^https?:\/\//.test(v)) llmUpstreams[k] = v.replace(/\/+$/, '');
        }
      }
    } catch {
      console.warn('[config] LLM_UPSTREAMS is not valid JSON — LLM proxy disabled');
    }
  }

  return {
    port: Number(process.env.PORT ?? 8080),
    tenantId,
    platform,
    planTier: (process.env.DEALCLAW_PLAN_TIER ?? 'starter') as PlanTier,
    agentUrl: required('DEALCLAW_AGENT_URL'),
    // Tenant credits secrets carry DEALCLAW_-prefixed keys; keep the bare
    // names as aliases for local/dev runs.
    creditsLedgerUrl:
      process.env.DEALCLAW_CREDITS_LEDGER_URL ?? process.env.CREDITS_LEDGER_URL ?? 'http://credits-ledger:8081',
    creditsLedgerToken:
      process.env.DEALCLAW_CREDITS_LEDGER_TOKEN ?? process.env.CREDITS_LEDGER_TOKEN ?? process.env.BILLING_SERVICE_TOKEN,
    initialCredits: Number(process.env.DEALCLAW_INITIAL_CREDITS ?? 0),
    botSecret: process.env.DEALCLAW_BOT_SECRET,
    allowedAppIds: process.env.DEALCLAW_ALLOWED_APP_IDS?.split(',').map(s => s.trim()),
    appId: process.env.DEALCLAW_APP_ID,
    appSecret: process.env.DEALCLAW_APP_SECRET,
    provisioningServiceUrl: process.env.PROVISIONING_SERVICE_URL,
    provisioningApiToken: process.env.PROVISIONING_API_TOKEN,
    llmUpstreams,
    keyConfig: {
      customerKeyRef: required('DEALCLAW_CUSTOMER_KEY_REF'),
      botCredentialRef: required('DEALCLAW_BOT_CREDENTIAL_REF'),
      // 账户 id 统一归一化为 acct_<tenantId>（兼容历史 credits- 前缀的坏值）
      creditsAccountId: (() => {
        const raw = process.env.DEALCLAW_CREDITS_ACCOUNT_ID;
        if (!raw) return `acct_${tenantId}`;
        return `acct_${raw.replace(/^acct_/, '').replace(/^credits-/, '')}`;
      })(),
      configVersion: process.env.DEALCLAW_CONFIG_VERSION ?? '1',
    },
  };
}
