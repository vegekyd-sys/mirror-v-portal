import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

// Wire format verified against Tencent/openclaw-weixin (MIT):
// https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md
// Crypto/reference logic: src/cdn/pic-decrypt.ts, src/cdn/aes-ecb.ts, src/cdn/cdn-url.ts.
// Current protocol supports full_url before the encrypted query. The installed 1.0.2
// downloader predates that fallback. image_item.aeskey is the preferred hex key;
// media.aes_key accepts base64(raw16) or base64(hex32). Both use AES-128-ECB/PKCS#7.
// Do not reuse its downloader: it logs signed URLs/keys and has no byte/time bound.
export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const ILINK_IMAGE_MAX_BYTES = 15 * 1024 * 1024;

export interface ILinkImageItem {
  type?: number;
  image_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number; full_url?: string };
    aeskey?: string;
    /** The official image sender puts ciphertext bytes here, not plaintext bytes. */
    mid_size?: number;
  };
}
export interface ILinkImageOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  cdnBaseUrl?: string;
  /** Optional trusted expectations; inbound ImageItem declares no plaintext hash. */
  expectedBytes?: number;
  expectedSha256?: string;
  expectedMd5?: string;
}
export interface ILinkDecodedImage {
  buffer: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  filename: string;
  bytes: number;
  sha256: string;
  md5: string;
  encrypted: boolean;
}

/** Only fixed codes and an HTTP status are safe for channel/event logs. */
export class ILinkMediaError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) { super(code); this.name = "ILinkMediaError"; }
}
function fail(code: string): never { throw new ILinkMediaError(`ILINK_MEDIA_${code}`); }

function integer(value: unknown, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (result as number) <= 0 || (result as number) > maximum) fail("INVALID_LIMIT");
  return result as number;
}
function cdnUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { return fail("INVALID_CDN_URL"); }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".cdn.weixin.qq.com") || url.port || url.username || url.password || url.hash
    || input.length > 32768 || !["/c2c/download", "/download"].includes(url.pathname)) fail("INVALID_CDN_URL");
  return url;
}
function downloadUrl(media: NonNullable<NonNullable<ILinkImageItem["image_item"]>["media"]>, base: string): URL {
  if (media.full_url) return cdnUrl(media.full_url);
  const query = media.encrypt_query_param;
  if (typeof query !== "string" || !query || query.length > 16384 || /[\r\n\0]/.test(query)) fail("REFERENCE_MISSING");
  let baseUrl: URL;
  try { baseUrl = new URL(base); } catch { return fail("INVALID_CDN_URL"); }
  if (baseUrl.search || baseUrl.hash || !["/c2c", "/c2c/", "/"].includes(baseUrl.pathname)) fail("INVALID_CDN_URL");
  const url = cdnUrl(`${base.replace(/\/$/, "")}/download`);
  url.searchParams.set("encrypted_query_param", query);
  return url;
}

/** Prefer the stable top-level hex key (also handles CDN content deduplication). */
export function ilinkImageAesKey(image: NonNullable<ILinkImageItem["image_item"]>): Buffer | null {
  if (image.aeskey) {
    if (typeof image.aeskey !== "string" || !/^[a-fA-F0-9]{32}$/.test(image.aeskey)) fail("INVALID_AES_KEY");
    return Buffer.from(image.aeskey, "hex");
  }
  const encoded = image.media?.aes_key;
  if (encoded === undefined || encoded === "") return null;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 44) fail("INVALID_AES_KEY");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) fail("INVALID_AES_KEY");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-fA-F0-9]{32}$/.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
  return fail("INVALID_AES_KEY");
}

function abortError(signal: AbortSignal): ILinkMediaError {
  return new ILinkMediaError(signal.reason?.name === "TimeoutError" ? "ILINK_MEDIA_TIMEOUT" : "ILINK_MEDIA_ABORTED");
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw abortError(signal); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}
async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) {
    void response.body?.cancel().catch(() => {});
    fail("TOO_LARGE");
  }
  if (!response.body) return fail("EMPTY_BODY");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await bounded(reader.read(), signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) fail("TOO_LARGE");
      chunks.push(Buffer.from(result.value));
    }
    if (!size) fail("EMPTY_BODY");
    return Buffer.concat(chunks, size);
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
}

function dimensions(width: number, height: number) {
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64_000_000) fail("INVALID_IMAGE");
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Byte signatures plus container structure; full visual decode is a downstream acceptance check. */
function imageFormat(bytes: Buffer): { mimeType: ILinkDecodedImage["mimeType"]; extension: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") fail("INVALID_IMAGE");
    dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    let offset = 8, hasData = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), end = offset + length + 12;
      if (end > bytes.length) fail("INVALID_IMAGE");
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (type === "IHDR" && offset !== 8) fail("INVALID_IMAGE");
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail("INVALID_IMAGE");
      if (type === "IDAT") hasData = true;
      if (type === "IEND") { if (length !== 0 || end !== bytes.length) fail("INVALID_IMAGE"); ended = true; }
      offset = end;
    }
    if (!hasData || !ended || offset !== bytes.length) fail("INVALID_IMAGE");
    return { mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    let offset = 2, frame = false, scan = false;
    while (offset < bytes.length - 2) {
      if (bytes[offset++] !== 0xff) fail("INVALID_IMAGE");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length) fail("INVALID_IMAGE");
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) fail("INVALID_IMAGE");
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) fail("INVALID_IMAGE");
        dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)); frame = true;
      }
      if (marker === 0xda) { scan = true; break; }
      offset += length;
    }
    if (!frame || !scan) fail("INVALID_IMAGE");
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 14 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) && bytes[bytes.length - 1] === 0x3b) {
    dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
    let offset = 13 + ((bytes[10] & 128) ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0), hasImage = false, ended = false;
    const subblocks = () => {
      while (offset < bytes.length) {
        const length = bytes[offset++];
        if (length === 0) return;
        offset += length;
        if (offset > bytes.length) fail("INVALID_IMAGE");
      }
      fail("INVALID_IMAGE");
    };
    while (offset < bytes.length) {
      const block = bytes[offset++];
      if (block === 0x3b) { if (offset !== bytes.length) fail("INVALID_IMAGE"); ended = true; break; }
      if (block === 0x21) { if (offset >= bytes.length) fail("INVALID_IMAGE"); offset++; subblocks(); }
      else if (block === 0x2c) {
        if (offset + 9 >= bytes.length) fail("INVALID_IMAGE");
        dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6));
        const packed = bytes[offset + 8]; offset += 9;
        if (packed & 128) offset += 3 * (2 ** ((packed & 7) + 1));
        if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) fail("INVALID_IMAGE");
        offset++; subblocks(); hasImage = true;
      } else fail("INVALID_IMAGE");
    }
    if (!hasImage || !ended) fail("INVALID_IMAGE");
    return { mimeType: "image/gif", extension: "gif" };
  }
  if (bytes.length >= 25 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) fail("INVALID_IMAGE");
    let offset = 12, hasImage = false;
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + length > bytes.length) fail("INVALID_IMAGE");
      const data = offset + 8;
      if (type === "VP8 ") {
        if (length < 10 || !bytes.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) fail("INVALID_IMAGE");
        dimensions(bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff); hasImage = true;
      } else if (type === "VP8L") {
        if (length < 5 || bytes[data] !== 0x2f) fail("INVALID_IMAGE");
        const packed = bytes.readUInt32LE(data + 1);
        if (packed >>> 29 !== 0) fail("INVALID_IMAGE");
        dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1); hasImage = true;
      } else if (type === "VP8X") {
        if (length !== 10) fail("INVALID_IMAGE");
        dimensions(bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1);
      }
      offset += 8 + length + (length % 2);
    }
    if (!hasImage || offset !== bytes.length) fail("INVALID_IMAGE");
    return { mimeType: "image/webp", extension: "webp" };
  }
  return fail("UNSUPPORTED_IMAGE");
}

function verifyDigest(value: string | undefined, actual: string, length: number) {
  if (value !== undefined && (typeof value !== "string" || !new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value)
    || !timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(actual, "hex")))) fail("HASH_MISMATCH");
}

/** Download only the original image. No bot token, signed URL or key is returned or logged. */
export async function downloadIlinkImage(item: ILinkImageItem, options: ILinkImageOptions = {}): Promise<ILinkDecodedImage> {
  if (item?.type !== 2 || !item.image_item?.media) return fail("NOT_IMAGE");
  const image = item.image_item, media = image.media!;
  const maxBytes = integer(options.maxBytes, ILINK_IMAGE_MAX_BYTES, 100 * 1024 * 1024);
  const timeoutMs = integer(options.timeoutMs, 30_000, 120_000);
  const key = ilinkImageAesKey(image);
  const url = downloadUrl(media, options.cdnBaseUrl ?? ILINK_CDN_BASE_URL);
  if (image.mid_size !== undefined && (!Number.isSafeInteger(image.mid_size) || image.mid_size < 0)) fail("SIZE_MISMATCH");
  if (image.mid_size && image.mid_size > maxBytes + (key ? 16 : 0)) fail("TOO_LARGE");
  if (options.expectedBytes !== undefined && (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes <= 0 || options.expectedBytes > maxBytes)) fail("SIZE_MISMATCH");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    if (signal.aborted) throw abortError(signal);
    const response = await bounded((options.fetchImpl ?? fetch)(url.href, {
      method: "GET", redirect: "error", credentials: "omit", signal,
      headers: { accept: "application/octet-stream,image/*", "accept-encoding": "identity" },
    }), signal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new ILinkMediaError("ILINK_MEDIA_HTTP_ERROR", response.status);
    }
    const wire = await readBounded(response, maxBytes + (key ? 16 : 0), signal);
    if (image.mid_size && wire.length !== image.mid_size) fail("SIZE_MISMATCH");
    let buffer = wire;
    if (key) {
      if (wire.length % 16 !== 0) fail("INVALID_CIPHERTEXT");
      try {
        // Node's default auto-padding validates and removes PKCS#7, including a full padding block.
        const decipher = createDecipheriv("aes-128-ecb", key, null);
        buffer = Buffer.concat([decipher.update(wire), decipher.final()]);
      } catch { fail("DECRYPT_FAILED"); }
    }
    if (buffer.length > maxBytes) fail("TOO_LARGE");
    if (options.expectedBytes !== undefined && buffer.length !== options.expectedBytes) fail("SIZE_MISMATCH");
    const format = imageFormat(buffer);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const md5 = createHash("md5").update(buffer).digest("hex");
    verifyDigest(options.expectedSha256, sha256, 64);
    verifyDigest(options.expectedMd5, md5, 32);
    return { buffer, mimeType: format.mimeType, filename: `weixin-image-${sha256}.${format.extension}`,
      bytes: buffer.length, sha256, md5, encrypted: key !== null };
  } catch (error) {
    if (error instanceof ILinkMediaError) throw error;
    if (signal.aborted) throw abortError(signal);
    throw new ILinkMediaError("ILINK_MEDIA_DOWNLOAD_FAILED");
  } finally { key?.fill(0); }
}
