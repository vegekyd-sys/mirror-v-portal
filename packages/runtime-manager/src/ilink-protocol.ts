import { randomBytes } from "node:crypto";

// Match Tencent's published iLink client metadata for the QR and Bot APIs.
// Keep this version in sync with the protocol version used by the channel.
const CHANNEL_VERSION = "2.4.9";
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 9;
const common = {
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": String(CLIENT_VERSION),
};

export function ilinkBaseUrl(value?: string) {
  if (!value) return "https://ilinkai.weixin.qq.com";
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".weixin.qq.com") || url.port || url.username || url.password)
    throw new Error("ILINK_BASE_URL_INVALID");
  return url.origin;
}

export function ilinkPollHeaders() {
  return { ...common };
}

export function ilinkPostHeaders(token?: string) {
  const uin = randomBytes(4).readUInt32BE(0);
  return {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(uin)).toString("base64"),
    ...common,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export function ilinkBaseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: "MirrorVPortal/0.1.0" };
}
