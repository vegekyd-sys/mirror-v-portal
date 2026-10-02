import { describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { downloadIlinkImage, ilinkImageAesKey, ILinkMediaError, ILINK_CDN_BASE_URL, type ILinkImageItem } from "./ilink-media.js";

// A real, deterministic 1x1 RGBA PNG. No provider, image generation or CDN request.
function crc(bytes: Buffer) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4), check = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
  length.writeUInt32BE(data.length); check.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, check]);
}
function png(aligned = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const prefix = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255])))]);
  const base = Buffer.concat([prefix, chunk("IEND")]);
  if (!aligned) return base;
  for (let count = 0; count < 16; count++) {
    const image = Buffer.concat([prefix, chunk("tEXt", Buffer.from("f\0" + "x".repeat(count))), chunk("IEND")]);
    if (image.length % 16 === 0) return image;
  }
  throw Error("fixture alignment");
}
const original = png();
// Generated once with local ffmpeg color=red:s=16x16, no external model.
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAFF/f//Z", "base64");
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], {stdio: "ignore"}).status === 0;
const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
function encrypted(plain = original, pad = true) {
  const cipher = createCipheriv("aes-128-ecb", key, null); cipher.setAutoPadding(pad);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
function item(aes_key: string = key.toString("base64")): ILinkImageItem {
  return { type: 2, image_item: { media: { encrypt_query_param: "opaque-fixture+/=", ...(aes_key ? { aes_key } : {}) } } };
}
function fetchBytes(bytes: Buffer, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(async () => new Response(new Uint8Array(bytes), { headers }));
}

describe("iLink original image download/decryption", () => {
  it("decrypts raw16 base64 with PKCS7 and returns a safe content-addressed PNG", async () => {
    const wire = encrypted(), fetchImpl = fetchBytes(wire, { "content-type": "application/octet-stream" });
    const incoming = item(); incoming.image_item!.mid_size = wire.length;
    const sha256 = createHash("sha256").update(original).digest("hex"), md5 = createHash("md5").update(original).digest("hex");
    const result = await downloadIlinkImage(incoming, { fetchImpl, expectedBytes: original.length, expectedSha256: sha256, expectedMd5: md5 });
    expect(result.buffer.equals(original)).toBe(true);
    expect(result).toMatchObject({ mimeType: "image/png", bytes: original.length, sha256, md5, encrypted: true, filename: `weixin-image-${sha256}.png` });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(ILINK_CDN_BASE_URL + "/download?encrypted_query_param=opaque-fixture%2B%2F%3D");
    expect(options).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    expect(JSON.stringify(options?.headers)).not.toMatch(/authorization|cookie|bot_token/i);
    expect(Object.keys(result).some(name => /key|url|query|token/i.test(name))).toBe(false);
  });
  it("accepts base64(hex32) and prefers the stable image_item.aeskey over a stale CDN key", async () => {
    for (const incoming of [item(Buffer.from(key.toString("hex")).toString("base64")), {
      ...item(Buffer.alloc(16, 255).toString("base64")), image_item: { ...item().image_item, aeskey: key.toString("hex"), media: item(Buffer.alloc(16, 255).toString("base64")).image_item!.media },
    }]) expect((await downloadIlinkImage(incoming, { fetchImpl: fetchBytes(encrypted()) })).buffer.equals(original)).toBe(true);
  });
  it("keeps a full padding block for block-aligned images and rejects invalid PKCS7", async () => {
    const aligned = png(true), wire = encrypted(aligned);
    expect(wire.length).toBe(aligned.length + 16);
    expect((await downloadIlinkImage(item(), { fetchImpl: fetchBytes(wire) })).buffer.equals(aligned)).toBe(true);
    const invalid = encrypted(Buffer.concat([aligned, Buffer.alloc(16)]), false);
    await expect(downloadIlinkImage(item(), { fetchImpl: fetchBytes(invalid) })).rejects.toMatchObject({ code: "ILINK_MEDIA_DECRYPT_FAILED" });
  });
  it("prefers a validated full_url even if no query is provided", async () => {
    const incoming: ILinkImageItem = { type: 2, image_item: { aeskey: key.toString("hex"), media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?fixture=opaque" } } };
    const fetchImpl = fetchBytes(encrypted());
    expect((await downloadIlinkImage(incoming, { fetchImpl })).buffer.equals(original)).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(incoming.image_item!.media!.full_url);
  });
  it("handles official unencrypted images and detects MIME from bytes instead of response headers", async () => {
    const result = await downloadIlinkImage(item(""), { fetchImpl: fetchBytes(original, { "content-type": "image/jpeg" }) });
    expect(result.mimeType).toBe("image/png"); expect(result.encrypted).toBe(false);
  });
  it("accepts actual JPEG, GIF and WebP fixtures", async () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    // Lossless 16x16 WebP generated once with the same local ffmpeg source.
    const webp = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvD8ADAAcQ9Y/+ByKi/wEA", "base64");
    for (const [bytes, mimeType] of [[jpeg, "image/jpeg"], [gif, "image/gif"], [webp, "image/webp"]] as const) {
      expect((await downloadIlinkImage(item(""), { fetchImpl: fetchBytes(bytes) })).mimeType).toBe(mimeType);
    }
  });
  it("rejects truncated/corrupt containers and non-image plaintext", async () => {
    const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
    const badGif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    badGif[badGif.length - 4] = 255; // A subblock claims bytes beyond the container.
    const badWebp = Buffer.from("UklGRhwAAABXRUJQVlA4TA8AAAAvD8ADAAcQ9Y/+ByKi/wEA", "base64");
    badWebp.writeUInt32LE(999, 16);
    const metadataOnlyWebp = Buffer.alloc(30);
    metadataOnlyWebp.write("RIFF"); metadataOnlyWebp.writeUInt32LE(22, 4); metadataOnlyWebp.write("WEBPVP8X", 8); metadataOnlyWebp.writeUInt32LE(10, 16);
    for (const bytes of [original.subarray(0, original.length - 5), corrupt, badGif, badWebp, metadataOnlyWebp, Buffer.from("<html>not an image</html>")]) {
      await expect(downloadIlinkImage(item(""), { fetchImpl: fetchBytes(bytes) })).rejects.toBeInstanceOf(ILinkMediaError);
    }
  });
  it("checks ciphertext alignment but treats mid_size as non-authoritative inbound metadata", async () => {
    await expect(downloadIlinkImage(item(), { fetchImpl: fetchBytes(encrypted().subarray(1)) })).rejects.toMatchObject({ code: "ILINK_MEDIA_INVALID_CIPHERTEXT" });
    for (const declared of [original.length, 0, -1, Number.MAX_SAFE_INTEGER, NaN, "untrusted-size"] as const) {
      const incoming = item(); incoming.image_item!.mid_size = declared as number;
      expect((await downloadIlinkImage(incoming, {fetchImpl: fetchBytes(encrypted()), maxBytes: original.length})).buffer.equals(original)).toBe(true);
    }
  });
  it.skipIf(!hasFfmpeg)("retains JPEG trailing bytes after a complete EOI that strict ffmpeg decodes", async () => {
    const withTrailer = Buffer.concat([jpeg, Buffer.from([0, 0])]);
    for (const bytes of [jpeg, withTrailer]) {
      const decode = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-err_detect", "explode", "-f", "image2pipe", "-i", "pipe:0", "-frames:v", "1", "-f", "null", "-"], {input: bytes, timeout: 5_000});
      expect(decode.status).toBe(0);
      const result = await downloadIlinkImage(item(), {fetchImpl: fetchBytes(encrypted(bytes))});
      expect(result.mimeType).toBe("image/jpeg"); expect(result.buffer.equals(bytes)).toBe(true);
      expect(result.bytes).toBe(bytes.length);
      expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
  it("rejects fake JPEG magic, missing EOI and an EOI hidden in a header segment", async () => {
    const falseEnd = Buffer.from(jpeg.subarray(0, jpeg.length - 2));
    falseEnd[12] = 0xff; falseEnd[13] = 0xd9; // JFIF payload is not an ending marker.
    for (const bytes of [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), jpeg.subarray(0, jpeg.length - 2), falseEnd, Buffer.concat([Buffer.from("not-jpeg"), jpeg])]) {
      await expect(downloadIlinkImage(item(""), {fetchImpl: fetchBytes(bytes)})).rejects.toBeInstanceOf(ILinkMediaError);
    }
  });
  it("exposes only allowlisted scalar diagnostics, never untrusted metadata or secrets", async () => {
    const incoming = item(); incoming.image_item!.mid_size = original.length;
    incoming.image_item!.media!.encrypt_query_param = "private-query";
    await expect(downloadIlinkImage(incoming, {fetchImpl: fetchBytes(encrypted()), expectedBytes: original.length + 1})).rejects.toMatchObject({
      code: "ILINK_MEDIA_SIZE_MISMATCH", details: {stage: "validate", httpStatus: 200, declaredMidSize: original.length, wireBytes: encrypted().length, plaintextBytes: original.length, formatHint: "png", keySource: "media_base64"},
    });
    const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
    await expect(downloadIlinkImage({...incoming, image_item: {...incoming.image_item, aeskey: key.toString("hex")}}, {fetchImpl: fetchBytes(encrypted(corrupt))})).rejects.toMatchObject({details: {stage: "container", formatHint: "png", keySource: "top_hex"}});
    const error = new ILinkMediaError("ILINK_MEDIA_DOWNLOAD_FAILED", 403, {stage: "fetch", declaredMidSize: "private-query", formatHint: "private-key", keySource: "private-token", url: "private-url", wireBytes: 80} as never);
    expect(error.details).toEqual({stage: "fetch", httpStatus: 403, wireBytes: 80});
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(JSON.stringify(error)).not.toMatch(/private-query|private-key|private-token|private-url/);
  });
  it("rejects mismatched trusted hashes and plaintext sizes", async () => {
    for (const options of [{ expectedSha256: "f".repeat(64) }, { expectedMd5: "f".repeat(32) }, { expectedSha256: "malformed" }]) {
      await expect(downloadIlinkImage(item(), { ...options, fetchImpl: fetchBytes(encrypted()) })).rejects.toMatchObject({ code: "ILINK_MEDIA_HASH_MISMATCH" });
    }
    await expect(downloadIlinkImage(item(), { expectedBytes: original.length + 1, fetchImpl: fetchBytes(encrypted()) })).rejects.toMatchObject({ code: "ILINK_MEDIA_SIZE_MISMATCH" });
  });
  it("rejects malformed/unsupported references and keys before any network request", async () => {
    const fetchImpl = fetchBytes(encrypted());
    for (const incoming of [
      { type: 1 }, { type: 2, image_item: { media: {} } }, item("invalid=key"),
      { ...item(), image_item: { ...item().image_item, aeskey: "not-a-key" } },
    ]) await expect(downloadIlinkImage(incoming, { fetchImpl })).rejects.toBeInstanceOf(ILinkMediaError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ilinkImageAesKey({ media: { aes_key: key.toString("base64").replace(/=+$/, "") } })?.equals(key)).toBe(true);
  });
  it("blocks non-CDN hosts, insecure URLs, credentials, ports and non-download paths without fetching", async () => {
    const fetchImpl = fetchBytes(encrypted());
    for (const full_url of [
      "http://novac2c.cdn.weixin.qq.com/c2c/download", "https://localhost/c2c/download",
      "https://novac2c.cdn.weixin.qq.com.attacker.test/c2c/download", "https://weixin.qq.com/c2c/download",
      "https://owner:secret@novac2c.cdn.weixin.qq.com/c2c/download", "https://novac2c.cdn.weixin.qq.com:8443/c2c/download",
      "https://novac2c.cdn.weixin.qq.com/c2c/upload", "https://novac2c.cdn.weixin.qq.com/c2c/download#secret",
    ]) await expect(downloadIlinkImage({ type: 2, image_item: { media: { full_url } } }, { fetchImpl })).rejects.toMatchObject({ code: "ILINK_MEDIA_INVALID_CDN_URL" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("bounds Content-Length and actual streaming bytes before buffering a whole response", async () => {
    await expect(downloadIlinkImage(item(), { maxBytes: 64, fetchImpl: fetchBytes(encrypted(), { "content-length": "99999999" }) })).rejects.toMatchObject({ code: "ILINK_MEDIA_TOO_LARGE" });
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(80)); controller.enqueue(new Uint8Array(1)); }, cancel });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(stream));
    await expect(downloadIlinkImage(item(), { maxBytes: 64, fetchImpl })).rejects.toMatchObject({ code: "ILINK_MEDIA_TOO_LARGE" });
    expect(cancel).toHaveBeenCalled();
    await expect(downloadIlinkImage(item(""), { maxBytes: 64, fetchImpl: fetchBytes(original) })).rejects.toMatchObject({ code: "ILINK_MEDIA_TOO_LARGE" });
  });
  it("does not leak signed URLs, keys or upstream response/error bodies", async () => {
    const incoming = item(); incoming.image_item!.media!.encrypt_query_param = "private-query";
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw Error("private-query " + key.toString("base64") + " owner-bot-token"); });
    let error: unknown;
    try { await downloadIlinkImage(incoming, { fetchImpl }); } catch (value) { error = value; }
    expect(String(error)).toBe("ILinkMediaError: ILINK_MEDIA_DOWNLOAD_FAILED");
    expect(JSON.stringify(error)).not.toMatch(/private-query|owner-bot-token|001122|novac2c/);
    await expect(downloadIlinkImage(item(), { fetchImpl: vi.fn<typeof fetch>(async () => new Response("private upstream body", { status: 403 })) }))
      .rejects.toMatchObject({ code: "ILINK_MEDIA_HTTP_ERROR", httpStatus: 403, message: "ILINK_MEDIA_HTTP_ERROR" });
  });
  it("bounds a hung fetch and a hung body read, and supports explicit cancellation", async () => {
    const hangingFetch = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(downloadIlinkImage(item(), { timeoutMs: 15, fetchImpl: hangingFetch })).rejects.toMatchObject({ code: "ILINK_MEDIA_TIMEOUT" });
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })));
    await expect(downloadIlinkImage(item(), { timeoutMs: 15, fetchImpl })).rejects.toMatchObject({ code: "ILINK_MEDIA_TIMEOUT" });
    expect(cancel).toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(downloadIlinkImage(item(), { signal: controller.signal, fetchImpl: hangingFetch })).rejects.toMatchObject({ code: "ILINK_MEDIA_ABORTED" });
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });
});
