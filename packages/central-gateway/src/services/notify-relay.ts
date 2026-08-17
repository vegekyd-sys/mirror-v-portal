/**
 * Notify Relay — delivers lifecycle notifications on behalf of ops-agent.
 *
 * Why this lives in central-gateway: ops-agent suspends tenant Pods
 * (scale to 0) at exactly the moments lifecycle notifications must be sent
 * (expiry, suspension, grace). Per-tenant nexus-gateway Pods are offline by
 * then, so a centrally always-on service must own delivery.
 *
 * Flow:
 *   1. Read tenant bot credentials + im_open_id from provisioning-service.
 *   2. Acquire tenant_access_token for the tenant's own Feishu app.
 *   3. Send a p2p message to the captured im_open_id.
 *
 * Idempotency is owned by ops-agent (tenant_notifications.dedup_key);
 * this relay is stateless.
 */

import type { CentralConfig } from '../config.js';

export interface NotifyPayload {
  tenantId: string;
  channel: 'bot' | 'email' | 'all';
  notificationType?: string;
  dedupKey?: string;
  message: string;
}

export interface RelayResult {
  ok: boolean;
  delivered: string[];
  skipped: string[];
  reason?: string;
  error?: string;
}

interface TenantContact {
  appId: string | null;
  appSecret: string | null;
  platform: string;
  imOpenId: string | null;
}

const TOKEN_EXPIRED_CODE = 99991663;

// ── tenant_access_token cache (per appId, 5-min safety margin) ──

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getTenantAccessToken(
  appId: string,
  appSecret: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const cached = tokenCache.get(appId);
  if (cached && Date.now() < cached.expiresAt - 300_000) {
    return { ok: true, token: cached.token };
  }

  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Token HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = await res.json() as { tenant_access_token?: string; code?: number; msg?: string; expire?: number };
    if (data.tenant_access_token) {
      tokenCache.set(appId, {
        token: data.tenant_access_token,
        expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
      });
      return { ok: true, token: data.tenant_access_token };
    }
    return { ok: false, error: `Token API code=${data.code} msg=${data.msg}` };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ── Provisioning lookup ──

async function fetchTenantContact(
  config: CentralConfig,
  tenantId: string,
): Promise<{ ok: true; contact: TenantContact } | { ok: false; error: string }> {
  try {
    const url = `${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/tenants/${tenantId}/credentials`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...(config.provisioningApiToken ? { Authorization: `Bearer ${config.provisioningApiToken}` } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      return { ok: false, error: `Provisioning HTTP ${res.status}` };
    }

    const body = await res.json() as { appId?: string | null; appSecret?: string | null; platform?: string; imOpenId?: string | null };
    return {
      ok: true,
      contact: {
        appId: body.appId ?? null,
        appSecret: body.appSecret ?? null,
        platform: body.platform ?? 'feishu',
        imOpenId: body.imOpenId ?? null,
      },
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ── Feishu direct message ──

async function sendDirectMessage(
  token: string,
  openId: string,
  text: string,
): Promise<Response> {
  return fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
    signal: AbortSignal.timeout(5_000),
  });
}

/**
 * Deliver one notification. Always resolves; errors are reported in-band so
 * ops-agent can persist them to tenant_notifications.delivery_error.
 */
export async function relayNotification(
  config: CentralConfig,
  payload: NotifyPayload,
): Promise<RelayResult> {
  const { tenantId, channel, message } = payload;

  // 1. Look up credentials + contact
  const contactResult = await fetchTenantContact(config, tenantId);
  if (!contactResult.ok) {
    return { ok: false, delivered: [], skipped: [], error: `Contact lookup failed: ${contactResult.error}` };
  }
  const contact = contactResult.contact;

  const wantsBot = channel === 'bot' || channel === 'all';
  const wantsEmail = channel === 'email' || channel === 'all';
  const delivered: string[] = [];
  const skipped: string[] = [];

  // 2. Email channel — no email service yet (see design doc); be explicit.
  if (wantsEmail) {
    skipped.push('email:not-implemented');
  }

  if (!wantsBot) {
    return {
      ok: skipped.length > 0,
      delivered,
      skipped,
      reason: delivered.length === 0 ? 'no-deliverable-channel' : undefined,
    };
  }

  // 3. Bot channel — only Feishu is supported for now.
  if (contact.platform !== 'feishu') {
    skipped.push(`bot:platform-${contact.platform}-not-supported`);
    return { ok: false, delivered, skipped, reason: 'unsupported-platform' };
  }
  if (!contact.appId || !contact.appSecret) {
    return { ok: false, delivered, skipped, reason: 'no-bot-credentials' };
  }
  if (!contact.imOpenId) {
    // Tenant never messaged the bot — nothing to reply to. The open_id is
    // captured by nexus-gateway on first inbound message.
    return { ok: false, delivered, skipped, reason: 'no-im-open-id' };
  }

  const tokenResult = await getTenantAccessToken(contact.appId, contact.appSecret);
  if (!tokenResult.ok) {
    return { ok: false, delivered, skipped, error: `Token: ${tokenResult.error}` };
  }

  let res = await sendDirectMessage(tokenResult.token, contact.imOpenId, message);

  // Token expired mid-flight → invalidate cache, refresh once, retry.
  if (!res.ok && res.status === 400) {
    try {
      const body = await res.clone().json();
      if (body?.code === TOKEN_EXPIRED_CODE) {
        tokenCache.delete(contact.appId);
        const refreshed = await getTenantAccessToken(contact.appId, contact.appSecret);
        if (refreshed.ok) {
          res = await sendDirectMessage(refreshed.token, contact.imOpenId, message);
        }
      }
    } catch { /* body parse failed — fall through with original response */ }
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return {
      ok: false,
      delivered,
      skipped,
      error: `Feishu send HTTP ${res.status}: ${errBody.slice(0, 300)}`,
    };
  }

  delivered.push('bot:feishu');
  return { ok: true, delivered, skipped };
}
