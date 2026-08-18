/**
 * credits-account.ts — provisioning-service → credits-ledger integration.
 *
 * 当 K8s 新租户 onboarding 时，provisioning-service 必须**同时**在 credits-ledger
 * 里创建对应的 credits_accounts 记录，否则租户 agent 计费会 `ACCOUNT_NOT_FOUND`。
 *
 * 身份一致性（Issue 1 修复核心）：
 *   - provisioning 的 tenant_id 是 UUID（128-bit）。
 *   - credits-ledger 的账户 id = `acct_<tenant_id>`。
 *   这里用**同一个 UUID** 作为 tenantId 调 createCustomer，保证两边账户 id 对齐：
 *   `credits_account_id`(tenants 表) === `acct_<UUID>` === credits_accounts.id。
 *
 * planTier → planId 映射：
 *   provisioning 用 starter/pro/enterprise；credits-ledger plan_templates 用
 *   start/growth/ultra/enterprise。默认映射 starter→start / pro→growth /
 *   enterprise→enterprise（可被环境变量 PLAN_ID_BY_TIER 覆盖）。
 */

const DEFAULT_PLAN_ID_BY_TIER: Record<string, string> = {
  starter: 'start',
  pro: 'growth',
  enterprise: 'enterprise',
};

function planIdForTier(planTier: string): string {
  let overrides: Record<string, string> = {};
  try {
    if (process.env.PLAN_ID_BY_TIER) {
      overrides = JSON.parse(process.env.PLAN_ID_BY_TIER);
    }
  } catch { /* ignore malformed JSON */ }
  return overrides[planTier] ?? DEFAULT_PLAN_ID_BY_TIER[planTier] ?? 'start';
}

export interface CreateCreditsAccountParams {
  tenantId: string;
  companyName?: string;
  contactEmail?: string;
  planTier: 'starter' | 'pro' | 'enterprise';
  creditsLedgerUrl: string;
  creditsLedgerToken: string;
}

export interface CreateCreditsAccountResult {
  ok: boolean;
  accountId?: string;
  planId?: string;
  error?: string;
}

/**
 * 幂等地在 credits-ledger 创建客户账户。
 * - 已存在（active）→ credits-ledger 返回 400 DUPLICATE，这里视为 ok（幂等）。
 * - 账户被 suspended/closed → createCustomer 会自动 re-activate 并返回 ok。
 * - credits-ledger 不可达 → 返回 ok:false（调用方决定是否 fail provisioning）。
 */
export async function createCreditsAccount(
  params: CreateCreditsAccountParams,
): Promise<CreateCreditsAccountResult> {
  const planId = planIdForTier(params.planTier);
  const url = `${params.creditsLedgerUrl.replace(/\/$/, '')}/v1/admin/customers`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (params.creditsLedgerToken) headers['Authorization'] = `Bearer ${params.creditsLedgerToken}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tenantId: params.tenantId,
        companyName: params.companyName,
        contactEmail: params.contactEmail,
        planId,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      return { ok: true, accountId: data.accountId || `acct_${params.tenantId}`, planId };
    }

    // 400 DUPLICATE = 账户已存在 → 幂等成功
    if (data?.code === 'DUPLICATE') {
      return { ok: true, accountId: `acct_${params.tenantId}`, planId };
    }

    return { ok: false, error: data?.message || data?.error || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
