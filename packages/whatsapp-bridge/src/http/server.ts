import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { config } from "../config";
import { prisma } from "../prisma";
import { claimWebhookEvent, markWebhookProcessed } from "../core/conversation";
import { handleAgentSend, handleFeishuInbound, handleWhatsAppInbound, handleWhatsAppStatus } from "../core/bridge";
import { applyWabaAccountUpdate, createOnboardingLink, listWabaOnboardings, resolveWabaId, wabaHealth, WabaIdRequiredError } from "../core/onboarding";
import { listWhatsAppPhones, listWhatsAppTemplates, parseYCloudEvent, YCloudApiError } from "../channel/whatsapp/ycloud";
import { verifyYCloudSignature } from "../channel/whatsapp/signature";
import { toE164 } from "../lib/phone";
import {
  decryptFeishuPayload,
  parseFeishuEvent,
  verifyFeishuSignature,
} from "../platform/feishu/crypto";
import {
  envFeishuCreds,
  feishuWebhookUrl,
  getFeishuApp,
  publicFeishuApp,
  upsertFeishuApp,
  type FeishuAppCreds,
} from "../platform/feishu/apps";
import { runWithFeishuApp } from "../platform/feishu/context";
import { addChatBots } from "../platform/feishu/client";

declare module "fastify" {
  interface FastifyRequest {
    rawBody: string;
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function publicBaseUrl(request: FastifyRequest): string {
  if (config.bridgeBaseUrl) return config.bridgeBaseUrl.replace(/\/$/, "");
  const proto = header(request, "x-forwarded-proto") || "http";
  const host = header(request, "host") || `127.0.0.1:${config.port}`;
  // 必须带上路由前缀：这个 URL 会作为 webhookUrl 返回给智能体去配到飞书后台，
  // 集群里少一层 /whatsapp 配出来就是 404。
  // 走 WHATSAPP_BRIDGE_BASE_URL 那条分支时，要求该配置里自带前缀。
  return `${proto}://${host}${config.routePrefix}`;
}

async function handleFeishuWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  creds: FeishuAppCreds | undefined,
) {
  if (!creds) {
    return reply.code(500).send({
      error: "feishu app is not registered",
      hint: "智能体初始化时 POST /api/feishu/apps，再把飞书事件地址配成返回的 webhookUrl",
    });
  }

  const raw = request.rawBody || "";
  let payload = request.body as unknown;

  const encrypted =
    payload &&
    typeof payload === "object" &&
    "encrypt" in payload &&
    typeof (payload as { encrypt?: unknown }).encrypt === "string"
      ? (payload as { encrypt: string }).encrypt
      : undefined;

  if (encrypted) {
    if (!creds.encryptKey) {
      return reply.code(500).send({ error: "该飞书应用未登记 Encrypt Key（FEISHU_ENCRYPT_KEY）" });
    }
    try {
      payload = JSON.parse(decryptFeishuPayload(encrypted, creds.encryptKey));
    } catch (error) {
      request.log.warn({ err: error, appId: creds.appId }, "feishu payload decrypt failed");
      return reply.code(401).send({
        error: "invalid encrypt key",
        hint: "登记的 FEISHU_ENCRYPT_KEY 与该飞书应用「加密策略」里的 Encrypt Key 不一致",
      });
    }
  }

  const parsed = parseFeishuEvent(payload);
  if (parsed.type === "url_verification") {
    if (!parsed.challenge) {
      return reply.code(400).send({ error: "url_verification missing challenge" });
    }
    if (creds.verificationToken && parsed.token && parsed.token !== creds.verificationToken) {
      request.log.warn(
        { appId: creds.appId },
        "feishu url_verification token mismatch; still returning challenge",
      );
    }
    // 飞书保存请求地址只认 HTTP 200 + { challenge }。Token 不对也不能 401，否则控制台只显示「Challenge code没有返回」。
    return reply.code(200).type("application/json; charset=utf-8").send({ challenge: parsed.challenge });
  }

  if (!config.feishu.skipSignature) {
    if (!creds.encryptKey) {
      return reply.code(500).send({ error: "该飞书应用未登记 Encrypt Key（FEISHU_ENCRYPT_KEY）" });
    }
    const ok = verifyFeishuSignature(
      header(request, "x-lark-request-timestamp") || header(request, "x-feishu-request-timestamp"),
      header(request, "x-lark-request-nonce") || header(request, "x-feishu-request-nonce"),
      raw,
      header(request, "x-lark-signature") || header(request, "x-feishu-signature"),
      creds.encryptKey,
    );
    if (!ok) return reply.code(401).send({ error: "invalid signature" });
  }

  if (!parsed.inbound) {
    return reply.send({ ok: true, ignored: parsed.type || "unknown" });
  }

  const claimed = await claimWebhookEvent(
    "feishu",
    parsed.inbound.eventId,
    parsed.type || "im.message.receive_v1",
    payload,
  );
  reply.code(200).send({ ok: true, duplicate: !claimed });
  if (!claimed) return;

  const inbound = parsed.inbound;
  setImmediate(() => {
    void (async () => {
      try {
        await runWithFeishuApp(creds, () => handleFeishuInbound(inbound));
        await markWebhookProcessed("feishu", inbound.eventId);
      } catch (error) {
        request.log.error(error);
        await markWebhookProcessed("feishu", inbound.eventId, (error as Error).message);
      }
    })();
  });
}

function sendYCloudError(reply: FastifyReply, error: YCloudApiError) {
  const status =
    error.status === 429 ? 429 : error.status >= 400 && error.status < 500 ? error.status : 502;
  if (error.retryAfter) reply.header("Retry-After", error.retryAfter);
  return reply.code(status).send({
    error: error.message,
    code: status === 429 ? "YCLOUD_RATE_LIMITED" : "YCLOUD_REQUEST_FAILED",
    retryAfter: error.retryAfter,
    ycloud: error.body,
  });
}

/**
 * 探活。无论 ROUTE_PREFIX 设成什么，它都会**额外**挂在根路径上 ——
 * k8s 探针直连 Pod，拿不到网关的前缀。
 */
async function healthHandler() {
  const waba = await wabaHealth();
  return {
    ok: true,
    partnerCustomerId: config.cdpSupplierId,
    wabaId: waba.wabaId,
    wabaBound: waba.wabaBound,
    wabaCount: waba.wabaCount,
    from: waba.from,
  };
}

export async function buildServer() {
  const app = Fastify({ logger: true });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    request.rawBody = raw;
    try {
      done(null, raw ? JSON.parse(raw) : {});
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  // 业务路由统一挂在 ROUTE_PREFIX 之下。集群里和 email-webhook 共用一个 ALB host，
  // 靠路径前缀分流（/whatsapp/...），所以网关不需要 StripPrefix。
  await app.register(
    async (scope) => {
      scope.get("/health", healthHandler);
    scope.post("/api/feishu/apps", async (request, reply) => {
      const body = (request.body || {}) as {
        appId?: string;
        appSecret?: string;
        verificationToken?: string;
        encryptKey?: string;
        FEISHU_APP_ID?: string;
        FEISHU_APP_SECRET?: string;
        FEISHU_VERIFICATION_TOKEN?: string;
        FEISHU_ENCRYPT_KEY?: string;
        inviteAppIds?: string | string[];
        FEISHU_INVITE_APP_IDS?: string;
      };
      try {
        const creds = await upsertFeishuApp({
          appId: body.appId || body.FEISHU_APP_ID || "",
          appSecret: body.appSecret || body.FEISHU_APP_SECRET || "",
          verificationToken: body.verificationToken || body.FEISHU_VERIFICATION_TOKEN,
          encryptKey: body.encryptKey || body.FEISHU_ENCRYPT_KEY,
          inviteAppIds: body.inviteAppIds || body.FEISHU_INVITE_APP_IDS,
        });
        const webhookUrl = feishuWebhookUrl(publicBaseUrl(request), creds.appId);
        if (creds.csChatId && creds.inviteAppIds.length) {
          try {
            await runWithFeishuApp(creds, () => addChatBots(creds.csChatId!, creds.inviteAppIds));
          } catch (error) {
            request.log.warn({ err: error, appId: creds.appId }, "invite bots into existing CS group failed");
          }
        }
        const published = publicFeishuApp(creds, webhookUrl);
        return {
          ...published,
          warning: published.hasEncryptKey
            ? undefined
            : "未登记 Encrypt Key。该飞书应用若开启了加密策略，保存事件 URL 会报 Challenge code没有返回。请从该应用「加密策略」复制 FEISHU_ENCRYPT_KEY 后重新 POST。",
        };
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    });

    scope.get("/api/feishu/apps/:appId", async (request, reply) => {
      const appId = (request.params as { appId?: string }).appId || "";
      const creds = await getFeishuApp(appId);
      if (!creds) {
        return reply.code(404).send({
          error: "unknown feishu app",
          hint: "先 POST /api/feishu/apps 注册该 FEISHU_APP_ID",
        });
      }
      return publicFeishuApp(creds, feishuWebhookUrl(publicBaseUrl(request), creds.appId));
    });

    scope.get("/api/whatsapp/phones", async (request, reply) => {
      try {
        const wabaId = await resolveWabaId((request.query as { wabaId?: string }).wabaId);
        const listed = await listWhatsAppPhones(wabaId);
        const numbers = listed.phones
          .map((item) => (item.phoneNumber ? toE164(item.phoneNumber) : ""))
          .filter(Boolean);
        const defaultFrom = numbers[0];
        const phones = listed.phones.map((item) => {
          const phoneNumber = item.phoneNumber ? toE164(item.phoneNumber) : item.phoneNumber;
          return {
            ...item,
            phoneNumber,
            current: Boolean(phoneNumber && phoneNumber === defaultFrom),
          };
        });
        return { wabaId, defaultFrom, phones };
      } catch (error) {
        if (error instanceof WabaIdRequiredError) {
          return reply.code(400).send({ error: error.message, code: error.code, wabas: error.wabas });
        }
        return reply.code(500).send({ error: (error as Error).message });
      }
    });

    scope.get("/api/whatsapp/templates", async (request, reply) => {
      try {
        const { name, wabaId } = request.query as { name?: string; wabaId?: string };
        const id = await resolveWabaId(wabaId);
        return await listWhatsAppTemplates(name, id);
      } catch (error) {
        if (error instanceof WabaIdRequiredError) {
          return reply.code(400).send({ error: error.message, code: error.code, wabas: error.wabas });
        }
        return reply.code(500).send({ error: (error as Error).message });
      }
    });

    scope.post("/api/whatsapp/onboarding-links", async (request, reply) => {
      const body = (request.body || {}) as {
        partnerCustomerId?: string;
        onboardingType?: string;
        locale?: string;
        sourceChatId?: string;
        sourceOpenId?: string;
      };
      try {
        return await createOnboardingLink(body);
      } catch (error) {
        if (error instanceof YCloudApiError) return sendYCloudError(reply, error);
        const status = (error as { statusCode?: number }).statusCode || 400;
        return reply.code(status).send({ error: (error as Error).message });
      }
    });

    scope.get("/api/whatsapp/wabas", async (request) => {
      const query = request.query as { partnerCustomerId?: string; wabaId?: string; status?: string };
      return listWabaOnboardings(query);
    });

    scope.get("/api/whatsapp/conversations", async (request) => {
      const query = request.query as { phone?: string; from?: string };
      const phone = query.phone;
      const from = query.from ? toE164(query.from) : undefined;
      const rows = await prisma.conversation.findMany({
        where: {
          ...(phone ? { customer: { phoneNumber: { contains: phone.replace(/^\+/, "") } } } : {}),
          ...(from ? { businessPhone: from } : {}),
        },
        include: { customer: true, platformThreads: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });
      const now = Date.now();
      return {
        conversations: rows.map((row) => ({
          id: row.id,
          customerPhone: row.customer.phoneNumber,
          customerName: row.customer.name,
          businessPhone: row.businessPhone,
          windowOpen: Boolean(row.serviceWindowExpiresAt && row.serviceWindowExpiresAt.getTime() > now),
          windowExpiresAt: row.serviceWindowExpiresAt,
          lastInboundAt: row.lastInboundAt,
          lastOutboundAt: row.lastOutboundAt,
          threads: row.platformThreads.map((thread) => ({
            platform: thread.platform,
            chatId: thread.chatId,
            threadId: thread.threadId,
          })),
        })),
      };
    });

    scope.post("/api/whatsapp/messages", async (request, reply) => {
      const body = (request.body || {}) as {
        to?: string;
        text?: string;
        from?: string;
        wabaId?: string;
        feishuAppId?: string;
        sourceChatId?: string;
        notifyChatId?: string;
        sourceOpenId?: string;
        inviteAppIds?: string | string[];
        FEISHU_INVITE_APP_IDS?: string;
        template?: { name: string; language: string; components?: unknown[] };
      };
      try {
        const result = await handleAgentSend({
          to: body.to || "",
          text: body.text,
          from: body.from,
          wabaId: body.wabaId,
          feishuAppId: body.feishuAppId,
          sourceChatId: body.sourceChatId || body.notifyChatId,
          sourceOpenId: body.sourceOpenId,
          inviteAppIds: body.inviteAppIds || body.FEISHU_INVITE_APP_IDS,
          template: body.template,
        });
        if (!result.ok) return reply.code(409).send(result);
        return result;
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
    });

    scope.get("/conversations", async (request) => {
      const phone = (request.query as { phone?: string }).phone;
      return prisma.conversation.findMany({
        where: phone
          ? { customer: { phoneNumber: { contains: phone.replace(/^\+/, "") } } }
          : undefined,
        include: { customer: true, platformThreads: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });
    });

    scope.post("/webhooks/ycloud", async (request, reply) => {
      const raw = request.rawBody || "";
      if (!config.ycloud.skipSignature) {
        const secret = config.ycloud.webhookSecret;
        if (!secret) {
          return reply.code(500).send({ error: "YCLOUD_WEBHOOK_SECRET is not configured" });
        }
        const signature = header(request, "ycloud-signature");
        if (!verifyYCloudSignature(raw, signature, secret)) {
          return reply.code(401).send({ error: "invalid signature" });
        }
      }

      const parsed = parseYCloudEvent(request.body);
      if (!parsed) {
        return reply.code(400).send({ error: "invalid payload" });
      }

      const eventId =
        parsed.inbound?.eventId ||
        parsed.update?.eventId ||
        parsed.wabaUpdate?.eventId ||
        `ignored:${parsed.type}:${Date.now()}`;
      const claimed = await claimWebhookEvent("ycloud", eventId, parsed.type, request.body);
      reply.code(200).send({ ok: true, duplicate: !claimed });
      if (!claimed) return;

      setImmediate(() => {
        void (async () => {
          try {
            if (parsed.inbound) await handleWhatsAppInbound(parsed.inbound);
            if (parsed.update) await handleWhatsAppStatus(parsed.update);
            if (parsed.wabaUpdate) await applyWabaAccountUpdate(parsed.wabaUpdate);
            await markWebhookProcessed("ycloud", eventId);
          } catch (error) {
            request.log.error(error);
            await markWebhookProcessed("ycloud", eventId, (error as Error).message);
          }
        })();
      });
    });

    scope.post("/webhooks/feishu/:appId", async (request, reply) => {
      const appId = (request.params as { appId?: string }).appId || "";
      const creds = await getFeishuApp(appId);
      if (!creds) {
        return reply.code(404).send({
          error: "unknown feishu app",
          hint: "先 POST /api/feishu/apps 注册该 FEISHU_APP_ID",
        });
      }
      return handleFeishuWebhook(request, reply, creds);
    });

    scope.post("/webhooks/feishu", async (request, reply) => {
      return handleFeishuWebhook(request, reply, envFeishuCreds());
    });

    },
    { prefix: config.routePrefix },
  );

  if (config.routePrefix) {
    app.get("/health", healthHandler);
  }

  return app;
}
