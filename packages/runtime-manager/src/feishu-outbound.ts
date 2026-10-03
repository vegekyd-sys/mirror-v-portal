import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { MediaFile } from "./provider.js";
import { MAX_FEISHU_FILE_BYTES, safeMediaFilename, type PreparedFeishuMedia } from "./feishu-media.js";

interface BlobReceipt {sha256: string;bytes: number}
export interface FeishuOutboundFile extends BlobReceipt {
  id: string;
  ref: string;
  kind: MediaFile["kind"];
  filename: string;
  prepared?: BlobReceipt & {filename: string;msgType: PreparedFeishuMedia["msgType"];fileType?: PreparedFeishuMedia["fileType"];duration?: number;cover?: BlobReceipt};
  uploadKey?: string;
  coverKey?: string;
  messageId?: string;
  sent?: boolean;
}
export interface FeishuOutboundManifest {
  version: 1;
  tenantId: string;
  runId: string;
  files: FeishuOutboundFile[];
  textDelivered?: boolean;
}
const MAX_FILES = 20, MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
function validId(value: string) {if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw Error("FEISHU_OUTBOUND_ID_INVALID");}
function validBlob(value: any) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_FEISHU_FILE_BYTES) throw Error("FEISHU_OUTBOUND_RECEIPT_INVALID");
}
function validate(manifest: FeishuOutboundManifest, tenantId: string, runId: string) {
  if (manifest?.version !== 1 || manifest.tenantId !== tenantId || manifest.runId !== runId || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) throw Error("FEISHU_OUTBOUND_MANIFEST_INVALID");
  let total = 0;
  const ids = new Set<string>();
  for (const file of manifest.files) {
    validBlob(file);
    if (!/^[a-f0-9]{64}$/.test(file.id) || ids.has(file.id) || typeof file.ref !== "string" || file.ref.length > 8000 || !["image","video","audio","file"].includes(file.kind) || typeof file.filename !== "string") throw Error("FEISHU_OUTBOUND_MANIFEST_INVALID");
    ids.add(file.id);
    total += file.bytes;
    if (file.prepared) {
      validBlob(file.prepared);
      if (!["image","media","audio","file"].includes(file.prepared.msgType) || typeof file.prepared.filename !== "string" || (file.prepared.fileType !== undefined && !["mp4","opus","stream"].includes(file.prepared.fileType))) throw Error("FEISHU_OUTBOUND_MANIFEST_INVALID");
      if (file.prepared.duration !== undefined && (!Number.isSafeInteger(file.prepared.duration) || file.prepared.duration <= 0)) throw Error("FEISHU_OUTBOUND_MANIFEST_INVALID");
      if (file.prepared.cover) validBlob(file.prepared.cover);
    }
    for (const key of [file.uploadKey,file.coverKey,file.messageId]) if (key !== undefined && (typeof key !== "string" || !key || key.length > 1024)) throw Error("FEISHU_OUTBOUND_MANIFEST_INVALID");
    if ((file.sent !== undefined && typeof file.sent !== "boolean") || (file.sent && !file.uploadKey)) throw Error("FEISHU_OUTBOUND_MANIFEST_INVALID");
  }
  if (total > MAX_TOTAL_BYTES || (manifest.textDelivered !== undefined && typeof manifest.textDelivered !== "boolean")) throw Error("FEISHU_OUTBOUND_MANIFEST_INVALID");
}
/** Private, immutable source files plus atomic receipts survive controller restarts and VM sleep. */
export class FeishuOutboundVault {
  constructor(readonly dataDir: string) {}
  private async directory(tenantId: string, runId: string, create = false) {
    validId(tenantId);validId(runId);
    let cursor = await fs.realpath(this.dataDir);
    for (const part of ["outbound",tenantId,runId]) {
      cursor = path.join(cursor,part);
      if (create) await fs.mkdir(cursor,{mode:0o700}).catch((error: NodeJS.ErrnoException) => {if (error.code !== "EEXIST") throw error;});
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("FEISHU_OUTBOUND_DIRECTORY_INVALID");
      if (create) await fs.chmod(cursor,0o700);
    }
    return cursor;
  }
  private async syncDirectory(directory: string) {
    const handle = await fs.open(directory,"r");
    try {await handle.sync();} finally {await handle.close();}
  }
  async load(tenantId: string, runId: string): Promise<FeishuOutboundManifest | undefined> {
    let directory: string;
    try {directory = await this.directory(tenantId,runId);} catch (error: any) {if (error.code === "ENOENT") return; throw error;}
    const filename = path.join(directory,"manifest.json");
    let handle;
    try {handle = await fs.open(filename,constants.O_RDONLY | constants.O_NOFOLLOW);} catch (error: any) {if (error.code === "ENOENT") return; throw error;}
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw Error("FEISHU_OUTBOUND_MANIFEST_INVALID");
      let manifest: FeishuOutboundManifest;
      try {manifest = JSON.parse(await handle.readFile("utf8"));} catch {throw Error("FEISHU_OUTBOUND_MANIFEST_INVALID");}
      validate(manifest,tenantId,runId);
      return manifest;
    } finally {await handle.close();}
  }
  async save(manifest: FeishuOutboundManifest) {
    validate(manifest,manifest.tenantId,manifest.runId);
    const directory = await this.directory(manifest.tenantId,manifest.runId,true);
    const temporary = path.join(directory,`.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary,"wx",0o600);
      try {await handle.writeFile(JSON.stringify(manifest));await handle.sync();} finally {await handle.close();}
      await fs.rename(temporary,path.join(directory,"manifest.json"));
      await this.syncDirectory(directory);
    } finally {await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {if (error.code !== "ENOENT") throw error;});}
  }
  async writeBlob(tenantId: string, runId: string, buffer: Buffer): Promise<BlobReceipt> {
    const receipt = {sha256:sha(buffer),bytes:buffer.length};
    validBlob(receipt);
    const directory = await this.directory(tenantId,runId,true);
    const filename = path.join(directory,`${receipt.sha256}.bin`), temporary = path.join(directory,`.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary,"wx",0o600);
      try {await handle.writeFile(buffer);await handle.sync();} finally {await handle.close();}
      await fs.link(temporary,filename).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        await this.readBlob(tenantId,runId,receipt);
      });
      await this.syncDirectory(directory);
    } finally {await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {if (error.code !== "ENOENT") throw error;});}
    return receipt;
  }
  async readBlob(tenantId: string, runId: string, receipt: BlobReceipt) {
    validBlob(receipt);
    const directory = await this.directory(tenantId,runId);
    const handle = await fs.open(path.join(directory,`${receipt.sha256}.bin`),constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== receipt.bytes) throw Error("FEISHU_OUTBOUND_CHECKSUM_MISMATCH");
      const buffer = await handle.readFile();
      if (sha(buffer) !== receipt.sha256) throw Error("FEISHU_OUTBOUND_CHECKSUM_MISMATCH");
      return buffer;
    } finally {await handle.close();}
  }
  async stage(tenantId: string, runId: string, files: MediaFile[]) {
    if (files.length > MAX_FILES || files.reduce((sum,file) => sum + file.buffer.length,0) > MAX_TOTAL_BYTES) throw Error("FEISHU_OUTBOUND_TOO_LARGE");
    const entries = files.map(file => {
      const sha256 = sha(file.buffer);
      return {id:createHash("sha256").update(`${file.ref}\0${sha256}`).digest("hex"),ref:file.ref,kind:file.kind,filename:safeMediaFilename(file.ref),sha256,bytes:file.buffer.length};
    });
    const unique = [...new Map(entries.map(file => [file.id,file])).values()];
    const candidate: FeishuOutboundManifest = {version:1,tenantId,runId,files:unique};
    validate(candidate,tenantId,runId);
    const previous = await this.load(tenantId,runId);
    if (previous) {
      if (JSON.stringify(previous.files.map(file => file.id)) !== JSON.stringify(unique.map(file => file.id))) throw Error("FEISHU_OUTBOUND_SOURCE_CONFLICT");
      for (const file of previous.files) await this.readBlob(tenantId,runId,file);
      return;
    }
    for (const file of files) await this.writeBlob(tenantId,runId,file.buffer);
    await this.save(candidate);
  }
  async prepared(manifest: FeishuOutboundManifest, file: FeishuOutboundFile, prepared: PreparedFeishuMedia) {
    const blob = await this.writeBlob(manifest.tenantId,manifest.runId,prepared.buffer);
    file.prepared = {...blob,filename:prepared.filename,msgType:prepared.msgType,...(prepared.fileType ? {fileType:prepared.fileType} : {}),...(prepared.duration ? {duration:prepared.duration} : {}),...(prepared.cover ? {cover:await this.writeBlob(manifest.tenantId,manifest.runId,prepared.cover)} : {})};
    await this.save(manifest);
  }
}
