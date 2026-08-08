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
 */
export async function getCreditsBalance(
  creditsLedgerUrl: string,
  accountId: string,
): Promise<CreditsInfo> {
  try {
    const url = `${creditsLedgerUrl.replace(/\/$/, '')}/v1/accounts/${accountId}/balance`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
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
): Promise<Map<string, CreditsInfo>> {
  const results = new Map<string, CreditsInfo>();

  const tasks = tenantIds.map(async (tenantId) => {
    const accountId = `credits-${tenantId}`;
    const info = await getCreditsBalance(creditsLedgerUrl, accountId);
    results.set(tenantId, info);
  });

  await Promise.allSettled(tasks);
  return results;
}
