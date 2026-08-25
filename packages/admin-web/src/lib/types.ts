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
  /** Mio CDP supplier id — optional tenant credential for Mio CDP skills. */
  mioCdpSupplierId?: string | null;
  /** True → tenant bypasses nexus-gateway and uses real upstream LLM URLs. */
  directMode?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ImageRelease {
  id: number;
  service: string;
  tag: string;
  image: string;
  gitCommit?: string | null;
  buildNumber?: string | null;
  buildEnv?: string | null;
  createdBy?: string | null;
  notes?: string | null;
  createdAt?: string;
  promoted?: boolean;
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
