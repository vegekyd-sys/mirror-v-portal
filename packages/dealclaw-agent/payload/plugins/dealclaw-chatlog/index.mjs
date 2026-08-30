/**
 * DealClaw Chat Log
 * -----------------
 * 把租户 Agent 的每一条入站/出站消息全文上报 provisioning-service
 * （chat_messages 表），供管理后台「对话记录」页渲染会话历史。
 *
 * 事件契约（OpenClaw 2026.7.1 dist 实证，2026-08-31 复核）：
 *   - message_received:      { content, senderId, from, messageId, sessionKey,
 *                              runId, metadata: { senderName, senderUsername,
 *                              originatingChannel } }
 *   - reply_payload_sending: { payload: { text, mediaUrl?, ... }, kind, channel,
 *                              sessionKey, runId, usageState }, ctx 第二参数含
 *                              { channelId?, sessionKey?, runId? }
 *
 * ⚠️ 为什么不用 message_sent（2026-08-31 实测教训）：
 *   message_sent 只在 Telegram 专用 delivery 路径和 core outbound 投递路径
 *   （deliverOutboundPayloads）发射；飞书回复走通用通道回复管线
 *   （dispatchInboundMessageWithDispatcher → createReplyDispatcher 的
 *   beforeDeliver 链），该链只安装 reply_payload_sending（带真实 runId，
 *   经 onAgentRunStart 绑定）和 message_sending（ctx 无 runId）。因此出站
 *   记录统一挂 reply_payload_sending——它在所有出站路径（通道回复 + core
 *   outbound）都会触发，代价是记录发生在发送前（无 success/messageId，
 *   合成 messageId）。
 *
 * 工程约束（与 dealclaw-contact 一致）：
 *   - fire-and-forget：钩子内**不 await** report()——reply_payload_sending
 *     是顺序修改型钩子，await 会让消息投递等上报完成，provisioning 卡顿
 *     会直接拖慢用户收到回复（吐字慢回归）
 *   - reply_payload_sending 是修改型钩子，handler 必须返回 undefined——
 *     返回 {cancel} 或 {payload} 会吞掉/改写用户回复
 *   - 内存去重 messageId（重启后重报无害，端点按 (tenant_id, message_id)
 *     UNIQUE 幂等丢弃）
 *   - 出站走发送前钩子，messageId 为合成值（dc-out-<时间戳>-<hash>）
 */
import { createHash } from 'node:crypto';
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
        // 不 await：绝不阻塞消息主链路
        void report({
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

    api.on('message_sending', async (event) => {
      // 只读探针：验证 message_sending 是否在飞书回复路径触发（排查期临时）
      console.log(`[dc-chatlog] probe message_sending fired: keys=${Object.keys(event ?? {}).join(',')} contentLen=${typeof event?.content === 'string' ? event.content.length : 'n/a'}`);
    });

    api.on('message_sent', async (event) => {
      // 只读探针：验证 message_sent 是否在飞书回复路径触发（排查期临时）
      console.log(`[dc-chatlog] probe message_sent fired: keys=${Object.keys(event ?? {}).join(',')} content=${typeof event?.content === 'string' ? event.content.slice(0, 30) : 'n/a'}`);
    });

    api.on('reply_payload_sending', async (event, ctx) => {
      try {
        // 修改型钩子：返回 undefined，绝不 cancel / 改写 payload
        const payload = event?.payload;
        console.log(`[dc-chatlog] reply_payload_sending fired: kind=${event?.kind} channel=${event?.channel} runId=${event?.runId ?? ctx?.runId ?? '-'} sessionKey=${event?.sessionKey ?? ctx?.sessionKey ?? '-'} textLen=${typeof payload?.text === 'string' ? payload.text.length : 'n/a'} payloadKeys=${payload ? Object.keys(payload).join(',') : '-'}`);
        const content = typeof payload?.text === 'string' ? payload.text : '';
        if (!content.trim()) return;
        const sessionKey = str(event?.sessionKey || ctx?.sessionKey, 256);
        const runId = str(event?.runId || ctx?.runId, 128);
        // 合成幂等 messageId：同一 payload 重复触发（钩子重试）时去重，
        // 正常情况每条出站消息只触发一次
        const contentHash = createHash('sha1')
          .update(`${sessionKey ?? ''}|${runId ?? ''}|${content}`)
          .digest('hex')
          .slice(0, 12);
        const messageId = str(event?.messageId, 128) || `dc-out-${Date.now().toString(36)}-${contentHash}`;
        if (seen(messageId)) return;
        // 不 await：reply_payload_sending 顺序执行，await 会拖慢回复投递
        void report({
          direction: 'out',
          channel: str(event?.channel || ctx?.channelId, 32) || 'feishu',
          senderOpenId: null,
          senderName: null,
          senderUsername: null,
          content,
          sessionKey,
          messageId,
          runId,
          // 发送前钩子拿不到投递结果，success 留空
          success: null,
        });
      } catch {
        /* never throw out of a hook */
      }
    });
  },
});
