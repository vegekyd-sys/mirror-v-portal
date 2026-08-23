/**
 * WSClient — Feishu WebSocket 长连接
 *
 * Each nexus-gateway Pod starts one WSClient for its assigned tenant.
 * On startup: fetch tenant_access_token → connect WS → listen for messages → forward to agent.
 *
 * Ported from central-gateway's onboarding-orchestrator (per-tenant isolation).
 */

import type { GatewayConfig } from './config.js';
import {
  getTenantAccessToken,
  replyToMessage,
  extractAgentReplyText,
} from './services/feishu-reply.js';

// ── Helpers ──

function buildAgentExecuteUrl(agentUrl: string): string {
  return `${agentUrl.replace(/\/$/, '')}/execute`;
}

function extractFeishuText(data: any): string {
  const msg = data?.message ?? data?.event?.message ?? data?.data?.event?.message;
  if (!msg || (msg.msg_type && msg.msg_type !== 'text')) return '';

  try {
    const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
    if (typeof content?.text === 'string') return content.text.trim();
    if (typeof msg.text === 'string') return msg.text.trim();
    return '';
  } catch {
    return typeof msg.text === 'string' ? msg.text.trim() : '';
  }
}

function formatErr(err: unknown) {
  const e = err as any;
  const cause = e?.cause;
  return {
    name: e?.name,
    message: e?.message,
    code: e?.code,
    cause: cause && typeof cause === 'object'
      ? { name: cause?.name, message: cause?.message, code: cause?.code }
      : cause,
    stack: typeof e?.stack === 'string' ? e.stack.split('\n').slice(0, 6).join('\n') : undefined,
  };
}

// ── Contact writeback ──
//
// ops-agent lifecycle notifications (expiry, suspension, grace) are delivered
// by central-gateway's notify relay to the im_open_id captured here. We report
// the sender of the first inbound message; the endpoint is an idempotent UPDATE.

let lastReportedOpenId: string | null = null;

async function reportContact(config: GatewayConfig, openId: string): Promise<boolean> {
  if (!config.provisioningServiceUrl) return false;
  try {
    const url = `${config.provisioningServiceUrl.replace(/\/$/, '')}/v1/tenants/${config.tenantId}/contact`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(config.provisioningApiToken ? { Authorization: `Bearer ${config.provisioningApiToken}` } : {}),
      },
      body: JSON.stringify({ platform: config.platform, imOpenId: openId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[ws:${config.tenantId}] contact writeback failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[ws:${config.tenantId}] contact writeback error: ${err.message}`);
    return false;
  }
}

// ── Main: start WSClient ──

/**
 * Whether this gateway pod should hold the Feishu WS long connection.
 * P2: when the tenant's message plane is the in-agent @openclaw/feishu
 * plugin ('openclaw'), the gateway must NOT start a second WS client —
 * Feishu load-balances events across connections, so two clients compete
 * for delivery. The gateway then serves purely as the LLM egress proxy.
 */
export function shouldStartWSClient(
  platform: string,
  messagePlane: string | undefined,
): boolean {
  if ((messagePlane || 'gateway') === 'openclaw') return false;
  return platform === 'feishu';
}

export async function startWSClient(config: GatewayConfig) {
  const { tenantId, appId, appSecret, agentUrl } = config;

  if (!appId || !appSecret) {
    console.warn(`[ws:${tenantId}] No app credentials configured — WSClient not started`);
    return;
  }

  // Fetch initial token
  const tokenResult = await getTenantAccessToken(appId, appSecret);
  if (!tokenResult.ok) {
    console.error(`[ws:${tenantId}] Failed to get tenant_access_token: ${tokenResult.error}`);
    return;
  }

  let currentAccessToken = tokenResult.token;
  const agentExecuteUrl = buildAgentExecuteUrl(agentUrl);
  console.log(`[ws:${tenantId}] agent url: ${agentExecuteUrl}`);

  const sdk = await import('@larksuiteoapi/node-sdk');

  const dispatcher = new sdk.EventDispatcher({ encryptKey: '', verificationToken: '' });
  dispatcher.register({ 'im.message.receive_v1': async (data: any) => {
    const msgId = data?.message?.message_id;
    const senderOpenId = data?.sender?.sender_id?.open_id;
    const traceId = `${tenantId}:${msgId || 'no-msg'}:${Date.now().toString(36)}`;

    if (!msgId) {
      console.warn(`[ws:${tenantId}] trace=${traceId} missing message_id`);
      return;
    }

    const t0 = Date.now();
    const textIn = extractFeishuText(data);
    console.log(`[ws:${tenantId}] trace=${traceId} inbound msg_id=${msgId} sender=${senderOpenId || '-'} text_len=${textIn.length}`);

    // Capture the sender's open_id for lifecycle notification delivery.
    // Fire-and-forget; never blocks or fails the message path.
    if (senderOpenId && senderOpenId !== lastReportedOpenId) {
      const target = senderOpenId;
      reportContact(config, target)
        .then(ok => { if (ok) lastReportedOpenId = target; })
        .catch(() => { /* reportContact never throws */ });
    }

    try {
      const agentReqBody = { intent: { kind: 'chat', text: textIn }, event: data, tenantId };
      const res = await fetch(agentExecuteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agentReqBody),
        signal: AbortSignal.timeout(25_000),
      });

      const agentT = Date.now() - t0;
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.warn(`[ws:${tenantId}] trace=${traceId} agent_status=${res.status} agent_ms=${agentT} body=${errBody.slice(0, 300)}`);
        return;
      }

      const reply = await res.json().catch((err: unknown) => {
        console.warn(`[ws:${tenantId}] trace=${traceId} agent_json_parse_failed`, formatErr(err));
        return {};
      });
      const text = extractAgentReplyText(reply) || '收到！';
      console.log(`[ws:${tenantId}] trace=${traceId} agent_ok agent_ms=${agentT} reply_len=${String(text).length}`);

      // Reply via Feishu API
      let sendRes = await replyToMessage(currentAccessToken, msgId, text);

      if (!sendRes.ok) {
        // Token refresh on expiry
        const errBody = await sendRes.text().catch(() => '');
        let errJson: any;
        try { errJson = JSON.parse(errBody); } catch { errJson = undefined; }

        if (sendRes.status === 400 && errJson?.code === 99991663) {
          const refreshed = await getTenantAccessToken(appId, appSecret);
          if (refreshed.ok && refreshed.token) {
            currentAccessToken = refreshed.token;
            console.warn(`[ws:${tenantId}] trace=${traceId} feishu token refreshed, retrying reply`);
            sendRes = await replyToMessage(currentAccessToken, msgId, text);
          }
        }
      }

      const feishuT = Date.now() - t0;
      if (sendRes.ok) {
        console.log(`[ws:${tenantId}] trace=${traceId} feishu_reply_ok total_ms=${feishuT}`);
      } else {
        console.warn(`[ws:${tenantId}] trace=${traceId} feishu reply failed: ${sendRes.status}`);
      }
    } catch (e) {
      console.warn(`[ws:${tenantId}] trace=${traceId} handler_failed`, formatErr(e));
    }
  }});

  const client = new sdk.WSClient({
    appId,
    appSecret,
    autoReconnect: true,
    onReady() {
      console.log(`[ws:${tenantId}] connected`);
    },
  });

  await client.start({ eventDispatcher: dispatcher });
  console.log(`[ws:${tenantId}] WSClient started`);
}
