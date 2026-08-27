/**
 * Fastify 装配。
 *
 * 所有业务路由都挂在 ROUTE_PREFIX 之下（默认空 = 历史路由；k8s 里设 /webhook，
 * 路径即 /webhook/inbound 等，网关不需要 StripPrefix）。/health 额外无条件挂在
 * 根路径上，因为 k8s 探针直连 Pod，不经过网关。
 *
 * /inbound 的处理顺序（任一环节失败都不会丢事件，也不会让 Resend 白白重试）：
 *   验签 -> 解析 -> 幂等去重 -> 落盘 -> 落库 -> 更新线索 -> 飞书通知
 * 落盘之后的环节即使失败也返回 200，因为事件已经持久化，重推没有意义；
 * 落盘之前失败才返回非 2xx，让 Resend 重试。
 */

import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import { getSettings } from "./config.js";
import type { Settings } from "./config.js";
import { HttpError } from "./auth.js";
import { setLogLevel } from "./logger.js";
import { buildState } from "./state.js";
import type { AppState } from "./state.js";
import { VERSION } from "./version.js";
import { healthHandler } from "./routes/health.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerInboundRoutes } from "./routes/inbound.js";
import { registerBindingRoutes } from "./routes/bindings.js";
import { registerSupplierRoutes } from "./routes/suppliers.js";

declare module "fastify" {
  interface FastifyInstance {
    state: AppState;
  }
  interface FastifyRequest {
    /** 未经解析的请求体。验签基于原始字节，不能用重新序列化的结果。 */
    rawBody?: Buffer;
    /** JSON 解析失败时的原因，由路由决定怎么回。 */
    jsonError?: string;
  }
}

export interface BuildAppOptions {
  settings?: Settings;
  state?: AppState;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const settings = options.settings ?? getSettings();
  const prefix = settings.routePrefix;
  setLogLevel(settings.logLevel);

  const app = Fastify({
    logger: {
      level: settings.logLevel.toLowerCase(),
      // httpx 那边的教训：飞书自定义机器人把凭据放在 URL 里，日志绝不能打完整 URL
      redact: {
        paths: ['req.headers["x-admin-token"]', "req.headers.authorization"],
        censor: "***",
      },
    },
    // nginx/ALB 侧限的是 512k，这里给同样的上限，避免大包打到应用层
    bodyLimit: 512 * 1024,
    trustProxy: true,
  });

  app.decorate("state", options.state ?? buildState(settings));
  app.decorateRequest("rawBody", undefined);
  app.decorateRequest("jsonError", undefined);

  /**
   * 关键：保留原始字节。
   * Resend 的 Svix 签名是对 `{id}.{ts}.{原始body}` 做 HMAC，任何重新序列化
   * （哪怕只是键顺序或空格不同）都会导致签名对不上。这里一次性配好：
   * rawBody 永远是收到的字节，body 仍是解析后的对象供其余路由使用。
   */
  const parser = (
    request: { rawBody?: Buffer; jsonError?: string },
    body: Buffer,
    done: (err: Error | null, result?: unknown) => void,
  ): void => {
    request.rawBody = body;
    if (body.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch (err) {
      // 不在这里抛：/inbound 要先验签再报 JSON 错误，且错误体格式是自己定的
      request.jsonError = (err as Error).message;
      done(null, undefined);
    }
  };
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, parser);
  // Resend 正常发 application/json；带 charset 或其他 content-type 时也要能验签
  app.addContentTypeParser("*", { parseAs: "buffer" }, parser);

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof HttpError) {
      // 对齐 FastAPI 的 HTTPException：响应体是 {"detail": ...}
      return reply.code(error.statusCode).send({ detail: error.detail });
    }
    if (error.validation) {
      // 对齐 FastAPI/pydantic 的 422
      return reply.code(422).send({ detail: error.validation });
    }
    request.log.error({ err: error }, "未处理的异常");
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    return reply.code(status).send({ error: error.message || "internal server error" });
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "DealClaw 邮件 Webhook 接收服务",
        version: VERSION,
      },
    },
  });

  // 业务路由统一挂在前缀下
  await app.register(
    async (scope) => {
      scope.get("/health", healthHandler);
      await registerEventRoutes(scope);
      await registerInboundRoutes(scope);
      await registerBindingRoutes(scope);
      await registerSupplierRoutes(scope);
    },
    { prefix },
  );

  if (prefix) {
    // k8s 的存活/就绪探针直连 Pod，不经过 Ingress，拿不到前缀；
    // 同一个 health 处理函数再在根路径挂一次，两边行为完全一致。
    app.get("/health", { schema: { hide: true } }, healthHandler);
  }

  // FastAPI 的 openapi.json 在前缀下，保持一致
  app.get(`${prefix}/openapi.json`, { schema: { hide: true } }, async () => app.swagger());

  await app.register(fastifySwaggerUi, {
    routePrefix: `${prefix}/docs`,
    uiConfig: { docExpansion: "list", deepLinking: true },
  });

  return app;
}
