import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { FeishuOutboundVault } from "./feishu-outbound.js";

const directories: string[]=[];
async function fixture(){const directory=await fs.mkdtemp(path.join(os.tmpdir(),"feishu-outbox-test-"));directories.push(directory);return {directory,vault:new FeishuOutboundVault(directory)};}
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>fs.rm(directory,{recursive:true,force:true})));});
test("stage is durable, private, idempotent and retains sent receipts across a fresh vault",async()=>{
  const {directory,vault}=await fixture(), files=[{kind:"file" as const,ref:"/sandbox/result.txt",buffer:Buffer.from("final-result")}];
  await vault.stage("tenant","run",files);
  const manifest=(await vault.load("tenant","run"))!;
  manifest.files[0].uploadKey="file-key";manifest.files[0].sent=true;manifest.textDelivered=true;await vault.save(manifest);
  await vault.stage("tenant","run",files);
  const fresh=new FeishuOutboundVault(directory), restored=(await fresh.load("tenant","run"))!;
  expect(restored.files[0].sent).toBe(true);expect(restored.textDelivered).toBe(true);
  expect((await fresh.readBlob("tenant","run",restored.files[0])).toString()).toBe("final-result");
  expect((await fs.stat(path.join(directory,"outbound/tenant/run/manifest.json"))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(path.join(directory,"outbound/tenant/run"))).mode & 0o777).toBe(0o700);
  await expect(vault.stage("tenant","run",[{...files[0],buffer:Buffer.from("replacement")}])).rejects.toThrow("FEISHU_OUTBOUND_SOURCE_CONFLICT");
});
test("source and receipt checks reject changed bytes, path traversal and symlinks",async()=>{
  const {directory,vault}=await fixture();
  await expect(vault.stage("../other","run",[{kind:"file",ref:"f",buffer:Buffer.from("data")}])).rejects.toThrow("FEISHU_OUTBOUND_ID_INVALID");
  await vault.stage("tenant","run",[{kind:"file",ref:"f",buffer:Buffer.from("data")}]);
  const manifest=(await vault.load("tenant","run"))!, blob=path.join(directory,`outbound/tenant/run/${manifest.files[0].sha256}.bin`);
  await fs.writeFile(blob,"xxxx");await expect(vault.readBlob("tenant","run",manifest.files[0])).rejects.toThrow("FEISHU_OUTBOUND_CHECKSUM_MISMATCH");
  await fs.unlink(blob);await fs.symlink(path.join(directory,"outbound/tenant/run/manifest.json"),blob);
  await expect(vault.readBlob("tenant","run",manifest.files[0])).rejects.toThrow();
  await fs.mkdir(path.join(directory,"real"));await fs.symlink(path.join(directory,"real"),path.join(directory,"outbound/another"));
  await expect(vault.stage("another","run",[{kind:"file",ref:"f",buffer:Buffer.from("data")}])).rejects.toThrow("FEISHU_OUTBOUND_DIRECTORY_INVALID");
});
test("prepared bytes and cover are independently saved and checksum verified",async()=>{
  const {vault}=await fixture();await vault.stage("tenant","run",[{kind:"video",ref:"clip.mp4",buffer:Buffer.from("original")}]);
  const manifest=(await vault.load("tenant","run"))!;
  await vault.prepared(manifest,manifest.files[0],{buffer:Buffer.from("playable"),filename:"clip.mp4",msgType:"media",fileType:"mp4",duration:1500,cover:Buffer.from("cover")});
  const prepared=(await vault.load("tenant","run"))!.files[0].prepared!;
  expect((await vault.readBlob("tenant","run",prepared)).toString()).toBe("playable");
  expect((await vault.readBlob("tenant","run",prepared.cover!)).toString()).toBe("cover");
  expect(prepared.duration).toBe(1500);
});
