/**
 * Credits Ledger HTTP integration.
 * Fetches real credit balances from credits-ledger API.
 */

export interface CreditsInfo {
  balance: number;
  monthlyUsed: number;
  monthlyAllowance: number;
}

/**
 * Get credits balance for a single account from credits-ledger.
 * Returns zero-values on network error (fail-open — don't block ops scan).
 *
 * Auth: credits-ledger requires a service token (PAYMENT_SERVICE_TOKEN /
 * BILLING_SERVICE_TOKEN) on /v1/accounts/*. Without the Bearer header the
 * ledger answers 401 and the fail-open path silently reports balance 0 —
 * which previously caused healthy tenants to be flagged `low_credits`.
 */
export async function getCreditsBalance(
  creditsLedgerUrl: string,
  accountId: string,
  token?: string,
): Promise<CreditsInfo> {
  try {
    const url = `${creditsLedgerUrl.replace(/\/$/, '')}/v1/accounts/${accountId}/balance`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });

    if (!res.ok) {
      console.warn(`Credits check failed for ${accountId}: HTTP ${res.status}`);
      return { balance: 0, monthlyUsed: 0, monthlyAllowance: 0 };
    }

    const data = await res.json();

    return {
      balance: data.balance ?? data.credits ?? 0,
      monthlyUsed: data.monthlyUsed ?? data.usage?.monthly ?? 0,
      monthlyAllowance: data.monthlyAllowance ?? data.allowance ?? 0,
    };
  } catch (err) {
    console.warn(`Credits check error for ${accountId}:`, (err as Error).message);
    return { balance: 0, monthlyUsed: 0, monthlyAllowance: 0 };
  }
}

/**
 * Enrich tenants with real credit balances.
 * Each call is independent — one slow account doesn't block others.
 */
export async function enrichWithCredits(
  creditsLedgerUrl: string,
  tenantIds: string[],
  token?: string,
): Promise<Map<string, CreditsInfo>> {
  const results = new Map<string, CreditsInfo>();

  const tasks = tenantIds.map(async (tenantId) => {
    const accountId = `acct_${tenantId}`;
    const info = await getCreditsBalance(creditsLedgerUrl, accountId, token);
    results.set(tenantId, info);
  });

  await Promise.allSettled(tasks);
  return results;
}
