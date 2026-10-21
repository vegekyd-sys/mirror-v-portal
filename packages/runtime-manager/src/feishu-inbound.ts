import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import type * as lark from "@larksuiteoapi/node-sdk";
import { imageMime } from "./feishu-media.js";
import { INBOUND_EXTENSIONS, MAX_INBOUND_IMAGE_BYTES, MAX_INBOUND_VIDEO_BYTES, type VideoMime, type InboundMime, normalizeInboundAttachments, type InboundAttachment } from "./inbound-media.js";

/** Feishu rich-text posts contain native text/image elements, not HTML. Read one locale only. */
export function parseFeishuContent(messageType: string, input: unknown): {text: string;imageKeys: string[]} {
  let content: any;
  try {content=typeof input === "string" ? JSON.parse(input) : input;} catch {content={};}
  if (messageType === "text") return {text:typeof content?.text === "string" ? content.text : "",imageKeys:[]};
  if (messageType === "image") return {text:"",imageKeys:typeof content?.image_key === "string" && content.image_key ? [content.image_key] : []};
  if (messageType !== "post") return {text:"",imageKeys:[]};
  let post = content;
  if (!Array.isArray(post?.content)) {
    const locale = ["zh_cn","en_us",...Object.keys(content || {}).filter(key=>/^[a-z]{2}_[a-z]{2}$/.test(key))]
      .find(key=>Array.isArray(content?.[key]?.content));
    post = locale ? content[locale] : {};
  }
  const imageKeys = new Set<string>(), lines: string[]=[];
  if (typeof post?.title === "string" && post.title.trim()) lines.push(post.title);
  for (const row of Array.isArray(post?.content) ? post.content : []) {
    if (!Array.isArray(row)) continue;
    const text: string[]=[];
    for (const element of row) {
      if (!element || typeof element !== "object") continue;
      if (element.tag === "img" && typeof element.image_key === "string" && element.image_key) imageKeys.add(element.image_key);
      else if (["text","a","at","code_block","md"].includes(element.tag) && typeof element.text === "string") text.push(element.text);
    }
    if (text.join("").trim()) lines.push(text.join(""));
  }
  return {text:lines.join("\n"),imageKeys:[...imageKeys]};
}

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
  return persistFeishuInbound(dataDir,tenantId,messageId,buffer,"image",mimeType);
}

async function persistFeishuInbound(dataDir: string, tenantId: string, messageId: string, buffer: Buffer, kind: "image" | "video", mimeType: InboundMime): Promise<InboundAttachment> {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const messageHash = createHash("sha256").update(messageId).digest("hex");
  const storagePath = `inbound/${tenantId}/${messageHash}/${sha256}.${INBOUND_EXTENSIONS[mimeType]}`;
  const [attachment] = normalizeInboundAttachments([{kind,mimeType,storagePath,sha256,bytes:buffer.length,filename:`${sha256}.${INBOUND_EXTENSIONS[mimeType]}`}],tenantId);
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


/** Native video and rich-post media use the file resource, never the thumbnail image. */
export function parseFeishuVideos(messageType: string,input: unknown): {fileKey:string}[] {
  let c:any;try{c=typeof input === "string" ? JSON.parse(input) : input;}catch{return [];}
  if(messageType === "media" || messageType === "file" && /\.(mp4|mov|m4v|webm)$/i.test(c?.file_name || ""))
    return [{fileKey:typeof c?.file_key === "string" ? c.file_key : ""}];
  if(messageType !== "post")return [];
  if(!Array.isArray(c?.content)){const locale=["zh_cn","en_us",...Object.keys(c||{}).filter(k=>/^[a-z]{2}_[a-z]{2}$/.test(k))].find(k=>Array.isArray(c?.[k]?.content));c=locale?c[locale]:{};}
  const keys=new Set<string>();
  for(const row of c?.content || [])if(Array.isArray(row))for(const e of row)if(e?.tag === "media" && typeof e.file_key === "string")keys.add(e.file_key);
  return [...keys].map(fileKey=>({fileKey}));
}
export function videoMime(buffer: Buffer): VideoMime | undefined {
  if(buffer.length>=12 && buffer.toString("ascii",4,8)==="ftyp")return buffer.toString("ascii",8,12)==="qt  " ? "video/quicktime" : "video/mp4";
  if(buffer.length>=4 && buffer.readUInt32BE(0)===0x1a45dfa3 && buffer.subarray(0,4096).includes(Buffer.from("webm")))return "video/webm";
}
export async function downloadFeishuVideo(api:lark.Client,messageId:string,fileKey:string,timeoutMs=60_000):Promise<Buffer>{
  if(!messageId || typeof fileKey!=="string" || !fileKey || fileKey.length>1024)throw Error("FEISHU_VIDEO_RESOURCE_INVALID");
  let stream:Readable|undefined,expired=false,timer:NodeJS.Timeout|undefined;
  const pending=api.im.messageResource.get({path:{message_id:messageId,file_key:fileKey},params:{type:"file"}});
  void pending.then(r=>{if(expired)r.getReadableStream().destroy();},()=>{}).catch(()=>{});
  try{return await Promise.race([(async()=>{const response=await pending;if(expired)throw Error("FEISHU_VIDEO_DOWNLOAD_TIMEOUT");stream=response.getReadableStream();const chunks:Buffer[]=[];let bytes=0;
    for await(const chunk of stream){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=b.length;if(bytes>MAX_INBOUND_VIDEO_BYTES)throw Error("FEISHU_VIDEO_TOO_LARGE");chunks.push(b);}
    const buffer=Buffer.concat(chunks,bytes);if(!videoMime(buffer))throw Error("FEISHU_VIDEO_FORMAT_UNSUPPORTED");return buffer;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;stream?.destroy();reject(Error("FEISHU_VIDEO_DOWNLOAD_TIMEOUT"));},timeoutMs);})]);
  }catch(e:any){stream?.destroy();throw Error(/^FEISHU_VIDEO_[A-Z_]+$/.test(e?.message)?e.message:"FEISHU_VIDEO_DOWNLOAD_FAILED");}finally{if(timer)clearTimeout(timer);}
}
export async function persistFeishuVideo(dataDir:string,tenantId:string,messageId:string,buffer:Buffer):Promise<InboundAttachment>{
  const mimeType=videoMime(buffer);if(!mimeType || buffer.length>MAX_INBOUND_VIDEO_BYTES)throw Error("FEISHU_VIDEO_RESOURCE_INVALID");
  return persistFeishuInbound(dataDir,tenantId,messageId,buffer,"video",mimeType);
}
