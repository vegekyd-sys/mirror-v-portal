import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  BindingStore,
  isValidMentionOpenId,
  makeBinding,
  publicBinding,
} from "../src/bindings.js";
import { closePool } from "../src/db/pool.js";
import { buildState } from "../src/state.js";
import { ADMIN_HEADERS, makeSettings, resetTables } from "./helpers.js";

beforeEach(resetTables);
afterAll(closePool);

async function makeApp(overrides: Record<string, string> = {}) {
  const settings = makeSettings(overrides);
  const state = buildState(settings);
  const app = await buildApp({ settings, state });
  await app.ready();
  return { app, state };
}

async function upsert(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/bindings", headers: ADMIN_HEADERS, payload });
}

describe("mention open id 校验", () => {
  it("只接受空值或 ou_ 开头的合法 Open ID", () => {
    expect(isValidMentionOpenId("")).toBe(true);
    expect(isValidMentionOpenId("ou_15273b08310b914c5f97b27af680c149")).toBe(true);
    expect(isValidMentionOpenId("cli_app_id")).toBe(false);
    expect(isValidMentionOpenId("ou_bad></at>")).toBe(false);
  });
});

describe("BindingStore", () => {
  it("邮箱统一转小写后入库，mention_open_id 可读回", async () => {
    const store = new BindingStore();
    const saved = await store.put(
      makeBinding({
        agent_email: "Agent@Mail.DealClaw.io",
        webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/secret-token",
        mention_open_id: "ou_15273b08310b914c5f97b27af680c149",
      }),
    );

    expect(saved.agent_email).toBe("agent@mail.dealclaw.io");
    expect(publicBinding(saved)["mention_open_id"]).toBe(saved.mention_open_id);

    const readBack = await store.get("AGENT@mail.dealclaw.io");
    expect(readBack?.mention_open_id).toBe(saved.mention_open_id);
    // 密钥原样存库，只在对外展示时掩码
    expect(readBack?.webhook_url).toBe(
      "https://open.feishu.cn/open-apis/bot/v2/hook/secret-token",
    );
  });

  it("public() 掩码掉两个密钥和 webhook URL 尾部的 token", () => {
    const view = publicBinding(
      makeBinding({
        agent_email: "a@b.com",
        webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/super-secret-token",
        webhook_secret: "abcdefghijklmnop",
        app_secret: "short",
      }),
    );
    expect(view["webhook_url"]).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/…");
    expect(view["webhook_secret_hint"]).toBe("abcd…mnop");
    expect(view["app_secret_hint"]).toBe("(已设置)");
    expect(view["webhook_secret"]).toBeUndefined();
    expect(view["app_secret"]).toBeUndefined();
  });

  it("按供应商隔离，删除某家时不碰别家", async () => {
    const store = new BindingStore();
    await store.put(makeBinding({ agent_email: "a@x.com", supplier_id: "s1", webhook_url: "u", mention_open_id: "ou_a" }));
    await store.put(makeBinding({ agent_email: "b@x.com", supplier_id: "s1", webhook_url: "u", mention_open_id: "ou_b" }));
    await store.put(makeBinding({ agent_email: "c@x.com", supplier_id: "s2", webhook_url: "u", mention_open_id: "ou_c" }));

    expect((await store.allFor("s1")).length).toBe(2);
    expect(await store.deleteForSupplier("s1")).toBe(2);
    expect((await store.allFor("s1")).length).toBe(0);
    expect((await store.allFor("s2")).length).toBe(1);
  });
});

describe("POST /bindings", () => {
  it("配了 webhook_url 就必须给 mention_open_id", async () => {
    const { app, state } = await makeApp();
    const response = await upsert(app, {
      agent_email: "agent@mail.dealclaw.io",
      webhook_url: "https://example.com/hook",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(
      "mention_open_id is required when webhook_url is configured",
    );
    expect((await state.bindings.all()).length).toBe(0);
    await app.close();
  });

  it("应用机器人可以不配 mention_open_id", async () => {
    const { app, state } = await makeApp();
    const response = await upsert(app, {
      agent_email: "agent@mail.dealclaw.io",
      app_id: "cli_app",
      app_secret: "app-secret",
      chat_id: "oc_chat",
      prefer: "app",
    });

    expect(response.json().operation).toBe("created");
    expect((await state.bindings.get("agent@mail.dealclaw.io"))?.mention_open_id).toBe("");
    await app.close();
  });

  it("同一个邮箱再次提交是整条覆盖，且旧 App ID 的 token 会作废", async () => {
    const { app, state } = await makeApp();
    const invalidate = vi.spyOn(state.feishuApp, "invalidate");

    const created = await upsert(app, {
      agent_email: "Agent@Mail.DealClaw.io",
      app_id: "cli_old",
      app_secret: "old-secret",
      chat_id: "oc_old",
      prefer: "app",
      mention_open_id: "ou_old123",
      note: "old note",
    });
    const updated = await upsert(app, {
      agent_email: "agent@mail.dealclaw.io",
      webhook_url: "https://example.com/latest-hook",
      prefer: "custom",
      mention_open_id: "ou_latest456",
      note: "latest note",
    });

    const latest = await state.bindings.get("agent@mail.dealclaw.io");
    expect(created.json().operation).toBe("created");
    expect(updated.json().operation).toBe("updated");
    expect((await state.bindings.all()).length).toBe(1);
    expect(latest?.webhook_url).toBe("https://example.com/latest-hook");
    expect(latest?.app_id).toBe("");
    expect(latest?.app_secret).toBe("");
    expect(latest?.chat_id).toBe("");
    expect(latest?.mention_open_id).toBe("ou_latest456");
    expect(latest?.note).toBe("latest note");
    expect(latest?.supplier_id).toBe("supplier_test");
    expect(invalidate).toHaveBeenCalledWith("cli_old");
    await app.close();
  });

  it("代理邮箱已归属别家时拒绝，防跨租户劫持", async () => {
    const { app, state } = await makeApp();
    await state.bindings.put(
      makeBinding({
        agent_email: "agent@mail.dealclaw.io",
        supplier_id: "supplier_other",
        app_id: "cli_x",
        app_secret: "s",
        chat_id: "oc_x",
      }),
    );

    const response = await upsert(app, {
      agent_email: "agent@mail.dealclaw.io",
      app_id: "cli_mine",
      app_secret: "s",
      chat_id: "oc_mine",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("agent_email belongs to another supplier");
    await app.close();
  });
});

describe("管理接口鉴权", () => {
  it("没配 ADMIN_TOKEN 时整体关闭（fail closed）", async () => {
    const { app } = await makeApp({ ADMIN_TOKEN: "" });
    const response = await app.inject({ method: "GET", url: "/bindings", headers: ADMIN_HEADERS });
    expect(response.statusCode).toBe(503);
    expect(response.json().detail).toContain("ADMIN_TOKEN not configured");
    await app.close();
  });

  it("token 错误返回 401", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/bindings",
      headers: { ...ADMIN_HEADERS, "x-admin-token": "wrong" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("缺 X-Supplier-Id 返回 400，而不是静默落到默认租户", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/bindings",
      headers: { "x-admin-token": "test-admin-token" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().detail).toContain("missing X-Supplier-Id");
    await app.close();
  });

  it("停用的租户一律拒绝", async () => {
    const { app, state } = await makeApp();
    await state.suppliers.upsert("supplier_test", "测试租户");
    await state.suppliers.setActive("supplier_test", false);

    const response = await app.inject({ method: "GET", url: "/bindings", headers: ADMIN_HEADERS });
    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toContain("deactivated");
    await app.close();
  });

  it("别家的绑定按「不存在」处理，不用 403/404 差异泄露信息", async () => {
    const { app, state } = await makeApp();
    await state.bindings.put(
      makeBinding({
        agent_email: "other@mail.dealclaw.io",
        supplier_id: "supplier_other",
        app_id: "cli_x",
        app_secret: "s",
        chat_id: "oc_x",
      }),
    );
    const response = await app.inject({
      method: "DELETE",
      url: "/bindings/other@mail.dealclaw.io",
      headers: ADMIN_HEADERS,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("binding not found");
    await app.close();
  });
});
