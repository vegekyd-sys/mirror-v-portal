import type { FastifyInstance } from "fastify";
import { headerValue, queryBool, resolveCaller } from "../auth.js";
import {
  channelOf,
  isValidMentionOpenId,
  makeBinding,
  publicBinding,
} from "../bindings.js";
import { extractAddress, parse } from "../events.js";
import { buildCard } from "../notify.js";

/**
 * 绑定请求体。agent_email 是我方代理邮箱，不是买家邮箱。
 *
 * 两种通道至少配一种：
 *   自定义机器人 → webhook_url + mention_open_id（+ 可选 webhook_secret）
 *   应用机器人   → app_id + app_secret + chat_id
 */
interface BindingIn {
  agent_email: string;
  webhook_url?: string;
  webhook_secret?: string;
  app_id?: string;
  app_secret?: string;
  chat_id?: string;
  prefer?: string;
  mention_open_id?: string;
  note?: string;
}

const bindingInSchema = {
  type: "object",
  required: ["agent_email"],
  properties: {
    agent_email: { type: "string", description: "我方代理邮箱，如 thia@mail.dealclaw.io" },
    webhook_url: { type: "string", default: "", description: "自定义机器人 webhook 地址" },
    webhook_secret: { type: "string", default: "", description: "自定义机器人验签码，没开签名校验就留空" },
    app_id: { type: "string", default: "", description: "飞书自建应用 App ID，cli_ 开头" },
    app_secret: { type: "string", default: "", description: "飞书自建应用 App Secret" },
    chat_id: { type: "string", default: "", description: "目标群 ID，oc_ 开头" },
    prefer: { type: "string", default: "custom", description: "两个都配时优先用哪个：custom / app" },
    mention_open_id: {
      type: "string",
      default: "",
      description: "卡片中要 @ 的负责人 Open ID；配置 webhook_url 时必填，ou_ 开头",
    },
    note: { type: "string", default: "", description: "备注，可选" },
  },
} as const;

export async function registerBindingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 列出某个供应商名下的绑定。密钥只返回掩码。
   *
   * 默认按 X-Supplier-Id 隔离；?all_suppliers=true 跨租户列全部（运维用）。
   */
  app.get<{ Querystring: { all_suppliers?: string } }>("/bindings", async (request) => {
    const state = request.server.state;
    const allSuppliers = queryBool(request.query.all_suppliers);
    const caller = await resolveCaller(
      state,
      headerValue(request.headers["x-admin-token"]),
      headerValue(request.headers["x-supplier-id"]),
      allSuppliers,
    );
    const scoped = allSuppliers
      ? await state.bindings.all()
      : await state.bindings.allFor(caller.supplierId);
    return {
      count: scoped.length,
      supplier_id: allSuppliers ? null : caller.supplierId,
      bindings: scoped.map(publicBinding),
    };
  });

  /** 新增或覆盖一条绑定。同一个 agent_email 再次提交即覆盖。 */
  app.post<{ Body: BindingIn }>(
    "/bindings",
    { schema: { body: bindingInSchema } },
    async (request, reply) => {
      const state = request.server.state;
      const caller = await resolveCaller(
        state,
        headerValue(request.headers["x-admin-token"]),
        headerValue(request.headers["x-supplier-id"]),
      );
      const payload = request.body;

      const email = extractAddress(payload.agent_email);
      if (!email || !email.includes("@")) {
        return reply.code(400).send({ error: "agent_email is not a valid address" });
      }

      // 一个代理邮箱只归一家。已被别的供应商占用时拒绝，防止跨租户劫持通知。
      const existing = await state.bindings.get(email);
      if (existing !== null && existing.supplier_id && existing.supplier_id !== caller.supplierId) {
        return reply.code(409).send({
          error: "agent_email belongs to another supplier",
          detail: "该代理邮箱已归属其他供应商，如需转移请联系平台管理员",
        });
      }

      const candidate = makeBinding({
        agent_email: email,
        supplier_id: caller.supplierId,
        webhook_url: (payload.webhook_url ?? "").trim(),
        webhook_secret: (payload.webhook_secret ?? "").trim(),
        app_id: (payload.app_id ?? "").trim(),
        app_secret: (payload.app_secret ?? "").trim(),
        chat_id: (payload.chat_id ?? "").trim(),
        prefer: (payload.prefer ?? "").trim().toLowerCase() || "custom",
        mention_open_id: (payload.mention_open_id ?? "").trim(),
        note: (payload.note ?? "").trim(),
      });

      if (candidate.webhook_url && !candidate.mention_open_id) {
        return reply
          .code(400)
          .send({ error: "mention_open_id is required when webhook_url is configured" });
      }
      if (!isValidMentionOpenId(candidate.mention_open_id)) {
        return reply
          .code(400)
          .send({ error: "mention_open_id must be empty or a valid ou_ Open ID" });
      }
      if (channelOf(candidate) === "none") {
        return reply.code(400).send({
          error: "no usable channel",
          detail: "需要 webhook_url，或者 app_id + app_secret + chat_id 三者齐全",
        });
      }

      const previous = existing;
      const binding = await state.bindings.put(candidate);
      // 换了凭据就把新旧 App ID 的 token 都作废，否则最长 2 小时还可能使用旧凭据。
      for (const appId of new Set([previous?.app_id ?? "", binding.app_id])) {
        if (appId) state.feishuApp.invalidate(appId);
      }
      return {
        status: "saved",
        operation: previous ? "updated" : "created",
        binding: publicBinding(binding),
      };
    },
  );

  app.delete<{ Params: { agentEmail: string } }>(
    "/bindings/:agentEmail",
    async (request, reply) => {
      const state = request.server.state;
      const caller = await resolveCaller(
        state,
        headerValue(request.headers["x-admin-token"]),
        headerValue(request.headers["x-supplier-id"]),
      );
      const email = extractAddress(request.params.agentEmail);

      // 不属于自己的一律按「不存在」处理，避免用 404/403 的差异探测别家绑了哪些邮箱
      if ((await state.bindings.getOwned(email, caller.supplierId)) === null) {
        return reply.code(404).send({ error: "binding not found" });
      }

      await state.bindings.delete(email);
      return { status: "deleted", agent_email: email, supplier_id: caller.supplierId };
    },
  );

  /** 用一条假事件验证绑定能不能真的把卡片发到群里。 */
  app.post<{ Params: { agentEmail: string } }>(
    "/bindings/:agentEmail/test",
    async (request, reply) => {
      const state = request.server.state;
      const caller = await resolveCaller(
        state,
        headerValue(request.headers["x-admin-token"]),
        headerValue(request.headers["x-supplier-id"]),
      );
      const email = extractAddress(request.params.agentEmail);
      const binding = await state.bindings.getOwned(email, caller.supplierId);
      if (binding === null) {
        return reply.code(404).send({ error: "binding not found" });
      }

      const probe = parse(
        {
          type: "email.received",
          created_at: "",
          data: {
            email_id: "binding-test",
            from: "Binding Test <binding-test@example.com>",
            to: [email],
            received_for: [email],
            subject: "绑定测试 — 收到这条说明配置正确",
            attachments: [],
          },
        },
        "binding-test",
      );

      const mentionOpenId = state.settings.feishuMentionEvents.has(probe.eventType)
        ? binding.mention_open_id
        : "";
      const result = await state.notifier.sendViaBinding(
        binding,
        buildCard(probe, null, mentionOpenId),
      );
      return {
        agent_email: email,
        channel: channelOf(binding),
        chat_id: binding.chat_id || null,
        result,
      };
    },
  );
}
