import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type ImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export type VideoMime = "video/mp4" | "video/quicktime" | "video/webm";
/** Documents the owner sends as Feishu files; the agent reads them from the workspace. */
export type FileMime = keyof typeof FILE_EXTENSIONS;
/** Feishu voice messages are Opus in an Ogg container. */
export type AudioMime = "audio/ogg";
export type InboundMime = ImageMime | VideoMime | FileMime | AudioMime;
/** Durable, credential-free receipt. storagePath is relative to controller dataDir. */
export interface InboundAttachment {
  kind: InboundKind;
  mimeType: InboundMime;
  storagePath: string;
  sha256: string;
  bytes: number;
  filename?: string;
}
export class InboundMediaError extends Error {
  readonly noModelRequest = true;
}
// Legacy name retained for the existing image transport. Video files use kind=video.
export interface SandboxImage {
  kind?: "video" | "file" | "audio";
  /** The name the owner sent a file under (documents only). */
  filename?: string;
  path: string;
  mimeType: InboundMime;
  sha256: string;
  bytes: number;
}
export const MAX_INBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
// Base64 plus message/instructions stays below OpenClaw's 20 MiB HTTP-body limit.
export const MAX_INBOUND_TOTAL_BYTES = 12 * 1024 * 1024;
export const MAX_INBOUND_IMAGES = 4;
export const MAX_INBOUND_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_INBOUND_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_INBOUND_AUDIO_BYTES = 25 * 1024 * 1024;
export type InboundKind = "image" | "video" | "file" | "audio";
// One extension per type: the stored name is <sha256>.<extension>, the original name rides along.
export const FILE_EXTENSIONS = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "application/zip": "zip",
} as const;
export const AUDIO_EXTENSIONS: Record<AudioMime, string> = {"audio/ogg": "opus"};
/** File type from the name the owner sent it under, or undefined when the sandbox does not take it. */
export function fileMimeFromName(name: string): FileMime | undefined {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  return (Object.keys(FILE_EXTENSIONS) as FileMime[]).find((mime) => FILE_EXTENSIONS[mime] === ext);
}
export const VIDEO_EXTENSIONS: Record<VideoMime,string> = {"video/mp4":"mp4","video/quicktime":"mov","video/webm":"webm"};
export const IMAGE_EXTENSIONS: Record<ImageMime, string> = {"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"};

export const INBOUND_EXTENSIONS: Record<InboundMime,string> = {...IMAGE_EXTENSIONS,...VIDEO_EXTENSIONS,...FILE_EXTENSIONS,...AUDIO_EXTENSIONS};
const KIND_TYPES: Record<InboundKind, Record<string, string>> = {image: IMAGE_EXTENSIONS, video: VIDEO_EXTENSIONS, file: FILE_EXTENSIONS, audio: AUDIO_EXTENSIONS};
export const MAX_KIND_BYTES: Record<InboundKind, number> = {image: MAX_INBOUND_IMAGE_BYTES, video: MAX_INBOUND_VIDEO_BYTES, file: MAX_INBOUND_FILE_BYTES, audio: MAX_INBOUND_AUDIO_BYTES};

export function normalizeInboundAttachments(input: unknown, tenantId: string): InboundAttachment[] {
  if (!Array.isArray(input) || input.length > MAX_INBOUND_IMAGES) throw Error("INVALID_INBOUND_ATTACHMENTS");
  if (!input.length) return [];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tenantId)) throw Error("INVALID_INBOUND_TENANT_ID");
  let total = 0, imageTotal = 0;
  return input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some(key => !["kind","mimeType","storagePath","sha256","bytes","filename"].includes(key))) throw Error("INVALID_INBOUND_ATTACHMENT");
    const {kind,mimeType,storagePath,sha256,bytes,filename} = item;
    if (!Object.hasOwn(KIND_TYPES,kind) || typeof mimeType !== "string" || !Object.hasOwn(KIND_TYPES[kind as InboundKind],mimeType) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_KIND_BYTES[kind as InboundKind]) throw Error("INVALID_INBOUND_ATTACHMENT");
    if (typeof storagePath !== "string" || storagePath.includes("\\") || path.posix.isAbsolute(storagePath) ||
      storagePath.split("/").some((part:string) => !part || part === "." || part === "..") ||
      !storagePath.startsWith(`inbound/${tenantId}/`) || storagePath.split("/").length !== 4 || !/^[a-f0-9]{64}$/.test(storagePath.split("/")[2]) ||
      !new RegExp(`/${sha256}\\.(?:${mimeType === "image/jpeg" ? "jpe?g" : INBOUND_EXTENSIONS[mimeType as InboundMime]})$`).test(storagePath)) throw Error("INBOUND_ATTACHMENT_PATH_INVALID");
    if (filename !== undefined && (typeof filename !== "string" || !filename || filename.length > 200 || /[\x00-\x1f/\\]/.test(filename))) throw Error("INVALID_INBOUND_FILENAME");
    total += bytes;
    if (kind === "image") imageTotal += bytes;
    if (imageTotal > MAX_INBOUND_TOTAL_BYTES || total > MAX_INBOUND_VIDEO_BYTES) throw Error("INBOUND_ATTACHMENTS_TOO_LARGE");
    return {kind:kind as InboundKind,mimeType:mimeType as InboundMime,storagePath,sha256,bytes,...(filename ? {filename} : {})};
  });
}

export function readInboundImage(dataDir: string, tenantId: string, input: InboundAttachment): { image: SandboxImage; buffer: Buffer } {
  const [attachment] = normalizeInboundAttachments([input],tenantId);
  const root = fs.realpathSync(dataDir);
  const filename = path.join(root,attachment.storagePath);
  // Check all path components, not only the final file. Never follow a link to private controller data.
  let cursor = root;
  for (const segment of attachment.storagePath.split("/")) {
    cursor = path.join(cursor,segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw Error("INBOUND_ATTACHMENT_SYMLINK_FORBIDDEN");
  }
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size !== attachment.bytes || stat.size > MAX_KIND_BYTES[attachment.kind]) throw Error("INBOUND_ATTACHMENT_SIZE_MISMATCH");
  const buffer = fs.readFileSync(filename);
  if (createHash("sha256").update(buffer).digest("hex") !== attachment.sha256) throw Error("INBOUND_ATTACHMENT_CHECKSUM_MISMATCH");
  return {image:{...(attachment.kind === "image" ? {} : {kind:attachment.kind}),...(attachment.kind === "file" && attachment.filename ? {filename:attachment.filename} : {}),path:`/vercel/sandbox/agent-data/workspace/inbound/${attachment.sha256}.${INBOUND_EXTENSIONS[attachment.mimeType]}`,mimeType:attachment.mimeType,sha256:attachment.sha256,bytes:attachment.bytes},buffer};
}
