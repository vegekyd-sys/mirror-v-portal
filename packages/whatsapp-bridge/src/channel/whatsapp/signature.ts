import { hmacSha256Hex, timingSafeEqualHex } from "../../lib/crypto";

const MAX_SKEW_SECONDS = 5 * 60;

export function verifyYCloudSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader) return false;

  const parts: Record<string, string> = {};
  for (const item of signatureHeader.split(",")) {
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    parts[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
  }

  const timestamp = parts.t;
  const signature = parts.s;
  if (!timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) {
    return false;
  }

  const expected = hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return timingSafeEqualHex(expected, signature);
}
