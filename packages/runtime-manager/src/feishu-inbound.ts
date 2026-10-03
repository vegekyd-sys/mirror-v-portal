import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import type * as lark from "@larksuiteoapi/node-sdk";
import { imageMime } from "./feishu-media.js";
import { IMAGE_EXTENSIONS, MAX_INBOUND_IMAGE_BYTES, normalizeInboundAttachments, type InboundAttachment } from "./inbound-media.js";

/** Read only the resource attached to this message; never fetch an arbitrary user URL. */
export async function downloadFeishuImage(api: lark.Client, messageId: string, imageKey: string, timeoutMs = 30_000): Promise<Buffer> {
  if (!messageId || typeof imageKey !== "string" || !imageKey || imageKey.length > 1024) throw Error("FEISHU_IMAGE_RESOURCE_INVALID");
  let stream: Readable | undefined, expired = false, timer: NodeJS.Timeout | undefined;
  const pending = api.im.messageResource.get({path:{message_id:messageId,file_key:imageKey},params:{type:"image"}});
  // The SDK does not expose AbortSignal here. A late response is destroyed, never kept in memory.
  void pending.then(response => {if (expired) response.getReadableStream().destroy();},()=>{}).catch(()=>{});
  try {
    return await Promise.race([
      (async() => {
        const response = await pending;
        if (expired) throw Error("FEISHU_IMAGE_DOWNLOAD_TIMEOUT");
        stream = response.getReadableStream();
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_INBOUND_IMAGE_BYTES) throw Error("FEISHU_IMAGE_TOO_LARGE");
          chunks.push(buffer);
        }
        if (!bytes) throw Error("FEISHU_IMAGE_EMPTY");
        const result = Buffer.concat(chunks,bytes);
        if (!imageMime(result)) throw Error("FEISHU_IMAGE_FORMAT_UNSUPPORTED");
        return result;
      })(),
      new Promise<never>((_,reject) => {timer=setTimeout(()=>{expired=true;stream?.destroy();reject(Error("FEISHU_IMAGE_DOWNLOAD_TIMEOUT"));},timeoutMs);}),
    ]);
  } catch (error: any) {
    stream?.destroy();
    throw Error(/^FEISHU_[A-Z0-9_]+$/.test(error?.message) ? error.message : "FEISHU_IMAGE_DOWNLOAD_FAILED");
  } finally {if (timer) clearTimeout(timer);}
}

export async function persistFeishuImage(dataDir: string, tenantId: string, messageId: string, buffer: Buffer): Promise<InboundAttachment> {
  const mimeType = imageMime(buffer);
  if (!mimeType || !buffer.length || buffer.length > MAX_INBOUND_IMAGE_BYTES) throw Error("FEISHU_IMAGE_RESOURCE_INVALID");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const messageHash = createHash("sha256").update(messageId).digest("hex");
  const storagePath = `inbound/${tenantId}/${messageHash}/${sha256}.${IMAGE_EXTENSIONS[mimeType]}`;
  const [attachment] = normalizeInboundAttachments([{kind:"image",mimeType,storagePath,sha256,bytes:buffer.length,filename:`${sha256}.${IMAGE_EXTENSIONS[mimeType]}`}],tenantId);
  let directory = await fs.realpath(dataDir);
  for (const segment of storagePath.split("/").slice(0,-1)) {
    directory = path.join(directory,segment);
    await fs.mkdir(directory,{mode:0o700}).catch((error: NodeJS.ErrnoException) => {if (error.code !== "EEXIST") throw error;});
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("FEISHU_INBOUND_DIRECTORY_INVALID");
    await fs.chmod(directory,0o700);
  }
  const filename = path.join(directory,path.basename(storagePath));
  const temporary = path.join(directory,`.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary,"wx",0o600);
    try {await handle.writeFile(buffer);await handle.sync();} finally {await handle.close();}
    await fs.link(temporary,filename).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      const previous = await fs.open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await previous.stat();
        if (!stat.isFile() || stat.size !== buffer.length || createHash("sha256").update(await previous.readFile()).digest("hex") !== sha256) throw Error("FEISHU_INBOUND_SOURCE_CONFLICT");
      } finally {await previous.close();}
    });
    const directoryHandle = await fs.open(directory,"r");
    try {await directoryHandle.sync();} finally {await directoryHandle.close();}
  } finally {await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {if (error.code !== "ENOENT") throw error;});}
  return attachment;
}
