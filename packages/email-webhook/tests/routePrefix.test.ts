/**
 * ROUTE_PREFIX 的路由挂载行为。
 *
 * 关注三件事：
 *   1. 不设前缀时路由和历史完全一致（systemd 部署不受影响）
 *   2. 设了前缀后业务路由整体搬到前缀下，老路径不再响应
 *   3. /health 无论如何都留在根路径 —— k8s 探针直连 Pod，拿不到 Ingress 的前缀
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { closePool } from "../src/db/pool.js";
import { makeSettings, resetTables } from "./helpers.js";

beforeEach(resetTables);
afterAll(closePool);

let app: FastifyInstance | undefined;

async function appWithPrefix(prefix: string | undefined) {
  const settings = makeSettings(prefix === undefined ? {} : { ROUTE_PREFIX: prefix });
  app = await buildApp({ settings });
  await app.ready();
  return app;
}

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function status(instance: FastifyInstance, url: string): Promise<number> {
  return (await instance.inject({ method: "GET", url })).statusCode;
}

describe("无前缀", () => {
  it("保持历史路径", async () => {
    const instance = await appWithPrefix(undefined);
    expect(await status(instance, "/health")).toBe(200);
    expect(await status(instance, "/openapi.json")).toBe(200);
    // 管理接口存在（缺租户头 → 400，而不是 404）
    expect(await status(instance, "/bindings")).not.toBe(404);
  });
});

describe("有前缀", () => {
  it("业务路由整体搬到前缀下，老路径不再响应", async () => {
    const instance = await appWithPrefix("/webhook");
    expect(await status(instance, "/webhook/health")).toBe(200);
    expect(await status(instance, "/webhook/openapi.json")).toBe(200);
    expect(await status(instance, "/webhook/bindings")).not.toBe(404);
    expect(await status(instance, "/bindings")).toBe(404);
    expect(await status(instance, "/inbound")).toBe(404);
  });

  it("/health 仍然留在根路径，供 k8s 探针直连 Pod", async () => {
    const instance = await appWithPrefix("/webhook");
    const root = await instance.inject({ method: "GET", url: "/health" });
    const prefixed = await instance.inject({ method: "GET", url: "/webhook/health" });
    expect(root.statusCode).toBe(200);
    expect(root.json().status).toBe("ok");
    // 两处返回的是同一份内容
    expect(root.json().checks).toEqual(prefixed.json().checks);
  });

  it.each(["webhook", "/webhook/", "webhook/"])("前缀写法 %s 会被归一化", async (raw) => {
    const instance = await appWithPrefix(raw);
    expect(await status(instance, "/webhook/health")).toBe(200);
  });

  it("只写一个斜杠等于没有前缀", async () => {
    const instance = await appWithPrefix("/");
    expect(await status(instance, "/health")).toBe(200);
    expect(await status(instance, "/bindings")).not.toBe(404);
  });
});
