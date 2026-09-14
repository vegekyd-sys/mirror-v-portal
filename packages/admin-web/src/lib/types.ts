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
  /** Feishu app id bound to this tenant (may be null when never bound). */
  feishuAppId?: string | null;
  /** Message plane: 'gateway' = nexus-gateway WS bridge; 'openclaw' = in-agent
   *  @openclaw/feishu plugin owns the Feishu long connection. */
  messagePlane?: 'gateway' | 'openclaw';
  /** True → Feishu and WeChat DM conversations share a single session
   *  (agent:dealclaw:main) for cross-channel continuity. Per-tenant toggle. */
  sharedDmSession?: boolean;
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

/**
 * 米奥（Mio）供应商目录 —— GET /v1/admin/mio-suppliers 的单条结果。
 * `id` 才是要绑定的值（写入 tenants.mio_cdp_supplier_id）；`code` 仅供展示。
 */
export interface MioSupplierOption {
  /** 米奥供应商 id（12 位数字）。 */
  id: string;
  /** 米奥内部编码 —— 不用于绑定。 */
  code: string | null;
  name: string | null;
}

/** GET /v1/admin/mio-suppliers —— 供应商模糊搜索（专供下拉）。 */
export interface MioSupplierSearchResponse {
  ok: boolean;
  items: MioSupplierOption[];
  total: number;
}

/** POST /v1/admin/mio-suppliers —— quickRegister 快速创建供应商。 */
export interface MioSupplierCreateResponse {
  ok: boolean;
  supplierId: string;
  name: string | null;
}

/** POST /v1/admin/mio-suppliers/backfill —— 存量补录的一条命中记录。 */
export interface MioSupplierBackfillEntry {
  tenantId: string;
  companyName: string;
  supplierId: string;
  supplierName: string | null;
  supplierCode: string | null;
  action: 'bound' | 'would_bind';
  restarted?: boolean;
}

/** 补录跳过原因：0 条/多条命中、不在候选范围、上游或写库失败。 */
export interface MioSupplierBackfillSkip {
  tenantId: string;
  companyName: string | null;
  reason: 'no_match' | 'multiple_matches' | 'not_candidate' | 'lookup_failed' | 'bind_failed';
  detail?: string;
  candidates?: MioSupplierOption[];
}

/** POST /v1/admin/mio-suppliers/backfill 响应（dryRun 默认 true）。 */
export interface MioSupplierBackfillResponse {
  ok: boolean;
  dryRun: boolean;
  scanned: number;
  matched: number;
  updated: number;
  entries: MioSupplierBackfillEntry[];
  skipped: MioSupplierBackfillSkip[];
}

/** POST /v1/tenants 响应。mioSupplier=null 表示本次创建未绑定米奥供应商。 */
export interface CreateTenantResponse {
  ok?: boolean;
  provisioned?: boolean;
  mioSupplier?: { supplierId: string } | null;
  tenant?: Tenant;
  provisioning?: { dryRun?: boolean } | null;
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
