import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type ImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export type VideoMime = "video/mp4" | "video/quicktime" | "video/webm";
export type InboundMime = ImageMime | VideoMime;
/** Durable, credential-free receipt. storagePath is relative to controller dataDir. */
export interface InboundAttachment {
  kind: "image" | "video";
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
  kind?: "video";
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
export const VIDEO_EXTENSIONS: Record<VideoMime,string> = {"video/mp4":"mp4","video/quicktime":"mov","video/webm":"webm"};
export const IMAGE_EXTENSIONS: Record<ImageMime, string> = {"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"};

export const INBOUND_EXTENSIONS: Record<InboundMime,string> = {...IMAGE_EXTENSIONS,...VIDEO_EXTENSIONS};

export function normalizeInboundAttachments(input: unknown, tenantId: string): InboundAttachment[] {
  if (!Array.isArray(input) || input.length > MAX_INBOUND_IMAGES) throw Error("INVALID_INBOUND_ATTACHMENTS");
  if (!input.length) return [];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tenantId)) throw Error("INVALID_INBOUND_TENANT_ID");
  let total = 0, imageTotal = 0;
  return input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some(key => !["kind","mimeType","storagePath","sha256","bytes","filename"].includes(key))) throw Error("INVALID_INBOUND_ATTACHMENT");
    const {kind,mimeType,storagePath,sha256,bytes,filename} = item;
    if (!["image","video"].includes(kind) || typeof mimeType !== "string" || !(kind === "image" ? Object.hasOwn(IMAGE_EXTENSIONS,mimeType) : Object.hasOwn(VIDEO_EXTENSIONS,mimeType)) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > (kind === "image" ? MAX_INBOUND_IMAGE_BYTES : MAX_INBOUND_VIDEO_BYTES)) throw Error("INVALID_INBOUND_ATTACHMENT");
    if (typeof storagePath !== "string" || storagePath.includes("\\") || path.posix.isAbsolute(storagePath) ||
      storagePath.split("/").some((part:string) => !part || part === "." || part === "..") ||
      !storagePath.startsWith(`inbound/${tenantId}/`) || storagePath.split("/").length !== 4 || !/^[a-f0-9]{64}$/.test(storagePath.split("/")[2]) ||
      !new RegExp(`/${sha256}\\.(?:${mimeType === "image/jpeg" ? "jpe?g" : INBOUND_EXTENSIONS[mimeType as InboundMime]})$`).test(storagePath)) throw Error("INBOUND_ATTACHMENT_PATH_INVALID");
    if (filename !== undefined && (typeof filename !== "string" || !filename || filename.length > 200 || /[\x00-\x1f/\\]/.test(filename))) throw Error("INVALID_INBOUND_FILENAME");
    total += bytes;
    if (kind === "image") imageTotal += bytes;
    if (imageTotal > MAX_INBOUND_TOTAL_BYTES || total > MAX_INBOUND_VIDEO_BYTES) throw Error("INBOUND_ATTACHMENTS_TOO_LARGE");
    return {kind,mimeType:mimeType as InboundMime,storagePath,sha256,bytes,...(filename ? {filename} : {})};
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
  if (!stat.isFile() || stat.size !== attachment.bytes || stat.size > (attachment.kind === "image" ? MAX_INBOUND_IMAGE_BYTES : MAX_INBOUND_VIDEO_BYTES)) throw Error("INBOUND_ATTACHMENT_SIZE_MISMATCH");
  const buffer = fs.readFileSync(filename);
  if (createHash("sha256").update(buffer).digest("hex") !== attachment.sha256) throw Error("INBOUND_ATTACHMENT_CHECKSUM_MISMATCH");
  return {image:{...(attachment.kind === "video" ? {kind:"video" as const} : {}),path:`/vercel/sandbox/agent-data/workspace/inbound/${attachment.sha256}.${INBOUND_EXTENSIONS[attachment.mimeType]}`,mimeType:attachment.mimeType,sha256:attachment.sha256,bytes:attachment.bytes},buffer};
}
