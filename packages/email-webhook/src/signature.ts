/**
 * Resend webhook 验签。
 *
 * Resend 的 webhook 走 Svix，签名头有两套等价命名（svix-* 和标准的 webhook-*），
 * 两套都要认。签名内容是 `{id}.{timestamp}.{原始body}` 的 HMAC-SHA256，
 * 所以 body 必须用未经解析的原始字节，不能重新序列化。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const ID_HEADERS = ["svix-id", "webhook-id"] as const;
const TIMESTAMP_HEADERS = ["svix-timestamp", "webhook-timestamp"] as const;
const SIGNATURE_HEADERS = ["svix-signature", "webhook-signature"] as const;

const SECRET_PREFIX = "whsec_";

/** 验签失败。调用方据此返回 401。 */
export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureError";
  }
}

export type Headers = Record<string, string | string[] | undefined>;

function pick(headers: Headers, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = headers[name];
    const single = Array.isArray(value) ? value[0] : value;
    if (single) return single;
  }
  return undefined;
}

/**
 * whsec_ 后面是 base64；也兼容直接给原始字符串的情况。
 *
 * Node 的 Buffer.from(x, "base64") 会**静默忽略**非法字符，而 Python 那边用的是
 * validate=True（非法即抛、回落到原始字节）。这里手动校验一次，否则形如
 * "not-base64!!" 的密钥两边会解出不同的 key，验签结果不一致。
 */
function decodeSecret(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(raw) && raw.length % 4 === 0 && raw.length > 0) {
    const decoded = Buffer.from(raw, "base64");
    // 再回编一次确认是严格合法的 base64（padding 位置不对时不会往返一致）
    if (decoded.toString("base64") === raw) return decoded;
  }
  return Buffer.from(raw, "utf8");
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual 要求等长；长度不同直接判否（长度本身不是秘密）
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** 单位秒，仅测试用于固定时间 */
  now?: number;
}

/** 验签通过返回消息 ID（用于幂等去重），否则抛 SignatureError。 */
export function verify(
  headers: Headers,
  body: Buffer,
  secret: string,
  { toleranceSeconds = 300, now }: VerifyOptions = {},
): string {
  const msgId = pick(headers, ID_HEADERS);
  const timestamp = pick(headers, TIMESTAMP_HEADERS);
  const signatureHeader = pick(headers, SIGNATURE_HEADERS);

  if (!msgId || !timestamp || !signatureHeader) {
    throw new SignatureError("missing webhook signature headers");
  }

  // Python 的 int() 不接受 "12.5"/"abc"，这里同样严格
  if (!/^-?\d+$/.test(timestamp.trim())) {
    throw new SignatureError("malformed webhook timestamp");
  }
  const sentAt = Number.parseInt(timestamp, 10);

  const current = Math.floor(now ?? Date.now() / 1000);
  if (Math.abs(current - sentAt) > toleranceSeconds) {
    throw new SignatureError("webhook timestamp outside tolerance window");
  }

  const signedContent = Buffer.concat([Buffer.from(`${msgId}.${timestamp}.`, "utf8"), body]);
  const expected = createHmac("sha256", decodeSecret(secret)).update(signedContent).digest("base64");

  // 签名头可能带多个版本，空格分隔，形如 "v1,xxx v1,yyy"（密钥轮换期）
  for (const token of signatureHeader.split(/\s+/).filter(Boolean)) {
    const comma = token.indexOf(",");
    const version = comma === -1 ? token : token.slice(0, comma);
    const candidate = comma === -1 ? "" : token.slice(comma + 1);
    if (version !== "v1") continue;
    if (equals(candidate, expected)) return msgId;
  }

  throw new SignatureError("no matching v1 signature");
}
