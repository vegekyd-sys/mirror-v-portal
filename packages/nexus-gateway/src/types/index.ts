/**
 * Nexus Agent Gateway — Core Types
 * 
 * The Gateway sits in each customer Pod, receiving Bot webhook
 * requests and handling auth/credits/scene/audit before forwarding
 * to the DealClaw Agent.
 */

// ── Tenant & Identity ──

export interface TenantContext {
  tenantId: string;
  userId: string;
  platform: 'feishu' | 'dingtalk' | 'wecom';
  role: 'admin' | 'member' | 'readonly';
}

// ── Key Configuration (injected at pod init, read-only at runtime) ──

export interface KeyConfig {
  customerKeyRef: string;       // K8s Secret ref for customer API Key
  botCredentialRef: string;     // Bot credential (feishu app id/secret etc)
  creditsAccountId: string;     // Credits ledger account ID
  configVersion: string;        // For canary rollback
}

// ── Plan / Tier ──

export type PlanTier = 'starter' | 'growth' | 'pro' | 'team';

export interface PlanConfig {
  tier: PlanTier;
  maxAgents: number;
  cpuLimit: string;
  memoryLimit: string;
  scenes: string[];             // Unlocked scenes e.g. ['lead','expo','email','research']
  monthlyCredits: number;
}

// ── Credits ──

export interface CreditsCheckResult {
  sufficient: boolean;
  remaining: number;
  required: number;
  accountId: string;
}

// ── Gateway Request / Response ──

export interface GatewayRequest {
  // From IM platform
  platformMessageId: string;
  platformUserId: string;
  rawPayload: unknown;          // Platform-specific message payload

  // Extracted by Gateway
  tenantId: string;
  intent: AgentIntent;
}

export type AgentIntent =
  | { kind: 'chat'; text: string }
  | { kind: 'command'; action: string; args?: Record<string, string> }
  | { kind: 'query'; resource: string; filters?: Record<string, string> }
  | { kind: 'action'; operation: string; params?: Record<string, unknown> };

// ── Gateway Response (to Agent) ──

export interface AgentContext {
  tenant: TenantContext;
  keyConfig: KeyConfig;
  plan: PlanConfig;
  credits: CreditsCheckResult;
  sceneUnlocked: string[];
}

// ── Credits Operation ──

export interface CreditsLedgerEntry {
  id: string;
  accountId: string;
  operation: 'debit' | 'credit' | 'refund';
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reference: string;           // e.g. order_id, api_call_id
  description: string;
  timestamp: string;
}

// ── Audit Log ──

export interface AuditLogEntry {
  id: string;
  tenantId: string;
  userId: string;
  action: string;
  resource: string;
  detail: string;
  ip: string;
  timestamp: string;
}

// ── Gateway Pipeline Result ──

export interface GatewayPipelineResult {
  allowed: boolean;
  agentContext?: AgentContext;
  error?: GatewayError;
}

export interface GatewayError {
  code: 'UNAUTHORIZED' | 'INSUFFICIENT_CREDITS' | 'SCENE_LOCKED' | 'RATE_LIMITED' | 'TENANT_SUSPENDED' | 'SERVICE_UNAVAILABLE';
  message: string;
  detail?: string;
}

// ── Gateway HTTP Headers (injected into Agent request) ──

export const GATEWAY_HEADERS = {
  TENANT_ID: 'X-DealClaw-Tenant-ID',
  USER_ID: 'X-DealClaw-User-ID',
  KEY_CONFIG_REF: 'X-DealClaw-Key-Config-Ref',
  CREDITS_REMAINING: 'X-DealClaw-Credits-Remaining',
  SCENE_UNLOCKED: 'X-DealClaw-Scene-Unlocked',
  PLAN_TIER: 'X-DealClaw-Plan-Tier',
} as const;
