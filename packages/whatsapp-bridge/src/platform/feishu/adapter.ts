import { prisma } from "../../prisma";
import { config } from "../../config";
import type { EnsureThreadInput, ThreadRef } from "../../core/types";
import { currentFeishuApp } from "./context";
import { saveFeishuCsChatId } from "./apps";
import {
  CS_GROUP_NAME,
  buildRootText,
  buildNotifySummary,
  createCsGroup,
  listBotChats,
  replyInThread,
  replyInThreadImage,
  sendGroupText,
  uploadFeishuImage,
  addMessageReaction,
  sendUserText,
  getChatShareLink,
  addChatMembers,
  addChatBots,
  listInviteOpenIds,
  forwardThreadToChat,
  ensureBotInChat,
  updateMessageText,
} from "./client";

const CS_CHAT_SETTING = "feishu.cs_chat_id";
const creating = new Map<string, Promise<ThreadRef>>();
const ensuringChat = new Map<string, Promise<string>>();

function csSettingKey(appId?: string) {
  return appId ? `${CS_CHAT_SETTING}.${appId}` : CS_CHAT_SETTING;
}

async function saveCsChatId(chatId: string) {
  const app = currentFeishuApp();
  if (app) {
    try {
      await saveFeishuCsChatId(app.appId, chatId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "P2025") throw error;
    }
  }
  await prisma.appSetting.upsert({
    where: { key: csSettingKey(app?.appId) },
    update: { value: chatId },
    create: { key: csSettingKey(app?.appId), value: chatId },
  });
}

export async function ensureCsChatId(extraOpenIds: string[] = [], extraBotAppIds: string[] = []): Promise<string> {
  const appId = currentFeishuApp()?.appId || "_env";
  const pending = ensuringChat.get(appId);
  const extras = [...new Set(extraOpenIds.map((id) => id.trim()).filter(Boolean))];
  const extraBots = [...new Set(extraBotAppIds.map((id) => id.trim()).filter((id) => id.startsWith("cli_")))];

  const task =
    pending ||
    (async () => {
      const app = currentFeishuApp();
      let chatId = app ? app.csChatId : config.feishu.chatId;
      if (!chatId) {
        const saved = await prisma.appSetting.findUnique({ where: { key: csSettingKey(app?.appId) } });
        chatId = saved?.value;
      }
      if (!chatId && app?.csChatId) chatId = app.csChatId;
      if (!chatId) {
        const chats = await listBotChats();
        chatId = chats.find((chat) => chat.name === CS_GROUP_NAME)?.chatId;
      }

      const invitees = [...(await listInviteOpenIds({
        openIds: app?.inviteOpenIds,
        mobiles: app?.inviteMobiles,
        emails: app?.inviteEmails,
      })), ...extras];
      const inviteBots = [...new Set([...(app?.inviteAppIds || config.feishu.inviteAppIds), ...extraBots])];
      console.info(`Feishu CS invitees resolved: ${invitees.length} bots=${inviteBots.length} app=${appId}`);
      if (!chatId) {
        chatId = await createCsGroup(invitees, inviteBots);
        if (!invitees.length) {
          console.info(
            "Feishu CS group created without human members. 个人账号不会自动看到该群：请在请求里带 sourceOpenId，或在桥接配置 FEISHU_INVITE_MOBILES / FEISHU_INVITE_OPEN_IDS。",
          );
        }
      } else if (invitees.length) {
        try {
          await addChatMembers(chatId, invitees);
        } catch (error) {
          console.error("invite CS members failed", error);
        }
      } else {
        try {
          const link = await getChatShareLink(chatId);
          console.info(`Feishu CS group has no invitees. Join: ${link}`);
        } catch (error) {
          console.error("Feishu CS group share link failed", error);
        }
      }
      if (inviteBots.length) {
        try {
          await addChatBots(chatId, inviteBots);
        } catch (error) {
          console.error("invite CS bots failed", error);
        }
      } else {
        console.info(
          "Feishu CS group has no invite bots. 智能体初始化 POST /api/feishu/apps 时带上 FEISHU_INVITE_APP_IDS，才会把其它机器人拉进客服群。",
        );
      }

      await saveCsChatId(chatId);
      return chatId;
    })();

  if (!pending) ensuringChat.set(appId, task);

  try {
    const chatId = await task;
    if (pending && extras.length) {
      try {
        await addChatMembers(chatId, extras);
      } catch (error) {
        console.error("invite extra CS members failed", error);
      }
    }
    if (pending && extraBots.length) {
      try {
        await addChatBots(chatId, extraBots);
      } catch (error) {
        console.error("invite extra CS bots failed", error);
      }
    }
    return chatId;
  } finally {
    if (!pending) ensuringChat.delete(appId);
  }
}

/**
 * 诊断：逐步执行飞书关键调用并返回每步原始结果（不抛错）。
 * 用途：拿不到 pod 日志时定位「key 是否可用 / 建群卡在哪一步」。
 */
export async function diagnoseFeishu(): Promise<Record<string, unknown>> {
  const creds = currentFeishuApp();
  if (!creds) return { ok: false, error: "飞书应用未注册（currentFeishuApp 为空）" };
  const out: Record<string, unknown> = {
    appId: creds.appId,
    baseUrl: config.feishu.baseUrl,
    inviteAppIds: creds.inviteAppIds,
    inviteOpenIds: creds.inviteOpenIds,
    inviteMobiles: creds.inviteMobiles,
  };

  out.tenantToken = await (async () => {
    try {
      const response = await fetch(
        `${config.feishu.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
        },
      );
      const json = (await response.json()) as Record<string, unknown>;
      return {
        ok: response.ok && json.code === 0,
        http: response.status,
        code: json.code,
        msg: json.msg,
        gotToken: Boolean(json.tenant_access_token),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();

  out.listBotChats = await (async () => {
    try {
      const chats = await listBotChats();
      return {
        ok: true,
        count: chats.length,
        hasCsGroup: chats.some((chat) => chat.name === CS_GROUP_NAME),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();

  out.ensureCsChatId = await (async () => {
    try {
      const chatId = await ensureCsChatId([], creds.inviteAppIds);
      return { ok: true, chatId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })();

  return out;
}

async function resolveNotifyChatIds(csChatId: string, sourceChatId?: string | null): Promise<string[]> {
  const ids = [...config.feishu.notifyChatIds];
  if (sourceChatId?.trim()) ids.push(sourceChatId.trim());
  const names = config.feishu.notifyChatNames;
  if (names.length) {
    const chats = await listBotChats();
    for (const name of names) {
      const found = chats.find((chat) => chat.name === name)?.chatId;
      if (found) ids.push(found);
      else console.error(`Feishu notify chat not found by name: ${name}`);
    }
  }
  return [...new Set(ids)].filter((id) => id && id !== csChatId);
}

async function claimThreadForward(threadId: string): Promise<boolean> {
  const key = `feishu.notify.forwarded.${threadId}`;
  try {
    await prisma.appSetting.create({ data: { key, value: "1" } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }
}

/** 提醒发起群；进不去则私聊发起人。每个客服话题最多转发一次。 */
export async function notifyWatchChats(input: {
  customerPhone: string;
  customerName?: string;
  businessPhone: string;
  text: string;
  thread: ThreadRef;
  isNewThread: boolean;
  sourceChatId?: string | null;
  sourceOpenId?: string | null;
}): Promise<void> {
  const targets = await resolveNotifyChatIds(input.thread.chatId, input.sourceChatId);
  const summary = buildNotifySummary({
    customerPhone: input.customerPhone,
    customerName: input.customerName,
    businessPhone: input.businessPhone,
    text: input.text,
    isNewThread: input.isNewThread,
  });

  const shouldForward =
    Boolean(input.thread.threadId) &&
    targets.length > 0 &&
    (await claimThreadForward(input.thread.threadId));

  let groupOk = false;
  for (const chatId of targets) {
    try {
      await ensureBotInChat(chatId);
      if (shouldForward) {
        try {
          await forwardThreadToChat(input.thread.threadId, chatId);
        } catch (error) {
          console.error(`forward thread to notify chat ${chatId} failed`, formatNotifyError(chatId, error));
        }
      }
      await sendGroupText(chatId, summary);
      groupOk = true;
    } catch (error) {
      console.error(`notify watch chat ${chatId} failed`, formatNotifyError(chatId, error));
    }
  }

  if (!groupOk && input.sourceOpenId?.trim()) {
    try {
      await sendUserText(
        input.sourceOpenId.trim(),
        `${summary}\n（桥接机器人未能进发起群，已私聊提醒你）`,
      );
      console.info(`notified source user ${input.sourceOpenId} via DM`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("99992361") || msg.includes("open_id cross app")) {
        console.info(
          "skip sourceOpenId DM: 该 open_id 属于另一个飞书应用，桥接无法私聊。买家消息已写入「WhatsApp 客服」话题，可忽略。",
        );
        return;
      }
      console.error("notify source user DM failed", msg);
    }
  }
}

function formatNotifyError(chatId: string, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("230002") || msg.includes("out of the chat") || msg.includes("outside the group")) {
    return (
      `chat ${chatId}: 桥接机器人不在该群（230002）。` +
      `已尝试 me_join；私有/外部群飞书不允许机器人自助进群。` +
      `可把群改为公开后重试，或确保请求带 sourceOpenId 走私聊兜底。`
    );
  }
  return msg;
}

async function claimRootTitleSync(threadId: string): Promise<boolean> {
  const key = `feishu.root.title.v3.${threadId}`;
  try {
    await prisma.appSetting.create({ data: { key, value: "1" } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }
}

export async function ensureFeishuThread(
  input: EnsureThreadInput,
): Promise<ThreadRef & { firstMessagePosted: boolean }> {
  const extras = input.memberOpenIds || [];
  const existing = await prisma.platformThread.findUnique({
    where: {
      conversationId_platform: {
        conversationId: input.conversationId,
        platform: "feishu",
      },
    },
  });
  const chatId = await ensureCsChatId(extras, input.botAppIds || []);
  if (existing && existing.chatId === chatId) {
    if (await claimRootTitleSync(existing.threadId)) {
      const rootText = buildRootText(input);
      try {
        await updateMessageText(existing.rootMessageId, rootText);
        console.info(`updated Feishu root title for thread ${existing.threadId}`);
      } catch (error) {
        console.error("update Feishu thread root title failed", error);
        try {
          await replyInThread(
            existing.rootMessageId,
            `系统：话题标题已更新为\n${rootText}`,
          );
        } catch (fallbackError) {
          console.error("post title fallback to Feishu thread failed", fallbackError);
        }
      }
    }

    return {
      chatId: existing.chatId,
      threadId: existing.threadId,
      rootMessageId: existing.rootMessageId,
      firstMessagePosted: false,
    };
  }

  const pending = creating.get(input.conversationId);
  if (pending) {
    const thread = await pending;
    return { ...thread, firstMessagePosted: false };
  }

  const task = createThread(input, chatId);
  creating.set(input.conversationId, task);
  try {
    const thread = await task;
    return { ...thread, firstMessagePosted: true };
  } finally {
    creating.delete(input.conversationId);
  }
}

async function createThread(input: EnsureThreadInput, chatId: string): Promise<ThreadRef> {
  const root = await sendGroupText(chatId, buildRootText(input), { notify: true });
  const reply = await replyInThread(root.messageId, input.firstText);
  const threadId = reply.threadId || root.threadId;
  if (!threadId) {
    throw new Error("Feishu reply did not return thread_id");
  }

  const data = {
    conversationId: input.conversationId,
    platform: "feishu",
    chatId,
    threadId,
    rootMessageId: root.messageId,
  };

  try {
    const saved = await prisma.platformThread.upsert({
      where: {
        conversationId_platform: {
          conversationId: input.conversationId,
          platform: "feishu",
        },
      },
      update: { chatId, threadId, rootMessageId: root.messageId },
      create: data,
    });
    return {
      chatId: saved.chatId,
      threadId: saved.threadId,
      rootMessageId: saved.rootMessageId,
      firstReplyMessageId: reply.messageId || undefined,
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002") {
      const again = await prisma.platformThread.findUnique({
        where: {
          conversationId_platform: {
            conversationId: input.conversationId,
            platform: "feishu",
          },
        },
      });
      if (again) {
        return {
          chatId: again.chatId,
          threadId: again.threadId,
          rootMessageId: again.rootMessageId,
        };
      }
    }
    throw error;
  }
}

export async function postToFeishuThread(
  thread: ThreadRef,
  text: string,
  options?: { notify?: boolean },
): Promise<string | undefined> {
  const sent = await replyInThread(thread.rootMessageId, text, options);
  return sent.messageId;
}

export async function postImageToFeishuThread(
  thread: ThreadRef,
  file: { buffer: Buffer; filename: string; contentType: string },
): Promise<string | undefined> {
  const imageKey = await uploadFeishuImage(file);
  const sent = await replyInThreadImage(thread.rootMessageId, imageKey);
  return sent.messageId;
}

export async function markFeishuMessageRead(feishuMessageId: string): Promise<void> {
  await addMessageReaction(feishuMessageId, "DONE");
}

export async function findThreadByFeishuId(threadId: string) {
  return prisma.platformThread.findUnique({
    where: {
      platform_threadId: {
        platform: "feishu",
        threadId,
      },
    },
    include: {
      conversation: { include: { customer: true } },
    },
  });
}
