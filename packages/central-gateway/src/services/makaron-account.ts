export class MakaronAccountError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

/** Validate the customer's own account without creating a project or spending credits. */
export async function signupAccountSecrets(templateId: string, value: unknown, automaticProvisioning = false): Promise<Record<string, string> | undefined> {
  if (templateId !== 'makaron') return undefined;
  // Only the trusted runtime catalog can enable scan-first automatic accounts.
  if (automaticProvisioning && (value == null || value === '')) return undefined;
  if (typeof value !== 'string' || !/^mk_live_[A-Za-z0-9_-]{20,200}$/.test(value.trim()))
    throw new MakaronAccountError('MAKARON_ACCOUNT_REQUIRED', 400, '请先连接你的 Makaron 账号，再生成二维码');
  const key = value.trim();
  let response: Response;
  try {
    response = await fetch('https://www.makaron.app/api/billing/credits', {
      headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
  } catch { throw new MakaronAccountError('MAKARON_ACCOUNT_UNAVAILABLE', 503, 'Makaron 账号暂时无法连接，请稍后重试'); }
  if (response.status === 401 || response.status === 403)
    throw new MakaronAccountError('MAKARON_ACCOUNT_INVALID', 400, '无法连接该 Makaron 账号，请检查 API Key');
  if (!response.ok) throw new MakaronAccountError('MAKARON_ACCOUNT_UNAVAILABLE', 503, 'Makaron 账号暂时无法连接，请稍后重试');
  return { MAKARON_API_KEY: key };
}
