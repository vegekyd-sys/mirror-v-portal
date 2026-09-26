import { describe, expect, it, vi } from "vitest";
import { WeixinLogin } from "./weixin-login.js";
import { ilinkBaseUrl } from "./ilink-protocol.js";

describe("WeixinLogin iLink QR", () => {
  it("sends Tencent's QR and polling headers for a native scan", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mocked = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("get_bot_qrcode")) return Response.json({
        qrcode: "test-code", qrcode_img_content: "https://liteapp.weixin.qq.com/q/test",
      });
      return Response.json({ status: "expired" });
    });
    try {
      const login = new WeixinLogin({ bind: vi.fn(async () => {}) });
      const session = await login.start("tenant-1");
      expect(session.qrImage).toBe("https://liteapp.weixin.qq.com/q/test");
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      const postHeaders = calls[0].init?.headers as Record<string, string>;
      expect(postHeaders).toMatchObject({
        AuthorizationType: "ilink_bot_token",
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "132105",
      });
      expect(Buffer.from(postHeaders["X-WECHAT-UIN"], "base64").toString()).toMatch(/^\d+$/);
      expect(postHeaders.authorization).toBeUndefined();
      const pollHeaders = calls[1].init?.headers as Record<string, string>;
      expect(pollHeaders).toMatchObject({ "iLink-App-Id": "bot", "iLink-App-ClientVersion": "132105" });
      expect(pollHeaders.AuthorizationType).toBeUndefined();
    } finally { mocked.mockRestore(); }
  });

  it("passes the confirmed regional API address into the binding", async () => {
    const mocked = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("get_bot_qrcode")) return Response.json({
        qrcode: "test-code", qrcode_img_content: "https://liteapp.weixin.qq.com/q/test",
      });
      return Response.json({
        status: "confirmed", bot_token: "secret-test-token", ilink_bot_id: "bot-1", baseurl: "https://region.weixin.qq.com",
      });
    });
    try {
      const bind = vi.fn(async () => {});
      const login = new WeixinLogin({ bind });
      const session = await login.start("tenant-1");
      await vi.waitFor(() => expect(login.status(session.id)?.status).toBe("completed"));
      expect(bind).toHaveBeenCalledWith("tenant-1", "secret-test-token", "bot-1", "https://region.weixin.qq.com");
      expect(() => ilinkBaseUrl("https://attacker.example")).toThrow("ILINK_BASE_URL_INVALID");
    } finally { mocked.mockRestore(); }
  });

  it("rejects a confirmed API address outside Tencent before creating a binding", async () => {
    const mocked = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("get_bot_qrcode")) return Response.json({
        qrcode: "test-code", qrcode_img_content: "https://liteapp.weixin.qq.com/q/test",
      });
      return Response.json({
        status: "confirmed", bot_token: "secret-test-token", baseurl: "https://attacker.example",
      });
    });
    try {
      const bind = vi.fn(async () => {});
      const login = new WeixinLogin({ bind });
      const session = await login.start("tenant-1");
      await vi.waitFor(() => expect(login.status(session.id)?.status).toBe("failed"));
      expect(bind).not.toHaveBeenCalled();
      expect(login.status(session.id)?.error).toBe("ILINK_BASE_URL_INVALID");
    } finally { mocked.mockRestore(); }
  });
});
