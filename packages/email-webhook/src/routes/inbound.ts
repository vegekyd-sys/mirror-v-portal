import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { headerValue } from "../auth.js";
import { parse } from "../events.js";
import type { JsonObject } from "../events.js";
import { SignatureError, verify } from "../signature.js";

export async function registerInboundRoutes(app: FastifyInstance): Promise<void> {
  app.post("/inbound", async (request: FastifyRequest, reply: FastifyReply) => {
    const state = request.server.state;
    const settings = state.settings;
    const body = request.rawBody ?? Buffer.alloc(0);

    // --- 1. 验签（验收标准 3：失败必须拒绝）---
    let messageId: string;
    if (settings.signingSecret) {
      try {
        messageId = verify(request.headers, body, settings.signingSecret, {
          toleranceSeconds: settings.signatureToleranceSeconds,
        });
      } catch (err) {
        if (!(err instanceof SignatureError)) throw err;
        request.log.warn(`验签失败，已拒绝: ${err.message}`);
        return reply.code(401).send({ error: "invalid signature", detail: err.message });
      }
    } else if (settings.allowUnsigned) {
      // 仅本地联调用。用 body 摘要当 messageId，保证去重依然有效
      messageId =
        headerValue(request.headers["svix-id"]) || createHash("sha256").update(body).digest("hex");
      request.log.warn(`ALLOW_UNSIGNED=true，跳过验签 message_id=${messageId}`);
    } else {
      request.log.error("RESEND_SIGNING_SECRET 未配置且未开启 ALLOW_UNSIGNED，拒绝请求");
      return reply.code(401).send({ error: "signing secret not configured" });
    }

    // --- 2. 解析 ---
    const parsed = request.body;
    if (request.jsonError !== undefined) {
      return reply.code(400).send({ error: "invalid json", detail: request.jsonError });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return reply
        .code(400)
        .send({ error: "invalid json", detail: "payload is not a JSON object" });
    }
    const payload = parsed as JsonObject;

    const event = parse(payload, messageId);
    if (!event.eventType) {
      return reply.code(400).send({ error: "missing event type" });
    }

    // --- 3. 落库 + 幂等（一步完成）---
    // message_id 上有唯一约束，ON CONFLICT DO NOTHING 插不进去就是重复投递。
    // 这一步失败要让 Resend 重试，所以返回 5xx。
    let inserted: boolean;
    try {
      ({ inserted } = await state.events.insert(event));
    } catch (err) {
      request.log.error({ err }, "事件落库失败");
      return reply
        .code(500)
        .send({ error: "failed to persist event", detail: (err as Error).message });
    }

    if (!inserted) {
      request.log.info(`重复事件已忽略 message_id=${messageId}`);
      return { status: "duplicate", message_id: messageId, event_type: event.eventType };
    }

    const result: Record<string, unknown> = {
      status: "accepted",
      message_id: messageId,
      event_type: event.eventType,
      lead_status: event.status ?? null,
      persisted_to: "postgres:email_events",
    };

    // --- 4. 线索状态（验收标准 5）---
    // 事件已经落库，后面这两步失败也返回 200：重推没有意义，
    // 失败细节写在响应和日志里。
    try {
      result["lead"] = await state.leads.apply(event);
    } catch (err) {
      request.log.error({ err }, "线索状态更新失败");
      result["lead"] = { backend: state.leads.name, error: (err as Error).message };
    }

    // --- 5. 飞书通知（验收标准 6）---
    try {
      result["notify"] = await state.notifier.send(event);
    } catch (err) {
      request.log.error({ err }, "飞书通知失败");
      result["notify"] = { sent: false, reason: (err as Error).message };
    }

    return result;
  });
}
