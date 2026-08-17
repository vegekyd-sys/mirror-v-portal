/**
 * DealClaw Billing Client — shared integration surface for credits-ledger.
 *
 * This module is the single, canonical way for any DealClaw component
 * (nexus-gateway, dealclaw-agent, ops-agent, cron jobs) to talk to the
 * credits-ledger billing API. It encapsulates:
 *
 *   1. Tenant identity — billing is always keyed by the tenantId supplied by
 *      the caller (the gateway's own per-pod config.tenantId). Feishu open_id
 *      / group_id are captured as audit metadata only and are never used to
 *      resolve a different tenant across multi-tenant deployments.
 *   2. The estimate → execute → settle billing flow.
 *   3. Balance / affordability checks.
 *
 * Account convention: every tenant has ONE credit account whose id is
 * `acct_<tenantId>` (e.g. tenant `xiaoyuan-wenhua` → `acct_xiaoyuan-wenhua`).
 *
 * Billing modes (returned by the ledger, decided by skill_prices):
 *   - live      → real debit against the account
 *   - shadow    → record the event only, actualCredit = 0
 *   - unapproved→ same as shadow (pending/rejected price)
 */

export interface BillingConfig {
  /** Reserved for future per-tenant sub-accounting. Billing identity is the
   *  caller-supplied tenantId (gateway config); open_id/group_id are audit only. */
  defaultBehavior?: { unknownTenant?: 'shadow' | 'live' };
}

export interface EstimateResult {
  ok: boolean;
  eventId?: string;
  estimatedCredit?: number;
  billingMode?: 'live' | 'shadow' | 'unapproved';
  skillName?: string;
  unitPrice?: number;
  isDefault?: boolean;
  error?: string;
  code?: string;
}

export interface SettleResult extends EstimateResult {
  actualCredit?: number;
  transactionId?: string;
}

export interface CanAffordResult {
  canAfford: boolean;
  estimatedCredit: number;
  balance: number;
  reason?: string;
}

export interface BalanceInfo {
  balance: number;
  available: number;
  lifetimeConsumed: number;
  planTier?: string;
  status?: string;
}

export interface BillAroundOptions {
  /** Feishu open_id — audit metadata only (who triggered the bill), never billing identity. */
  openId?: string;
  /** Feishu group chat_id — audit metadata only. */
  groupId?: string;
  /** Billing tenant (required). The gateway always supplies its own config.tenantId. */
  tenantId: string;
  skillId: string;
  quantity?: number;
  /** Optional task/idempotency correlation id (stored on the billing event). */
  taskId?: string;
  metadata?: Record<string, unknown>;
  /** Reserved. Billing tenant is now always explicit (see tenantId). */
  failOpen?: boolean;
}

export class BillingError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

export class BillingClient {
  private readonly ledgerUrl: string;
  private readonly token?: string;

  constructor(options: {
    ledgerUrl?: string;
    token?: string;
  } = {}) {
    this.ledgerUrl = (options.ledgerUrl ?? process.env.DC_BILLING_URL ?? 'http://localhost:8081').replace(/\/$/, '');
    this.token = options.token ?? process.env.DC_BILLING_TOKEN;
  }

  // ── Tenant identity ────────────────────────────────────
  // Billing identity is the caller-supplied tenantId (gateway config).
  // open_id / group_id are audit metadata only — never mapped across tenants.

  /** accountId = acct_<tenantId> */
  accountId(tenantId: string): string {
    return `acct_${tenantId}`;
  }

  // ── HTTP plumbing ──────────────────────────────────────

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.ledgerUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new BillingError(
        (data as any).message || (data as any).error || `ledger HTTP ${res.status}`,
        (data as any).code,
        res.status,
      );
    }
    return data as T;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.ledgerUrl}${path}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new BillingError(
        (data as any).message || (data as any).error || `ledger HTTP ${res.status}`,
        (data as any).code,
        res.status,
      );
    }
    return data as T;
  }

  // ── Billing API ────────────────────────────────────────

  async estimate(tenantId: string, skillId: string, quantity = 1, opts: { taskId?: string; metadata?: Record<string, unknown> } = {}): Promise<EstimateResult> {
    const result = await this.post<EstimateResult>('/v1/billing/estimate', {
      tenantId,
      accountId: this.accountId(tenantId),
      taskId: opts.taskId,
      skillId,
      quantity,
      metadata: opts.metadata ?? {},
    });
    if (!result.ok) {
      throw new BillingError(result.error || 'Estimate failed', result.code);
    }
    return result;
  }

  async settle(tenantId: string, skillId: string, estimatedEventId: string, quantity = 1, opts: { taskId?: string; resultSummary?: string; metadata?: Record<string, unknown> } = {}): Promise<SettleResult> {
    const result = await this.post<SettleResult>('/v1/billing/settle', {
      tenantId,
      accountId: this.accountId(tenantId),
      taskId: opts.taskId,
      skillId,
      quantity,
      estimatedEventId,
      resultSummary: opts.resultSummary ?? 'completed',
      metadata: opts.metadata ?? {},
    });
    if (!result.ok) {
      throw new BillingError(result.error || 'Settle failed', result.code, result.code === 'INSUFFICIENT_CREDITS' ? 402 : undefined);
    }
    return result;
  }

  async canAfford(tenantId: string, skillId: string, quantity = 1): Promise<CanAffordResult> {
    return this.post<CanAffordResult>('/v1/billing/can-afford', {
      accountId: this.accountId(tenantId),
      skillId,
      quantity,
    });
  }

  async balance(tenantId: string): Promise<BalanceInfo> {
    return this.get<BalanceInfo>(`/v1/accounts/${this.accountId(tenantId)}/full`);
  }

  // ── High-level: estimate → execute → settle ────────────

  /**
   * The canonical billing wrapper. Estimates, runs the work, and settles on
   * success — keyed by the caller-supplied `tenantId` (the gateway's own
   * config). open_id / group_id are attached as audit metadata.
   *
   * @returns { settled, estimate, result } — `result` is the return value of `run`.
   */
  async billAround<T>(
    opts: BillAroundOptions,
    run: () => Promise<T>,
  ): Promise<{ settled: SettleResult | null; estimate: EstimateResult; result: T }> {
    const quantity = opts.quantity ?? 1;

    // 1. Billing tenant is required — the gateway always supplies its own
    //    config.tenantId (correct across multi-tenant deployments).
    const tenantId = opts.tenantId;
    if (!tenantId) {
      throw new BillingError('tenantId is required for billing', 'TENANT_REQUIRED');
    }

    // Audit identity — attached to the billing event, never used for routing.
    const auditMeta: Record<string, unknown> = {
      ...(opts.metadata ?? {}),
      ...(opts.openId ? { openId: opts.openId } : {}),
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
    };

    // 2. Estimate (creates skill_billing_events row, status='estimated')
    const estimate = await this.estimate(tenantId, opts.skillId, quantity, {
      taskId: opts.taskId,
      metadata: auditMeta,
    });

    // 3. Run the actual work
    const result = await run();

    // 4. Settle (debits if live; records-only if shadow)
    const settled = await this.settle(tenantId, opts.skillId, estimate.eventId!, quantity, {
      taskId: opts.taskId,
      resultSummary: 'completed',
      metadata: auditMeta,
    });

    return { settled, estimate, result };
  }
}
