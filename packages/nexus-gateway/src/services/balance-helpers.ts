/**
 * Balance helpers — shared by the LLM egress proxy (synthesized balance
 * replies) and the /v1/agent/balance endpoint.
 */

export interface BalanceInfo {
  companyName: string;
  availableBalance: number;
  frozenCredits: number;
  lifetimeConsumed: number;
  planTier: string;
  planName: string;
  status: string;
  subscriptionEnd: string | null;
  liveConsumed?: number;
  shadowConsumed?: number;
}

/** Check if the message is asking about balance/credits */
export function isBalanceQuery(text: string): boolean {
  const patterns = [
    /^查余额$/, /^余额$/, /^我的余额$/, /^credit$/i, /^credits$/i,
    /查.*余额/, /看.*余额/, /还剩.*(多少|余额|credit|额度)/i,
    /剩余.*credit/i, /剩余.*额度/,
    /有多少.*credit/i, /用量.*(多少|明细|情况)/, /消耗.*(多少|明细|情况|本月|账单)/i,
    /my balance/i,
  ];
  return patterns.some(p => p.test(text));
}

export async function fetchCustomerBalance(
  ledgerUrl: string,
  accountId: string,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BalanceInfo | null> {
  // Derive tenant ID from account ID (acct_<tenantId>)
  const tenantId = accountId.startsWith('acct_') ? accountId.slice(5) : accountId;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetchImpl(`${ledgerUrl.replace(/\/$/, '')}/v1/admin/customers/${encodeURIComponent(tenantId)}`, {
      signal: AbortSignal.timeout(5_000),
      headers,
    });
    if (!res.ok) return null;
    return await res.json() as Promise<BalanceInfo>;
  } catch {
    return null;
  }
}

export function formatBalanceReply(info: BalanceInfo): string {
  const k = (n: number) => n ? `${(n / 1000).toFixed(1)}K` : '0';
  const statusEmoji = info.status === 'active' ? '✅' : info.status === 'suspended' ? '⏸️' : '🔴';
  const lines = [
    `💰 **${info.companyName || '账户'}** · ${statusEmoji} ${info.planName || info.planTier || ''}`,
    '',
    `可用余额：**${k(info.availableBalance)}** Credits`,
  ];
  if (info.frozenCredits > 0) {
    lines.push(`（其中冻结 ${k(info.frozenCredits)}：${info.subscriptionEnd ? '慧展权益预留' : '预留'}）`);
  }
  if (info.liveConsumed != null) {
    lines.push(`本月已用：${k(info.liveConsumed)}`);
  }
  if (info.shadowConsumed != null && info.shadowConsumed > 0) {
    lines.push(`内测消耗：${k(info.shadowConsumed)}（不计费）`);
  }
  if (info.subscriptionEnd) {
    const endDate = new Date(info.subscriptionEnd).toLocaleDateString('zh-CN');
    lines.push(`套餐到期：${endDate}`);
  }
  lines.push('', `📊 详情：https://43.156.232.2:8443/credit-info.html`);
  return lines.join('\n');
}
