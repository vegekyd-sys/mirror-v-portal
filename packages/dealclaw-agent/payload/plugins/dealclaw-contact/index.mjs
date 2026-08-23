/**
 * DealClaw Contact Writeback
 * ---------------------------
 * P2 迁移：飞书直连插件接管消息面后，im_open_id 的捕获从 nexus-gateway
 * ws-client 迁到这里。首个入站消息的 sender open_id 回写 provisioning
 * （幂等 UPDATE），central-gateway 的 notify relay 据此投递生命周期通知。
 *
 * 语义与原 ws-client reportContact 完全对齐：
 *   - fire-and-forget，绝不阻塞/失败消息主链路
 *   - 内存去重：同一 open_id 只报一次（重启后重报无害，端点幂等）
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const TENANT_ID = process.env.DEALCLAW_TENANT_ID || '';
const PROVISIONING_URL = (process.env.PROVISIONING_SERVICE_URL || '').replace(/\/$/, '');
const PROVISIONING_TOKEN = process.env.PROVISIONING_API_TOKEN || '';

let lastReportedOpenId = null;

/** 从 message_received 事件的多个可能形态里提取 sender open_id。 */
function extractOpenId(event) {
  const ctx = event?.ctx || {};
  const candidates = [
    ctx.From?.id,
    typeof ctx.From === 'string' ? ctx.From : null,
    event?.message?.from?.id,
    event?.message?.from,
    ctx.RawBody?.sender?.sender_id?.open_id,
    event?.rawBody?.sender?.sender_id?.open_id,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

/** 只关心飞书渠道的入站消息（web/bridge 路径不需要回写）。 */
function isFeishuInbound(event) {
  const ctx = event?.ctx || {};
  const channel = ctx.OriginatingChannel || ctx.channel || event?.channel;
  if (typeof channel === 'string' && channel) return channel.toLowerCase().includes('feishu');
  // 渠道信息缺失时不放走——本插件只挂在这类事件上，宁可多报一次幂等 UPDATE。
  return true;
}

async function reportContact(openId) {
  const url = `${PROVISIONING_URL}/v1/tenants/${TENANT_ID}/contact`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(PROVISIONING_TOKEN ? { Authorization: `Bearer ${PROVISIONING_TOKEN}` } : {}),
      },
      body: JSON.stringify({ platform: 'feishu', imOpenId: openId }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[dc-contact] writeback failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[dc-contact] writeback error: ${err?.message ?? err}`);
    return false;
  }
}

export default definePluginEntry({
  id: 'dealclaw-contact',
  name: 'DealClaw Contact Writeback',
  description: 'Reports the sender im_open_id to provisioning for lifecycle notification delivery.',
  register(api) {
    if (!TENANT_ID || !PROVISIONING_URL) {
      console.warn('[dc-contact] DEALCLAW_TENANT_ID / PROVISIONING_SERVICE_URL not set — contact writeback disabled');
      return;
    }

    api.on('message_received', async (event) => {
      try {
        if (!isFeishuInbound(event)) return;
        const openId = extractOpenId(event);
        if (!openId || openId === lastReportedOpenId) return;
        const ok = await reportContact(openId);
        if (ok) lastReportedOpenId = openId;
      } catch {
        /* never throw out of a hook */
      }
    });
  },
});
