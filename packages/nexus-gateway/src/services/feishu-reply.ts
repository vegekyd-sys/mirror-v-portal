/**
 * Shared Feishu message reply utilities.
 * Used by both WSClient and webhook handler.
 */

let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getTenantAccessToken(appId: string, appSecret: string) {
  // Return cached token if still valid (5-min safety margin)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 300_000) {
    return { ok: true as const, token: cachedToken.token };
  }

  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false as const, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  const data = await res.json() as { tenant_access_token?: string; code?: number; msg?: string; expire?: number };
  if (data.tenant_access_token) {
    cachedToken = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
    };
    return { ok: true as const, token: data.tenant_access_token };
  }
  return { ok: false as const, error: `Feishu API error: code=${data.code} msg=${data.msg}` };
}

export async function replyToMessage(token: string, messageId: string, text: string) {
  return fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      content: JSON.stringify({ text }),
      msg_type: 'text',
    }),
    signal: AbortSignal.timeout(5_000),
  });
}

const TOKEN_EXPIRED_CODE = 99991663;

export interface ReplyResult {
  ok: boolean;
  status: number;
  error?: string;
}

export async function sendReply(
  appId: string,
  appSecret: string,
  messageId: string,
  text: string,
): Promise<ReplyResult> {
  // Get token (cached or fresh)
  let tokenResult = await getTenantAccessToken(appId, appSecret);
  if (!tokenResult.ok) {
    return { ok: false, status: 0, error: `Token error: ${tokenResult.error}` };
  }

  // First attempt
  let res = await replyToMessage(tokenResult.token, messageId, text);

  // Token expired — refresh and retry once
  if (!res.ok && res.status === 400) {
    try {
      const body = await res.json();
      if (body?.code === TOKEN_EXPIRED_CODE) {
        // Invalidate cache and refetch
        cachedToken = null;
        tokenResult = await getTenantAccessToken(appId, appSecret);
        if (tokenResult.ok) {
          res = await replyToMessage(tokenResult.token, messageId, text);
        }
      }
    } catch { /* body parse failed, don't retry */ }
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errBody.slice(0, 300) };
  }

  return { ok: true, status: res.status };
}

/** Extract reply text from dealclaw-agent bridge response */
export function extractAgentReplyText(body: unknown): string {
  const b = body as any;
  // Bridge format: { type: "agent_response", result: { summary: "..." } }
  if (typeof b?.result?.summary === 'string' && b.result.summary.trim()) {
    return b.result.summary.trim();
  }
  // Fallbacks
  if (typeof b?.text === 'string' && b.text.trim()) return b.text.trim();
  if (typeof b?.content === 'string' && b.content.trim()) return b.content.trim();
  return '';
}
