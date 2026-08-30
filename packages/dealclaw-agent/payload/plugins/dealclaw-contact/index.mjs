/**
 * DealClaw Contact Writeback
 * ---------------------------
 * P2 迁移：飞书直连插件接管消息面后，im_open_id 的捕获从 nexus-gateway
 * ws-client 迁到这里。首个入站消息的 sender open_id 回写 provisioning
 * （幂等 UPDATE），central-gateway 的 notify relay 据此投递生命周期通知。
 *
 * 语义（v2，2026-08-30）：租户通知联系人 = 绑定后第一个【私聊】机器人的
 * 人（几乎总是绑定的管理员本人）。群消息一律不上报——企业租户的员工在
 * 飞书群里使用 Agent 时绝不能抢占通知联系人。中控端点是 first-capture-
 * wins（im_open_id IS NULL 才写入），配合换绑/解绑时清空列，构成完整
 * 的锁定语义。
 *
 * 工程约束与 v1 完全一致：
 *   - fire-and-forget，绝不阻塞/失败消息主链路
 *   - 内存去重：同一 open_id 只报一次（重启后重报无害，端点幂等）
 *   - 群/私聊判定 fail-open：仅在能确凿识别为群聊时跳过——判定字段
 *     缺失时宁可上报（后端 first-capture-wins 兜底），不能漏报联系人
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const TENANT_ID = process.env.DEALCLAW_TENANT_ID || '';
const PROVISIONING_URL = (process.env.PROVISIONING_SERVICE_URL || '').replace(/\/$/, '');
const PROVISIONING_TOKEN = process.env.PROVISIONING_API_TOKEN || '';

let lastReportedOpenId = null;

/** 从 message_received 钩子的真实形态提取 sender open_id。
 *
 * 钩子签名为 api.on('message_received', (event, ctx))，字段来自
 * OpenClaw dist/message-hook-mappers（toPluginMessageReceivedEvent /
 * toPluginMessageContext），2026.7.1 实测：
 *   - ctx.senderId / ctx.channelId（ctx 是第二个参数，不是 event.ctx）
 *   - event.senderId / event.from（字符串）/ event.metadata.senderId
 */
function extractOpenId(event, ctx) {
  const candidates = [
    typeof ctx?.senderId === 'string' ? ctx.senderId : null,
    typeof event?.senderId === 'string' ? event.senderId : null,
    typeof event?.from === 'string' ? event.from : null,
    typeof event?.metadata?.senderId === 'string' ? event.metadata.senderId : null,
  ];
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return null;
}

/** 只关心飞书渠道的入站消息（web/bridge 路径不需要回写）。 */
function isFeishuInbound(event, ctx) {
  const channel = String(ctx?.channelId || event?.metadata?.originatingChannel || '');
  if (channel) return channel.toLowerCase().includes('feishu');
  // 渠道信息缺失时不放走——本插件只挂在这类事件上，宁可多报一次幂等 UPDATE。
  return true;
}

/** 是否为群聊消息（员工在群里发言 → 不参与联系人捕获）。
 *
 * fail-open 策略：只有当某个候选字段确凿等于 'group'（或 isGroup 显式为
 * true）时才判定为群——所有字段都缺失/未知时按私聊处理继续上报，避免
 * OpenClaw 版本间事件形状差异导致联系人永远捕获不到。误报由后端
 * first-capture-wins 兜底（只可能锁定第一个 DM 的人，而 DM 本身就意味着
 * 这条消息不在群里）。
 *
 * 候选来源：飞书原始事件 message.chat_type（'p2p' | 'group'）、OpenClaw
 * 归一化的 ctx.chatType / event.chat.type / event.isGroup。
 */
function isGroupMessage(event, ctx) {
  const candidates = [
    ctx?.chatType,
    event?.chatType,
    event?.chat?.type,
    event?.metadata?.chatType,
    event?.metadata?.chat_type,
    event?.metadata?.chat?.type,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.toLowerCase() === 'group') return true;
  }
  if (event?.isGroup === true || ctx?.isGroup === true) return true;
  return false;
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
    // First-capture-wins: captured=false 意味着已有别人锁定（多为绑定管理员
    // 本人）——同样记入内存去重，不再重试本 open_id。
    const body = await res.json().catch(() => ({}));
    if (body?.captured === false) {
      console.log(`[dc-contact] contact already captured elsewhere — ${openId} not stored`);
    } else {
      console.log(`[dc-contact] im_open_id reported: ${openId}`);
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
  description: 'Reports the first DM sender im_open_id (binding admin) to provisioning for lifecycle notification delivery.',
  register(api) {
    if (!TENANT_ID || !PROVISIONING_URL) {
      console.warn('[dc-contact] DEALCLAW_TENANT_ID / PROVISIONING_SERVICE_URL not set — contact writeback disabled');
      return;
    }

    api.on('message_received', async (event, ctx) => {
      try {
        if (!isFeishuInbound(event, ctx)) return;
        // 群消息不参与捕获——通知联系人必须是私聊过机器人的人。
        if (isGroupMessage(event, ctx)) return;
        const openId = extractOpenId(event, ctx);
        if (!openId || openId === lastReportedOpenId) return;
        const ok = await reportContact(openId);
        if (ok) {
          lastReportedOpenId = openId;
        }
      } catch {
        /* never throw out of a hook */
      }
    });
  },
});
