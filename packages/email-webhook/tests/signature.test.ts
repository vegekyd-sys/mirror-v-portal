/**
 * 验签是这个服务最不能出错的地方：签名基于原始字节，密钥解码规则也有坑
 * （whsec_ 后面是 base64，但非法 base64 要回落成原始字符串——Node 的
 * Buffer.from(x,"base64") 会静默忽略非法字符，和 Python 的 validate=True 不一致）。
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignatureError, verify } from "../src/signature.js";

const SECRET = `whsec_${Buffer.from("smoke-test-secret").toString("base64")}`;

function sign(secret: string, msgId: string, timestamp: string, body: Buffer): string {
  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(raw, "base64");
  const digest = createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${msgId}.${timestamp}.`), body]))
    .digest("base64");
  return `v1,${digest}`;
}

function headersFor(body: Buffer, secret = SECRET, now = 1_700_000_000) {
  const msgId = "msg_test";
  const timestamp = String(now);
  return {
    headers: {
      "svix-id": msgId,
      "svix-timestamp": timestamp,
      "svix-signature": sign(secret, msgId, timestamp, body),
    },
    now,
    msgId,
  };
}

describe("verify", () => {
  const body = Buffer.from(JSON.stringify({ type: "email.opened" }));

  it("合法签名返回 message id", () => {
    const { headers, now, msgId } = headersFor(body);
    expect(verify(headers, body, SECRET, { now })).toBe(msgId);
  });

  it("body 改一个字节就失败", () => {
    const { headers, now } = headersFor(body);
    const tampered = Buffer.from(JSON.stringify({ type: "email.clicked" }));
    expect(() => verify(headers, tampered, SECRET, { now })).toThrow(SignatureError);
  });

  it("缺头直接拒绝", () => {
    expect(() => verify({}, body, SECRET)).toThrow(/missing webhook signature headers/);
  });

  it("时间戳超出容忍窗口被拒（防重放）", () => {
    const { headers, now } = headersFor(body);
    expect(() => verify(headers, body, SECRET, { now: now + 301 })).toThrow(
      /outside tolerance window/,
    );
  });

  it("时间戳不是整数按格式错误处理", () => {
    const { headers, now } = headersFor(body);
    expect(() =>
      verify({ ...headers, "svix-timestamp": "not-a-number" }, body, SECRET, { now }),
    ).toThrow(/malformed webhook timestamp/);
  });

  it("webhook-* 系列头等价于 svix-*", () => {
    const { headers, now, msgId } = headersFor(body);
    const renamed = {
      "webhook-id": headers["svix-id"],
      "webhook-timestamp": headers["svix-timestamp"],
      "webhook-signature": headers["svix-signature"],
    };
    expect(verify(renamed, body, SECRET, { now })).toBe(msgId);
  });

  it("密钥轮换期同时带多个签名，命中其一即可", () => {
    const { headers, now, msgId } = headersFor(body);
    const multi = `v1,${Buffer.from("wrong").toString("base64")} ${headers["svix-signature"]}`;
    expect(verify({ ...headers, "svix-signature": multi }, body, SECRET, { now })).toBe(msgId);
  });

  it("非 v1 版本的签名不被接受", () => {
    const { headers, now } = headersFor(body);
    const v2 = headers["svix-signature"].replace("v1,", "v2,");
    expect(() => verify({ ...headers, "svix-signature": v2 }, body, SECRET, { now })).toThrow(
      /no matching v1 signature/,
    );
  });

  it("非法 base64 的密钥按原始字符串处理（与 Python 的 validate=True 行为一致）", () => {
    const plain = "whsec_not-valid-base64!!";
    const raw = plain.slice(6);
    const msgId = "msg_test";
    const timestamp = "1700000000";
    const digest = createHmac("sha256", Buffer.from(raw, "utf8"))
      .update(Buffer.concat([Buffer.from(`${msgId}.${timestamp}.`), body]))
      .digest("base64");
    const headers = {
      "svix-id": msgId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${digest}`,
    };
    expect(verify(headers, body, plain, { now: 1_700_000_000 })).toBe(msgId);
  });
});
