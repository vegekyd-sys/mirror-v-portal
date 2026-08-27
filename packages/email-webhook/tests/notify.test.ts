/**
 * 通知路由：只按代理邮箱查绑定，没有全局兜底。
 *
 * 早期版本在「未命中绑定」时会回落到一组全局的 FEISHU_WEBHOOK_URL/SECRET/
 * MENTION_OPEN_ID。那条路在多租户下是个跨租户泄露口子：A 家的买家回信
 * （含正文预览）会被推到平台或 B 家的群里，绕过 supplier_id 隔离。
 * 这些用例守住「查不到绑定就不发，并说清是哪个邮箱」这个行为。
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { makeBinding } from "../src/bindings.js";
import { closePool } from "../src/db/pool.js";
import { buildState } from "../src/state.js";
import { makeSettings, resetTables } from "./helpers.js";

beforeEach(resetTables);
afterAll(closePool);

async function makeApp() {
  const settings = makeSettings({ ALLOW_UNSIGNED: "true" });
  const state = buildState(settings);
  const app = await buildApp({ settings, state });
  await app.ready();
  return { app, state };
}

/** 收信事件：代理邮箱取 received_for，买家在 from 侧 */
function inboundReply(app: Awaited<ReturnType<typeof makeApp>>["app"], agentEmail: string, svixId: string) {
  return app.inject({
    method: "POST",
    url: "/inbound",
    headers: { "content-type": "application/json", "svix-id": svixId },
    payload: {
      type: "email.received",
      data: {
        email_id: "e1",
        from: "Buyer <buyer@example.com>",
        to: [agentEmail],
        received_for: [agentEmail],
        subject: "回复：报价",
      },
    },
  });
}

describe("通知路由", () => {
  it("未命中绑定时不发送，reason 点名是哪个代理邮箱", async () => {
    const { app } = await makeApp();
    const response = await inboundReply(app, "unbound@mail.dealclaw.io", "msg_nb1");

    const notify = response.json().notify;
    expect(response.json().status).toBe("accepted"); // 事件照常入库
    expect(notify.sent).toBe(false);
    expect(notify.via).toBe("none");
    expect(notify.bound).toBe(false);
    expect(notify.reason).toBe("no binding for unbound@mail.dealclaw.io");
    // 不该再出现任何全局兜底的痕迹
    expect(notify.reason).not.toContain("FEISHU_WEBHOOK_URL");
    await app.close();
  });

  it("别家有绑定不会让本家的事件误发出去", async () => {
    const { app, state } = await makeApp();
    // supplier_other 配了一条绑定，但事件的代理邮箱不是它
    await state.bindings.put(
      makeBinding({
        agent_email: "other@mail.dealclaw.io",
        supplier_id: "supplier_other",
        webhook_url: "https://open.feishu.cn/open-apis/bot/v2/hook/other-tenant",
        mention_open_id: "ou_other",
      }),
    );

    const response = await inboundReply(app, "mine@mail.dealclaw.io", "msg_nb2");
    const notify = response.json().notify;

    expect(notify.sent).toBe(false);
    expect(notify.reason).toBe("no binding for mine@mail.dealclaw.io");
    // 绝不能出现另一家的 webhook
    expect(JSON.stringify(notify)).not.toContain("other-tenant");
    await app.close();
  });

  it("事件类型不在 NOTIFY_EVENTS 里时，连绑定都不查", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/inbound",
      headers: { "content-type": "application/json", "svix-id": "msg_nb3" },
      payload: {
        type: "email.delivered",
        data: { email_id: "e1", from: "a@b.com", to: ["x@y.com"], subject: "s" },
      },
    });

    const notify = response.json().notify;
    expect(notify.sent).toBe(false);
    expect(notify.reason).toBe("email.delivered not in NOTIFY_EVENTS");
    await app.close();
  });
});
