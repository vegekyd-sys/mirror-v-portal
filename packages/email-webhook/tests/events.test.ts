/**
 * 事件落库、幂等、增量拉取。
 *
 * 幂等这块是这次换存储最实质的变化：原来靠 Redis SETNX，Redis 挂了会 fail open
 * 静默放行、导致重复推飞书；现在是 email_events.message_id 上的唯一约束，
 * 插不进去就是重复，保证来自数据库本身。
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closePool } from "../src/db/pool.js";
import { parse } from "../src/events.js";
import { EventStore } from "../src/storage/events.js";
import { buildState } from "../src/state.js";
import { makeSettings, resetTables } from "./helpers.js";

beforeEach(resetTables);
afterAll(closePool);

async function makeApp() {
  const settings = makeSettings({ ALLOW_UNSIGNED: "true" });
  const app = await buildApp({ settings, state: buildState(settings) });
  await app.ready();
  return app;
}

function event(messageId: string, type = "email.opened") {
  return parse(
    {
      type,
      data: {
        email_id: `eid_${messageId}`,
        from: "DealClaw <noreply@dealclaw.test>",
        to: ["buyer@example.com"],
        subject: `subject ${messageId}`,
      },
    },
    messageId,
  );
}

function post(app: Awaited<ReturnType<typeof makeApp>>, svixId: string, type = "email.opened") {
  return app.inject({
    method: "POST",
    url: "/inbound",
    headers: { "content-type": "application/json", "svix-id": svixId },
    payload: {
      type,
      data: { email_id: "e1", from: "a@b.com", to: ["buyer@example.com"], subject: "s" },
    },
  });
}

describe("EventStore 幂等", () => {
  it("同一个 message_id 只落一条，第二次 inserted=false", async () => {
    const store = new EventStore();
    const first = await store.insert(event("msg_dup"));
    const second = await store.insert(event("msg_dup"));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const [rows] = await store.readSince("", 50);
    expect(rows.length).toBe(1);
  });

  it("不同 message_id 各落一条", async () => {
    const store = new EventStore();
    await store.insert(event("msg_a"));
    await store.insert(event("msg_b"));
    const [rows] = await store.readSince("", 50);
    expect(rows.map((r) => r.message_id).sort()).toEqual(["msg_a", "msg_b"]);
  });
});

describe("POST /inbound 端到端", () => {
  it("首次接收返回 accepted，重复投递返回 duplicate", async () => {
    const app = await makeApp();

    const first = await post(app, "msg_e2e");
    const second = await post(app, "msg_e2e");

    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("accepted");
    expect(first.json().persisted_to).toBeTruthy();

    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("duplicate");
    expect(second.json().message_id).toBe("msg_e2e");

    await app.close();
  });

  it("没有状态映射的事件类型不落 lead_status，但仍然入库", async () => {
    const app = await makeApp();
    const response = await post(app, "msg_unknown", "email.unknown_type");
    expect(response.json().status).toBe("accepted");
    expect(response.json().lead_status).toBeNull();
    await app.close();
  });
});

describe("/v1/events 增量拉取", () => {
  it("按游标只返回之后的事件，has_more 正确", async () => {
    const store = new EventStore();
    const a = await store.insert(event("m1"));
    await store.insert(event("m2"));
    await store.insert(event("m3"));

    const [firstPage, hasMore] = await store.readSince("", 2);
    expect(firstPage.length).toBe(2);
    expect(hasMore).toBe(true);

    const [afterFirst] = await store.readSince(a.receivedAt, 50);
    expect(afterFirst.map((r) => r.message_id)).toEqual(["m2", "m3"]);

    const last = afterFirst[afterFirst.length - 1];
    const [tail, tailHasMore] = await store.readSince(last!.cursor, 50);
    expect(tail.length).toBe(0);
    expect(tailHasMore).toBe(false);
  });

  it("游标是 Python 风格的时间戳也认（交给 Postgres 解析，不是字符串比较）", async () => {
    const store = new EventStore();
    await store.insert(event("m_old"));

    // poller 里存的可能是老服务写的 `+00:00` 格式，而不是 JS 的 `Z`
    const pythonStyle = "1970-01-01T00:00:00.000000+00:00";
    const [rows] = await store.readSince(pythonStyle, 50);
    expect(rows.map((r) => r.message_id)).toEqual(["m_old"]);

    const future = "2999-01-01T00:00:00.000000+00:00";
    const [none] = await store.readSince(future, 50);
    expect(none.length).toBe(0);
  });

  it("接口返回的 payload 取的是 Resend 的 data 子对象", async () => {
    const app = await makeApp();
    await post(app, "msg_payload");

    const response = await app.inject({
      method: "GET",
      url: "/v1/events?limit=10",
      headers: { authorization: "Bearer test-admin-token" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.count).toBe(1);
    expect(body.events[0].svix_id).toBe("msg_payload");
    expect(body.events[0].payload.email_id).toBe("e1");
    expect(body.next_cursor).toBe(body.events[0].sequence);
    await app.close();
  });

  it("没有 Bearer token 一律 401", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/v1/events" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
