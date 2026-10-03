import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { downloadFeishuImage, persistFeishuImage } from "./feishu-inbound.js";
import { MAX_INBOUND_IMAGE_BYTES, readInboundImage } from "./inbound-media.js";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJZkAAAAASUVORK5CYII=","base64");
const directories: string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>fs.rm(directory,{recursive:true,force:true})));});
function apiFor(stream: Readable) {return {im:{messageResource:{get:vi.fn(async()=>({getReadableStream:()=>stream}))}}} as any;}
test("SDK downloads the attached resource by message ID, bounds bytes, and preserves the image hash",async()=>{
  const api=apiFor(Readable.from([png.subarray(0,15),png.subarray(15)]));
  const buffer=await downloadFeishuImage(api,"message-id","image-key");
  expect(buffer.equals(png)).toBe(true);
  expect(api.im.messageResource.get).toHaveBeenCalledWith({path:{message_id:"message-id",file_key:"image-key"},params:{type:"image"}});
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"feishu-inbound-test-"));directories.push(directory);
  const receipt=await persistFeishuImage(directory,"tenant","message-id",buffer);
  expect(receipt.sha256).toBe(createHash("sha256").update(buffer).digest("hex"));
  expect(receipt.storagePath).toMatch(/^inbound\/tenant\/[a-f0-9]{64}\/[a-f0-9]{64}\.png$/);
  expect(readInboundImage(directory,"tenant",receipt).buffer.equals(png)).toBe(true);
  expect((await fs.stat(path.join(directory,receipt.storagePath))).mode & 0o777).toBe(0o600);
  expect(await persistFeishuImage(directory,"tenant","message-id",png)).toEqual(receipt);
});
test("stream size, invalid image and stalled responses fail without raw SDK details",async()=>{
  await expect(downloadFeishuImage(apiFor(Readable.from([png,Buffer.alloc(MAX_INBOUND_IMAGE_BYTES)])),"m","k")).rejects.toThrow("FEISHU_IMAGE_TOO_LARGE");
  await expect(downloadFeishuImage(apiFor(Readable.from([Buffer.from("<svg/>")])),"m","k")).rejects.toThrow("FEISHU_IMAGE_FORMAT_UNSUPPORTED");
  const stream=new Readable({read(){}});
  await expect(downloadFeishuImage(apiFor(stream),"m","k",10)).rejects.toThrow("FEISHU_IMAGE_DOWNLOAD_TIMEOUT");
  expect(stream.destroyed).toBe(true);
  const api={im:{messageResource:{get:async()=>{throw Error("token=PRIVATE,response=BODY");}}}} as any;
  await expect(downloadFeishuImage(api,"m","k")).rejects.toThrow("FEISHU_IMAGE_DOWNLOAD_FAILED");
});
test("late SDK resource stream is destroyed after the request deadline",async()=>{
  let resolve!: (value:any)=>void;
  const pending=new Promise(resolveCallback=>{resolve=resolveCallback;});
  const api={im:{messageResource:{get:()=>pending}}} as any;
  await expect(downloadFeishuImage(api,"m","k",10)).rejects.toThrow("FEISHU_IMAGE_DOWNLOAD_TIMEOUT");
  const stream=new Readable({read(){}});resolve({getReadableStream:()=>stream});
  await new Promise(resolve=>setTimeout(resolve,5));expect(stream.destroyed).toBe(true);
});
test("durable inbound storage refuses a symlink outside the private tenant folder",async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"feishu-inbound-test-"));directories.push(directory);
  await fs.mkdir(path.join(directory,"target"));await fs.symlink(path.join(directory,"target"),path.join(directory,"inbound"));
  await expect(persistFeishuImage(directory,"tenant","message",png)).rejects.toThrow("FEISHU_INBOUND_DIRECTORY_INVALID");
  expect(await fs.readdir(path.join(directory,"target"))).toEqual([]);
});
