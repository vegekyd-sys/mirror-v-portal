/**
 * DealClaw Chat Log
 * -----------------
 * 把租户 Agent 的每一条入站/出站消息全文上报 provisioning-service
 * （chat_messages 表），供管理后台「对话记录」页渲染会话历史。
 *
 * 事件契约（OpenClaw 2026.7.1 dist/message-hook-mappers 实证）：
 *   - message_received: { content, senderId, from, messageId, sessionKey,
 *     runId, metadata: { senderName, senderUsername, originatingChannel } }
 *   - message_sent:     { to, content, success, messageId?, sessionKey?,
 *     runId?, error? }
 *   - ctx（第二参数）: { senderId?, channelId?, sessionKey?, runId? }
 *
 * 工程约束（与 dealclaw-contact 一致）：
 *   - fire-and-forget，绝不阻塞/失败消息主链路
 *   - 内存去重 messageId（重启后重报无害，端点按 (tenant_id, message_id)
 *     UNIQUE 幂等丢弃）
 *   - runId 为空的出站消息 = cron/heartbeat 主动消息，照报不误——后端
 *     用 run_id 空区分，UI 侧可过滤
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const TENANT_ID = process.env.DEALCLAW_TENANT_ID || '';
const PROVISIONING_URL = (process.env.PROVISIONING_SERVICE_URL || '').replace(/\/$/, '');
const PROVISIONING_TOKEN = process.env.PROVISIONING_API_TOKEN || '';

/** 有界去重集：同一 messageId 只报一次，超过上限按插入序淘汰。 */
const seenMessageIds = new Set();
const SEEN_MAX = 2000;

function seen(messageId) {
  if (!messageId) return false;
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.add(messageId);
  if (seenMessageIds.size > SEEN_MAX) {
    const oldest = seenMessageIds.values().next().value;
    seenMessageIds.delete(oldest);
  }
  return false;
}

function str(v, max = 4096) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

async function report(payload) {
  const url = `${PROVISIONING_URL}/v1/tenants/${TENANT_ID}/chat-messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PROVISIONING_TOKEN ? { Authorization: `Bearer ${PROVISIONING_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[dc-chatlog] report failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[dc-chatlog] report error: ${err?.message ?? err}`);
  }
}

export default definePluginEntry({
  id: 'dealclaw-chatlog',
  name: 'DealClaw Chat Log',
  description: 'Reports every inbound/outbound message to provisioning-service for the admin conversation-history view.',
  register(api) {
    if (!TENANT_ID || !PROVISIONING_URL) {
      console.warn('[dc-chatlog] DEALCLAW_TENANT_ID / PROVISIONING_SERVICE_URL not set — chat logging disabled');
      return;
    }

    api.on('message_received', async (event, ctx) => {
      try {
        const content = typeof event?.content === 'string' ? event.content : '';
        if (!content.trim()) return;
        const messageId = str(event?.messageId, 128);
        if (seen(messageId)) return;
        await report({
          direction: 'in',
          channel: str(ctx?.channelId || event?.metadata?.originatingChannel, 32) || 'feishu',
          senderOpenId: str(ctx?.senderId || event?.senderId || event?.from || event?.metadata?.senderId, 128),
          senderName: str(event?.metadata?.senderName, 256),
          senderUsername: str(event?.metadata?.senderUsername, 256),
          content,
          sessionKey: str(event?.sessionKey || ctx?.sessionKey, 256),
          messageId,
          runId: str(event?.runId || ctx?.runId, 128),
        });
      } catch {
        /* never throw out of a hook */
      }
    });

    api.on('message_sent', async (event, ctx) => {
      try {
        const content = typeof event?.content === 'string' ? event.content : '';
        if (!content.trim()) return;
        const messageId = str(event?.messageId, 128);
        if (seen(messageId)) return;
        await report({
          direction: 'out',
          channel: str(ctx?.channelId || event?.to?.split(':')[0], 32) || 'feishu',
          senderOpenId: null,
          senderName: null,
          senderUsername: null,
          content,
          sessionKey: str(event?.sessionKey || ctx?.sessionKey, 256),
          messageId,
          runId: str(event?.runId || ctx?.runId, 128),
          success: typeof event?.success === 'boolean' ? event.success : null,
        });
      } catch {
        /* never throw out of a hook */
      }
    });
  },
});
