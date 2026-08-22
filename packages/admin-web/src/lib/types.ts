// Shared API response types (provisioning-service / credits-ledger).

export interface Tenant {
  tenantId: string;
  companyName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  planTier?: string | null;
  status?: string | null;
  k8sNamespace?: string | null;
  creditsAccountId?: string | null;
  quotaAgents?: number | null;
  quotaCreditsMonthly?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface StatusLogEntry {
  from: string | null;
  to: string;
  reason: string | null;
  at: string;
}

export const TENANT_STATUSES = [
  'pending',
  'provisioning',
  'active',
  'provisioning_failed',
  'suspended',
  'low_credits',
  'grace',
  'destroyed',
] as const;
