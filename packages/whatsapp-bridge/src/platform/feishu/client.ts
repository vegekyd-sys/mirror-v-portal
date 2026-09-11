import { config } from "../../config";
import type { EnsureThreadInput } from "../../core/types";
import { requireFeishuApp } from "./context";

type Json = Record<string, unknown>;
type TokenCache = { token: string; expireAt: number };

const tokenCache = new Map<string, TokenCache>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 飞书 2200 是通用「内部错误」，属瞬时故障，官方建议重试。 */
const TRANSIENT_FEISHU_CODES = [2200];

async function feishuFetch(path: string, init: RequestInit, token?: string): Promise<Json> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // 以前只在失败时直接抛错：一次瞬时的 2200 就会把整条同步丢掉（群/话题永远建不出来）。
  // 这里对「瞬态错误」做小退避重试：2200、HTTP 5xx、网络异常。
  const attempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${config.feishu.baseUrl}${path}`, { ...init, headers });
    } catch (networkError) {
      if (attempt >= attempts) throw networkError;
      console.error(`Feishu API ${path} network error (attempt ${attempt}/${attempts}), retrying`, networkError);
      await sleep(600 * attempt);
      continue;
    }

    let json: Json = {};
    try {
      json = (await response.json()) as Json;
    } catch {
      json = {};
    }
    const code = typeof json.code === "number" ? json.code : 0;
    const transient = !response.ok
      ? response.status >= 500
      : TRANSIENT_FEISHU_CODES.includes(code);
    if (transient && attempt < attempts) {
      console.error(
        `Feishu API ${path} transient error (attempt ${attempt}/${attempts}), retrying: ${JSON.stringify(json)}`,
      );
      await sleep(600 * attempt);
      continue;
    }
    if (!response.ok || code !== 0) {
      throw new Error(`Feishu API ${path} failed: ${JSON.stringify(json)}`);
    }
    return json;
  }
}

async function getTenantToken(): Promise<string> {
  const creds = requireFeishuApp();
  const cached = tokenCache.get(creds.appId);
  if (cached && cached.expireAt > Date.now() + 60_000) {
    return cached.token;
  }
  const json = await feishuFetch("/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: JSON.stringify({
      app_id: creds.appId,
      app_secret: creds.appSecret,
    }),
  });
  const token = String(json.tenant_access_token || "");
  const expire = Number(json.expire || 7200);
  tokenCache.set(creds.appId, { token, expireAt: Date.now() + expire * 1000 });
  return token;
}

function textContent(text: string): string {
  return JSON.stringify({ text });
}

function atAllText(text: string): string {
  return `<at user_id="all">所有人</at> ${text}`;
}

function atUsersText(text: string, openIds: string[]): string {
  return `${openIds.map((id) => `<at user_id="${id}"></at>`).join("")} ${text}`;
}

function isMentionDenied(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("230026") ||
    msg.includes("232025") ||
    msg.includes("230024") ||
    msg.includes("@所有人") ||
    msg.includes("mention")
  );
}

async function sendWithNotify<T>(
  text: string,
  notify: boolean,
  send: (body: string) => Promise<T>,
): Promise<T> {
  if (!notify) return send(text);

  try {
    return await send(atAllText(text));
  } catch (error) {
    if (!isMentionDenied(error)) throw error;
    console.error("Feishu @all failed, trying invitee mentions", error);
  }

  const invitees = await listInviteOpenIds();
  if (invitees.length) {
    try {
      return await send(atUsersText(text, invitees));
    } catch (error) {
      if (!isMentionDenied(error)) throw error;
      console.error("Feishu invitee mention failed, sending without mention", error);
    }
  }

  return send(text);
}

export const CS_GROUP_NAME = "WhatsApp 客服";

export async function listBotChats(): Promise<Array<{ chatId: string; name: string }>> {
  const token = await getTenantToken();
  const chats: Array<{ chatId: string; name: string }> = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ page_size: "50" });
    if (pageToken) query.set("page_token", pageToken);
    const json = await feishuFetch(`/open-apis/im/v1/chats?${query.toString()}`, { method: "GET" }, token);
    const data = (json.data || {}) as Json;
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const row = item as Json;
      const chatId = String(row.chat_id || "");
      const name = String(row.name || "");
      if (chatId) chats.push({ chatId, name });
    }
    pageToken = typeof data.page_token === "string" ? data.page_token : "";
  } while (pageToken);
  return chats;
}

export async function createCsGroup(
  userOpenIds: string[] = [],
  botAppIds: string[] = [],
  userFallbackIds: string[] = [],
): Promise<string> {
  const users = [...new Set(userOpenIds.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  const fallback = [...new Set(userFallbackIds.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  const bots = [...new Set(botAppIds.map((id) => id.trim()).filter(Boolean))].slice(0, 5);

  // 先建「最小群」，再分步拉人/加机器人。
  // 一次塞满 owner_id + user_id_list + bot_id_list 是飞书 2200 的典型触发组合，
  // 且成员里任何一个 id 有问题都会让「群」整体建不出来——建群必须与拉人解耦，群先建出来。
  const chatId = await postCreateChat(new URLSearchParams({ user_id_type: "open_id" }), {
    name: CS_GROUP_NAME,
    description: "WhatsApp 买家会话会在此群以话题形式同步",
    chat_mode: "group",
    chat_type: "private",
    group_message_type: "chat",
    add_member_permission: "all_members",
    share_card_permission: "allowed",
  });

  if (users.length) {
    try {
      await addChatMembers(chatId, users);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("invite members to new CS group failed", error);
      // 99992361 = open_id cross app：解析出来的 open_id 不属于当前应用坐标系
      // （租户配错了应用，或成员是外部联系人）。改用租户级 user_id 再试一次，跨应用无歧义。
      if (msg.includes("99992361") && fallback.length) {
        try {
          await addChatMembersWithType(chatId, fallback, "user_id");
        } catch (fallbackError) {
          console.error("invite members by user_id also failed", fallbackError);
        }
      }
    }
  }

  if (bots.length) {
    try {
      await addChatBots(chatId, bots);
    } catch (error) {
      console.error("invite bots to new CS group failed", error);
    }
  }

  return chatId;
}

async function postCreateChat(query: URLSearchParams, body: Record<string, unknown>): Promise<string> {
  const token = await getTenantToken();
  const json = await feishuFetch(
    `/open-apis/im/v1/chats?${query.toString()}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    token,
  );
  const data = (json.data || {}) as Json;
  const chatId = String(data.chat_id || "");
  if (!chatId) throw new Error("Feishu create chat did not return chat_id");
  return chatId;
}

export async function getChatInfo(chatId: string): Promise<{ name?: string; userCount?: string; chatMode?: string }> {
  const token = await getTenantToken();
  const json = await feishuFetch(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, { method: "GET" }, token);
  const data = (json.data || {}) as Json;
  return {
    name: str(data.name),
    userCount: str(data.user_count) || (typeof data.user_count === "number" ? String(data.user_count) : undefined),
    chatMode: str(data.chat_mode),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function listChatMembers(chatId: string): Promise<Array<{ memberId: string; name: string; memberIdType?: string }>> {
  const token = await getTenantToken();
  const json = await feishuFetch(
    `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=open_id&page_size=100`,
    { method: "GET" },
    token,
  );
  const data = (json.data || {}) as Json;
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((item) => {
    const row = item as Json;
    return {
      memberId: String(row.member_id || ""),
      name: String(row.name || ""),
      memberIdType: str(row.member_id_type),
    };
  });
}

/** 把其他飞书应用机器人拉进群。id 必须是 App ID（cli_ 开头），不是 open_id。 */
export async function addChatBots(chatId: string, appIds: string[]): Promise<void> {
  const ids = [...new Set(appIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) return;
  const token = await getTenantToken();
  const selfAppId = requireFeishuApp().appId;
  for (let i = 0; i < ids.length; i += 5) {
    const chunk = ids.slice(i, i + 5).filter((id) => id !== selfAppId);
    if (!chunk.length) continue;
    try {
      const json = await feishuFetch(
        `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=app_id&succeed_type=1`,
        {
          method: "POST",
          body: JSON.stringify({ id_list: chunk }),
        },
        token,
      );
      console.info(`Feishu add bots: ${JSON.stringify(json.data || json)}`);
      const data = (json.data || {}) as Json;
      const invalid = Array.isArray(data.invalid_id_list) ? data.invalid_id_list : [];
      if (invalid.length) {
        console.error(
          `Feishu could not add bot app_id(s): ${invalid.join(", ")}. 确认已开启机器人能力，且该应用对当前企业可见。`,
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("230003")) {
        console.error(
          `无法把机器人 ${chunk.join(",")} 拉进客服群（230003）。` +
            `操作者是 ${selfAppId}，被拉的是另一个应用，飞书算「被其它应用邀请」。` +
            `请打开被邀请应用（${chunk.join(",")}）开发者后台 → 应用能力 → 机器人，开启「允许被邀请进群」，然后【创建版本并发布】；只改开关不发布不会生效。` +
            `同一人开发的两个应用也算其它应用。飞书智能体/Aily 往往不允许被 API 拉群：请在客户端打开「WhatsApp 客服」群，手动添加该机器人。`,
        );
        continue;
      }
      throw error;
    }
  }
}

export async function addChatMembersWithType(
  chatId: string,
  ids: string[],
  memberIdType: "open_id" | "user_id" = "open_id",
): Promise<void> {
  const list = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (!list.length) return;
  const token = await getTenantToken();
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const json = await feishuFetch(
      `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=${memberIdType}&succeed_type=1`,
      {
        method: "POST",
        body: JSON.stringify({ id_list: chunk }),
      },
      token,
    );
    console.info(`Feishu add members (${memberIdType}): ${JSON.stringify(json.data || json)}`);
    const data = (json.data || {}) as Json;
    const invalid = Array.isArray(data.invalid_id_list) ? data.invalid_id_list : [];
    if (invalid.length) {
      console.error(
        `Feishu could not add ${invalid.length} user(s) by ${memberIdType}: they are outside the app availability range. 开发者后台 → 版本管理与发布 → 可用范围，把这些客服加进去（或选全部员工）并发布。`,
      );
    }
  }
}

export async function addChatMembers(chatId: string, openIds: string[]): Promise<void> {
  return addChatMembersWithType(chatId, openIds, "open_id");
}

export async function listContactScopeOpenIds(): Promise<string[]> {
  const token = await getTenantToken();
  const ids: string[] = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ user_id_type: "open_id", page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);
    const json = await feishuFetch(`/open-apis/contact/v3/scopes?${query.toString()}`, { method: "GET" }, token);
    const data = (json.data || {}) as Json;
    const users = Array.isArray(data.user_ids) ? data.user_ids : [];
    for (const id of users) {
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
    pageToken = typeof data.page_token === "string" ? data.page_token : "";
  } while (pageToken);
  return [...new Set(ids)];
}

function normalizeMobile(raw: string): string[] {
  const compact = raw.replace(/[^\d+]/g, "");
  if (!compact) return [];
  if (/^1\d{10}$/.test(compact)) return [compact, `+86${compact}`];
  if (/^\+861\d{10}$/.test(compact)) return [compact.slice(3), compact];
  if (/^861\d{10}$/.test(compact)) return [compact.slice(2), `+${compact}`];
  return [compact];
}

async function batchGetContactIds(
  input: { emails?: string[]; mobiles?: string[] },
  idType: "open_id" | "user_id",
): Promise<string[]> {
  const emails = [...new Set((input.emails || []).map((item) => item.trim().toLowerCase()).filter(Boolean))];
  const mobiles = [...new Set((input.mobiles || []).flatMap(normalizeMobile))];
  if (!emails.length && !mobiles.length) return [];

  const token = await getTenantToken();
  const ids: string[] = [];
  const max = 50;
  for (let i = 0; i < Math.max(emails.length, mobiles.length); i += max) {
    const emailChunk = emails.slice(i, i + max);
    const mobileChunk = mobiles.slice(i, i + max);
    const json = await feishuFetch(
      `/open-apis/contact/v3/users/batch_get_id?user_id_type=${idType}`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(emailChunk.length ? { emails: emailChunk } : {}),
          ...(mobileChunk.length ? { mobiles: mobileChunk } : {}),
          include_resigned: false,
        }),
      },
      token,
    );
    const data = (json.data || {}) as Json;
    const users = Array.isArray(data.user_list) ? data.user_list : [];
    for (const item of users) {
      const userId = str((item as Json).user_id);
      if (userId) ids.push(userId);
    }
    console.info(
      `Feishu contact lookup (${idType}) emails=${emailChunk.length} mobiles=${mobileChunk.length} returned=${users.length} fields=${JSON.stringify(
        users.map((item) => Object.keys(item as Json)),
      )} mobiles=${JSON.stringify(users.map((item) => str((item as Json).mobile) || null))}`,
    );
    if (users.length && users.every((item) => !str((item as Json).user_id))) {
      console.error(
        "Feishu contact lookup returned users without id. Open 获取用户 user ID (contact:user.employee_id:readonly) as app identity and republish.",
      );
    }
  }
  return [...new Set(ids)];
}

export async function listOpenIdsByContacts(input: {
  emails?: string[];
  mobiles?: string[];
}): Promise<string[]> {
  return batchGetContactIds(input, "open_id");
}

/**
 * 同一批手机号/邮箱再解析一次「租户级 user_id」。
 * open_id 是应用坐标系的 ID：配错应用时会被飞书判 99992361 open_id cross app；
 * user_id 在同一租户内跨应用通用，因此作为拉人兜底。
 */
export async function listUserIdsByContacts(input: {
  emails?: string[];
  mobiles?: string[];
}): Promise<string[]> {
  return batchGetContactIds(input, "user_id");
}

export async function listInviteOpenIds(input?: {
  openIds?: string[];
  mobiles?: string[];
  emails?: string[];
}): Promise<string[]> {
  const ids = [...(input?.openIds ?? config.feishu.inviteOpenIds)];
  const emails = input?.emails ?? config.feishu.inviteEmails;
  const mobiles = input?.mobiles ?? config.feishu.inviteMobiles;
  if (emails.length || mobiles.length) {
    try {
      ids.push(...(await listOpenIdsByContacts({ emails, mobiles })));
    } catch (error) {
      console.error("resolve Feishu invite contacts failed", error);
    }
  }
  if (ids.length) return [...new Set(ids)];
  try {
    return await listContactScopeOpenIds();
  } catch (error) {
    console.error("list Feishu contact-scope users failed", error);
    return [];
  }
}

export async function getChatShareLink(chatId: string): Promise<string> {
  const token = await getTenantToken();
  const json = await feishuFetch(
    `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/link`,
    {
      method: "POST",
      body: JSON.stringify({ validity_period: "week" }),
    },
    token,
  );
  const data = (json.data || {}) as Json;
  const link = String(data.share_link || "");
  if (!link) throw new Error("Feishu did not return share_link");
  return link;
}

export async function sendGroupText(
  chatId: string,
  text: string,
  options?: { notify?: boolean },
): Promise<{ messageId: string; threadId?: string }> {
  return sendWithNotify(text, Boolean(options?.notify), async (body) => {
    const token = await getTenantToken();
    const json = await feishuFetch(
      "/open-apis/im/v1/messages?receive_id_type=chat_id",
      {
        method: "POST",
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "text",
          content: textContent(body),
        }),
      },
      token,
    );
    const data = (json.data || {}) as Json;
    return {
      messageId: String(data.message_id || ""),
      threadId: typeof data.thread_id === "string" ? data.thread_id : undefined,
    };
  });
}

/** 给用户发私聊（open_id）。用于发起群进不去时的提醒兜底。 */
export async function sendUserText(openId: string, text: string): Promise<string | undefined> {
  const token = await getTenantToken();
  const json = await feishuFetch(
    "/open-apis/im/v1/messages?receive_id_type=open_id",
    {
      method: "POST",
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "text",
        content: textContent(text),
      }),
    },
    token,
  );
  const data = (json.data || {}) as Json;
  return typeof data.message_id === "string" ? data.message_id : undefined;
}

/**
 * 机器人尽量自动进群。飞书仅允许主动加入「公开群」；私有/外部群会失败，需改公开或人工拉一次。
 * @returns true 表示已在群内或刚加入成功
 */
export async function ensureBotInChat(chatId: string): Promise<boolean> {
  const token = await getTenantToken();
  try {
    await feishuFetch(
      `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/me_join`,
      { method: "PATCH", body: "{}" },
      token,
    );
    console.info(`Feishu bot joined chat ${chatId}`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // 已在群内时部分环境仍可能报错，随后发消息可验证
    if (msg.includes("232007") || msg.includes("already")) {
      return true;
    }
    console.error(
      `Feishu bot me_join ${chatId} failed (私有/外部群通常无法自助进群，仅公开群支持): ${msg}`,
    );
    return false;
  }
}

export async function replyInThread(
  messageId: string,
  text: string,
  options?: { notify?: boolean },
): Promise<{ messageId: string; threadId?: string }> {
  return sendWithNotify(text, Boolean(options?.notify), async (body) => {
    const token = await getTenantToken();
    const json = await feishuFetch(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          content: textContent(body),
          msg_type: "text",
          reply_in_thread: true,
        }),
      },
      token,
    );
    const data = (json.data || {}) as Json;
    return {
      messageId: String(data.message_id || ""),
      threadId: typeof data.thread_id === "string" ? data.thread_id : undefined,
    };
  });
}

/** 上传图片（用于发消息）。需要飞书权限 im:resource。 */
export async function uploadFeishuImage(file: {
  buffer: Buffer;
  filename: string;
  contentType: string;
}): Promise<string> {
  const token = await getTenantToken();
  const form = new FormData();
  form.append("image_type", "message");
  const bytes = new Uint8Array(file.buffer);
  form.append(
    "image",
    new Blob([bytes], { type: file.contentType || "image/jpeg" }),
    file.filename || "image.jpg",
  );

  const response = await fetch(`${config.feishu.baseUrl}/open-apis/im/v1/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = (await response.json()) as Json;
  if (!response.ok || (typeof json.code === "number" && json.code !== 0)) {
    throw new Error(`Feishu upload image failed: ${JSON.stringify(json)}`);
  }
  const data = (json.data || {}) as Json;
  const imageKey = String(data.image_key || "");
  if (!imageKey) throw new Error(`Feishu upload image missing image_key: ${JSON.stringify(json)}`);
  return imageKey;
}

export async function replyInThreadImage(
  messageId: string,
  imageKey: string,
): Promise<{ messageId: string; threadId?: string }> {
  const token = await getTenantToken();
  const json = await feishuFetch(
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
    {
      method: "POST",
      body: JSON.stringify({
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: "image",
        reply_in_thread: true,
      }),
    },
    token,
  );
  const data = (json.data || {}) as Json;
  return {
    messageId: String(data.message_id || ""),
    threadId: typeof data.thread_id === "string" ? data.thread_id : undefined,
  };
}

/** 给消息加表情，不占话题一行。DONE = 完成勾，用来表示买家已读。 */
export async function addMessageReaction(messageId: string, emojiType = "DONE"): Promise<void> {
  const token = await getTenantToken();
  await feishuFetch(
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: "POST",
      body: JSON.stringify({
        reaction_type: { emoji_type: emojiType },
      }),
    },
    token,
  );
}

export function buildRootText(input: EnsureThreadInput): string {
  const senderName = input.customerName?.trim() || "买家";
  const receiverName = "企业号";
  const senderId = input.customerPhone?.trim() || input.customerAlias?.trim() || "unknown";
  return [`${senderName}-${senderId}`, `${receiverName}-${input.businessPhone}`].join("\n");
}

/** 编辑已发送的文本消息（话题根消息标题）。仅支持机器人自己发的 text，且一般需在 14 天内。 */
export async function updateMessageText(messageId: string, text: string): Promise<void> {
  const token = await getTenantToken();
  await feishuFetch(
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        msg_type: "text",
        content: textContent(text),
      }),
    },
    token,
  );
}

/** 下载消息内图片/文件资源（二进制）。 */
export async function downloadMessageResource(
  messageId: string,
  fileKey: string,
  type: "image" | "file" = "image",
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const token = await getTenantToken();
  const path =
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}` +
    `?type=${encodeURIComponent(type)}`;
  const response = await fetch(`${config.feishu.baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Feishu download resource failed ${response.status}: ${errText}`);
  }
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as Json;
    throw new Error(`Feishu download resource failed: ${JSON.stringify(json)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext =
    contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : contentType.includes("gif") ? "gif" : "jpg";
  return {
    buffer,
    contentType,
    filename: `${fileKey}.${ext}`,
  };
}

export async function forwardThreadToChat(threadId: string, chatId: string): Promise<string | undefined> {
  const token = await getTenantToken();
  const json = await feishuFetch(
    `/open-apis/im/v1/threads/${encodeURIComponent(threadId)}/forward?receive_id_type=chat_id`,
    {
      method: "POST",
      body: JSON.stringify({ receive_id: chatId }),
    },
    token,
  );
  const data = (json.data || {}) as Json;
  return typeof data.message_id === "string" ? data.message_id : undefined;
}

export function buildNotifySummary(input: {
  customerPhone: string;
  customerName?: string;
  businessPhone: string;
  text: string;
  isNewThread: boolean;
}): string {
  const name = input.customerName ? `${input.customerName} ` : "";
  const head = input.isNewThread ? "WhatsApp 新会话提醒" : "WhatsApp 买家回复提醒";
  return [
    head,
    `买家：${name}${input.customerPhone}`,
    `企业号：${input.businessPhone}`,
    `内容：${input.text}`,
    `请到「${CS_GROUP_NAME}」群对应话题回复；勿在本群直接回（桥接不会转发到 WhatsApp）。`,
  ].join("\n");
}
