/**
 * DealClaw Chat Log
 * -----------------
 * 把租户 Agent 的每一条入站/出站消息全文上报 provisioning-service
 * （chat_messages 表），供管理后台「对话记录」页渲染会话历史。
 *
 * 事件契约（OpenClaw 2026.7.1 dist 实证，2026-08-31 三轮探针后定稿）：
 *   - message_received: { content, senderId, from, messageId, sessionKey,
 *                         runId, metadata: { senderName, senderUsername,
 *                         originatingChannel } }
 *   - agent_end:        { messages: AgentMessage[], success, error?, durationMs,
 *                         runId? }，ctx 第二参数含 { runId, agentId, sessionKey,
 *                         sessionId, trigger, channelId?, ... }。
 *                         messages 为 run 结束时的会话快照（含最终 assistant
 *                         回复，lastAssistant 即从该数组反向查找取得）。
 *
 * ⚠️ 出站为什么挂 agent_end 而不是投递钩子（2026-08-31 Build #139~#141
 *   运行时探针实证教训）：
 *   message_sending / message_sent / reply_payload_sending 在飞书回复路径
 *   **全部不触发**（探针三次零输出）。飞书回复走 feishu 插件自己的
 *   streaming-card 投递管线，不经核心 outbound 投递链；但每次 run 结束
 *   运行器必发 agent_end，事件里 messages 快照与 Control UI 读的
 *   session JSONL 同源——这是出站内容的可靠采集点。
 *
 * ⚠️ 注册前置条件（2026-08-31 Build #142 实证）：
 *   agent_end 是会话级钩子，非 bundled 插件必须在 openclaw.json 的
 *   plugins.entries.dealclaw-chatlog.hooks.allowConversationAccess=true
 *   显式声明（write-config.mjs 已写入），否则钩子注册被安全门拦截：
 *   `typed hook "agent_end" blocked because non-bundled plugins must set
 *   plugins.entries.dealclaw-chatlog.hooks.allowConversationAccess=true`——
 *   插件其余钩子（message_received）照常工作，只有 agent_end 静默失效。
 *
 * 工程约束（与 dealclaw-contact 一致）：
 *   - fire-and-forget：钩子内**不 await** report()——agent_end 侧在
 *     runAgentEndSideEffects 中 fire-and-forget，但 handler 内 await 网络
 *     依然可能被上层 settlement 等待（cli 路径会 await），统一不 await
 *   - 只取**最后一条** assistant 消息的文本（最终回复）；文本为空
 *     （纯 tool-use 轮 / 失败消息）直接跳过，不回退取更早消息
 *   - 内存去重 messageId（重启后重报无害，端点按 (tenant_id, message_id)
 *     UNIQUE 幂等丢弃）
 *   - 出站 messageId 为合成值（dc-out-<时间戳>-<hash>）
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

/** 从 assistant 消息 content（string 或 block 数组）提取纯文本。 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
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

    api.on('agent_end', async (event, ctx) => {
      try {
        const messages = Array.isArray(event?.messages) ? event.messages : [];
        // 只取最后一条 assistant 消息（run 的最终回复）；文本为空则跳过
        let lastAssistant = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === 'assistant') {
            lastAssistant = messages[i];
            break;
          }
        }
        if (!lastAssistant) return;
        const content = extractText(lastAssistant.content);
        if (!content) return;
        const sessionKey = str(ctx?.sessionKey, 256);
        const runId = str(event?.runId || ctx?.runId, 128);
        // 合成幂等 messageId：同 run 同内容重复触发时去重
        const contentHash = createHash('sha1')
          .update(`${sessionKey ?? ''}|${runId ?? ''}|${content}`)
          .digest('hex')
          .slice(0, 12);
        const messageId = `dc-out-${Date.now().toString(36)}-${contentHash}`;
        if (seen(messageId)) return;
        // 不 await：绝不阻塞 run settlement / 后续投递
        void report({
          direction: 'out',
          channel: str(ctx?.channelId, 32) || 'feishu',
          senderOpenId: null,
          senderName: null,
          senderUsername: null,
          content,
          sessionKey,
          messageId,
          runId,
          success: event?.success === false ? false : true,
        });
      } catch (err) {
        console.warn(`[dc-chatlog] agent_end handler error: ${err?.message ?? err}`);
      }
    });
  },
});
