import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { FeishuEdge } from "./feishu.js";
import { FeishuOutboundVault } from "./feishu-outbound.js";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJZkAAAAASUVORK5CYII=","base64");
const directories: string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>fs.rm(directory,{recursive:true,force:true})));});
async function fixture() {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"feishu-edge-test-"));directories.push(directory);
  const events:any[]=[], updates:any[]=[], runs=new Map<string,any>();
  const store:any={config:{dataDir:directory},event:vi.fn(async(...args:any[])=>events.push(args)),pool:{query:vi.fn(async(sql:string,args:any[])=>{
    if(sql.includes("request_key=$2")) return {rows:runs.has(args[1]) ? [runs.get(args[1])] : []};
    if(sql.startsWith("UPDATE elastic_runs")) updates.push({sql,args});
    return {rows:[]};
  })},enqueue:vi.fn(async(...args:any[])=>{
    const run={id:`run-${runs.size}`,tenant_id:args[0],request_key:args[1],session_key:args[2],text:args[3],channel:args[4],message_id:args[5],attachments:args[6],inherit_attachments:args[7]?.inheritAttachments ?? true,delivery:"pending",status:"succeeded",output:"成品已准备"};
    runs.set(args[1],run);return run;
  })};
  const api:any={im:{image:{create:vi.fn(async()=>({image_key:"image-uploaded"}))},file:{create:vi.fn(async()=>({code:0,data:{file_key:"file-uploaded"}}))},message:{reply:vi.fn(async()=>({code:0,data:{message_id:"sent"}})),create:vi.fn(async()=>({code:0,data:{message_id:"sent"}}))},messageResource:{get:vi.fn(async()=>({getReadableStream:()=>Readable.from([png])}))}}};
  const edge=new FeishuEdge(store);vi.spyOn(edge.typing,"start").mockImplementation(()=>{});
  const run:any={id:"run",tenant_id:"tenant",channel:"feishu",message_id:"parent",delivery:"pending",status:"succeeded",output:"成品已准备"};
  const tenant:any={id:"tenant"};
  return {directory,store,api,edge,run,tenant,events,updates,runs};
}
test("staging performs no network calls; a fresh edge sends native image and then marks delivery",async()=>{
  const f=await fixture();
  await f.edge.media(f.run,[{kind:"image",ref:"/workspace/output.png",buffer:png}]);
  expect(f.api.im.image.create).not.toHaveBeenCalled();expect(f.api.im.message.reply).not.toHaveBeenCalled();
  const fresh=new FeishuEdge(f.store);await fresh.deliver(f.run,f.api);
  expect(f.api.im.image.create.mock.calls[0][0].data.image.equals(png)).toBe(true);
  const imageCall=f.api.im.message.reply.mock.calls.find((args:any[])=>args[0].data.msg_type==="image")!;
  expect(JSON.parse(imageCall[0].data.content)).toEqual({image_key:"image-uploaded"});
  expect(f.updates).toHaveLength(1);expect(f.events.some(event=>event[1]==="feishu-media-sent")).toBe(true);
});
test("upload/send failure keeps delivery pending; restart retries only unfinished files using the same UUID",async()=>{
  const f=await fixture(), files=[{kind:"image" as const,ref:"first.png",buffer:png},{kind:"image" as const,ref:"second.png",buffer:Buffer.concat([png,Buffer.from("second")])}];
  await f.edge.media(f.run,files);
  let imageKey=0;f.api.im.image.create.mockImplementation(async()=>({code:0,data:{image_key:`image-${++imageKey}`}}));
  f.api.im.message.reply.mockImplementation(async(params:any)=>({code:JSON.parse(params.data.content).image_key==="image-2" ? 999 : 0,data:{message_id:"sent"}}));
  await expect(f.edge.deliver(f.run,f.api)).rejects.toThrow("FEISHU_MEDIA_SEND_999");
  expect(f.updates).toHaveLength(0);
  const vault=new FeishuOutboundVault(f.directory), manifest=(await vault.load("tenant","run"))!;
  expect(manifest.textDelivered).toBe(true);expect(manifest.files.map(file=>!!file.sent)).toEqual([true,false]);
  const failedUuid=f.api.im.message.reply.mock.calls.at(-1)[0].data.uuid;
  f.api.im.message.reply.mockResolvedValue({code:0,data:{message_id:"sent-2"}});
  await new FeishuEdge(f.store).deliver(f.run,f.api);
  expect(f.api.im.image.create).toHaveBeenCalledTimes(2);
  expect(f.api.im.message.reply.mock.calls.at(-1)[0].data.uuid).toBe(failedUuid);
  expect(f.api.im.message.reply.mock.calls.filter((args:any[])=>args[0].data.msg_type==="text")).toHaveLength(1);
  expect((await vault.load("tenant","run"))!.files.every(file=>file.sent)).toBe(true);expect(f.updates).toHaveLength(1);
});
test("one failed attachment does not suppress the other final artifacts",async()=>{
  const f=await fixture();await f.edge.media(f.run,[{kind:"image",ref:"fail.png",buffer:png},{kind:"file",ref:"result.txt",buffer:Buffer.from("final")}]);
  f.api.im.image.create.mockRejectedValue(Error("private API request token=secret"));
  await expect(f.edge.deliver(f.run,f.api)).rejects.toThrow("FEISHU_MEDIA_DELIVERY_FAILED");
  const manifest=(await new FeishuOutboundVault(f.directory).load("tenant","run"))!;
  expect(manifest.files.map(file=>!!file.sent)).toEqual([false,true]);expect(f.updates).toHaveLength(0);
  expect(f.api.im.message.reply.mock.calls.some((args:any[])=>args[0].data.msg_type==="file")).toBe(true);
  expect(JSON.stringify(f.events)).not.toContain("secret");
});
test("code zero without a message ID retains source and pending receipt, retrying delivery with the same UUID",async()=>{
  const f=await fixture();await f.edge.media(f.run,[{kind:"image",ref:"final.png",buffer:png}]);
  f.api.im.message.reply.mockImplementation(async(params:any)=>params.data.msg_type==="image" ? {code:0,data:{}} : {code:0,data:{message_id:"text-sent"}});
  await expect(f.edge.deliver(f.run,f.api)).rejects.toThrow("FEISHU_MEDIA_SEND_UNCONFIRMED");
  const vault=new FeishuOutboundVault(f.directory), before=(await vault.load("tenant","run"))!;
  expect(before.files[0].sent).toBeUndefined();expect(before.files[0].messageId).toBeUndefined();
  expect(before.files[0].uploadKey).toBe("image-uploaded");expect((await vault.readBlob("tenant","run",before.files[0])).equals(png)).toBe(true);
  expect(f.updates).toHaveLength(0);expect(f.events.some(event=>event[1]==="feishu-media-sent")).toBe(false);
  const uuid=f.api.im.message.reply.mock.calls.at(-1)[0].data.uuid;
  f.api.im.message.reply.mockResolvedValue({code:0,data:{message_id:"confirmed-image"}});
  await new FeishuEdge(f.store).deliver(f.run,f.api);
  expect(f.api.im.message.reply.mock.calls.at(-1)[0].data.uuid).toBe(uuid);expect(f.api.im.image.create).toHaveBeenCalledTimes(1);
  expect((await vault.load("tenant","run"))!.files[0].messageId).toBe("confirmed-image");expect(f.updates).toHaveLength(1);
});
test("a video receipt sends cover plus file_key as media, audio receipt uses audio, and schedule files target chat_id",async()=>{
  const f=await fixture();f.run.message_id=null;f.run.schedule_id="schedule";f.run.chat_id="chat";
  await f.edge.media(f.run,[{kind:"video",ref:"clip.mp4",buffer:Buffer.from("source-video")},{kind:"audio",ref:"music.wav",buffer:Buffer.from("source-audio")}]);
  const vault=new FeishuOutboundVault(f.directory), manifest=(await vault.load("tenant","run"))!;
  await vault.prepared(manifest,manifest.files[0],{buffer:Buffer.from("playable-mp4"),filename:"clip.mp4",msgType:"media",fileType:"mp4",duration:1500,cover:png});
  await vault.prepared(manifest,manifest.files[1],{buffer:Buffer.from("ogg-opus"),filename:"music.ogg",msgType:"audio",fileType:"opus",duration:1200});
  await f.edge.deliver(f.run,f.api);
  expect(f.api.im.file.create.mock.calls.map((args:any[])=>[args[0].data.file_type,args[0].data.duration])).toEqual([["mp4",1500],["opus",1200]]);
  const calls=f.api.im.message.create.mock.calls.map((args:any[])=>args[0]);
  expect(calls.map((params:any)=>params.data.msg_type)).toEqual(["text","media","audio"]);
  expect(JSON.parse(calls[1].data.content)).toEqual({file_key:"file-uploaded",image_key:"image-uploaded"});
  expect(calls.every((params:any)=>params.data.receive_id==="chat")).toBe(true);
});
test("image-only ingress enqueues a real typed attachment and duplicate message does not redownload",async()=>{
  const f=await fixture(), data={sender:{sender_type:"user"},message:{message_id:"incoming-image",chat_id:"chat",message_type:"image",content:JSON.stringify({image_key:"original-image"}),create_time:"123"}};
  const run=await f.edge.receive(f.tenant,f.api,data);
  expect(run?.attachments).toHaveLength(1);expect(run?.text).toContain("没有附带文字");
  expect((await fs.readFile(path.join(f.directory,run!.attachments![0].storagePath))).equals(png)).toBe(true);
  expect(f.store.enqueue.mock.calls[0][4]).toBe("feishu");
  await f.edge.receive(f.tenant,f.api,data);
  expect(f.api.im.messageResource.get).toHaveBeenCalledTimes(1);expect(f.store.enqueue).toHaveBeenCalledTimes(1);
  await f.edge.receive(f.tenant,f.api,{sender:{sender_type:"user"},message:{message_id:"caption",chat_id:"chat",message_type:"text",content:JSON.stringify({text:"改成海报"})}});
  expect(f.store.enqueue.mock.calls[1][3]).toBe("改成海报");expect(f.store.enqueue.mock.calls[1][7]).toEqual({});
});
test("failed image ingress creates an explicit inheritance barrier and logs no image key or SDK payload",async()=>{
  const f=await fixture();
  const data={sender:{sender_type:"user"},message:{message_id:"failed-image",chat_id:"chat",message_type:"image",content:JSON.stringify({image_key:"PRIVATE"})}};
  f.api.im.messageResource.get.mockImplementation(async()=>({getReadableStream:()=>Readable.from([Buffer.from("broken-image")])}));
  const run=await f.edge.receive(f.tenant,f.api,data);
  expect(run?.attachments).toEqual([]);expect(run?.inherit_attachments).toBe(false);expect(run?.text).toContain("本轮没有可用图片附件");
  expect(JSON.stringify(f.events)).not.toContain("PRIVATE");
  expect(f.api.im.messageResource.get).toHaveBeenCalledTimes(1);
});
test("post image plus text is a real creative request with resources read by the same message ID",async()=>{
  const f=await fixture();
  f.api.im.messageResource.get.mockImplementation(async(params:any)=>({getReadableStream:()=>Readable.from([params.path.file_key==="key-1" ? png : Buffer.concat([png,Buffer.from("other-image")])])}));
  const data={sender:{sender_type:"user"},message:{message_id:"post-message",chat_id:"chat",message_type:"post",content:JSON.stringify({title:"搞笑设计",content:[[{tag:"text",text:"用这两张图做一张海报"},{tag:"img",image_key:"key-1"}],[{tag:"img",image_key:"key-1"},{tag:"img",image_key:"key-2"}]]})}};
  const run=await f.edge.receive(f.tenant,f.api,data);
  expect(run?.text).toBe("搞笑设计\n用这两张图做一张海报");expect(run?.attachments).toHaveLength(2);
  expect(f.api.im.messageResource.get.mock.calls.map((args:any[])=>args[0])).toEqual(["key-1","key-2"].map(key=>({path:{message_id:"post-message",file_key:key},params:{type:"image"}})));
  for(const image of run!.attachments!)expect((await fs.readFile(path.join(f.directory,image.storagePath))).length).toBe(image.bytes);
  await f.edge.receive(f.tenant,f.api,data);expect(f.store.enqueue).toHaveBeenCalledTimes(1);expect(f.api.im.messageResource.get).toHaveBeenCalledTimes(2);
});
test("image-only locale post keeps acknowledgement policy; text-only post retains the caption without downloading",async()=>{
  const f=await fixture();
  const base={sender:{sender_type:"user"},message:{chat_id:"chat",message_type:"post"}};
  const image=await f.edge.receive(f.tenant,f.api,{...base,message:{...base.message,message_id:"post-image",content:JSON.stringify({zh_cn:{content:[[{tag:"img",image_key:"image-key"}]]}})}});
  expect(image?.attachments).toHaveLength(1);expect(image?.text).toContain("没有附带文字");
  const caption=await f.edge.receive(f.tenant,f.api,{...base,message:{...base.message,message_id:"post-caption",content:JSON.stringify({content:[[{tag:"text",text:"做成动画"}]]})}});
  expect(caption?.text).toBe("做成动画");expect(caption?.attachments).toEqual([]);expect(caption?.inherit_attachments).toBe(true);
  expect(f.api.im.messageResource.get).toHaveBeenCalledTimes(1);
});
test("one unusable rich-post image fails the whole source set rather than editing a different partial/previous image",async()=>{
  const f=await fixture();
  f.api.im.messageResource.get.mockImplementation(async(params:any)=>({getReadableStream:()=>Readable.from([params.path.file_key==="good" ? png : Buffer.from("broken")])}));
  const data={sender:{sender_type:"user"},message:{message_id:"bad-post",chat_id:"chat",message_type:"post",content:JSON.stringify({content:[[{tag:"text",text:"编辑第二张"},{tag:"img",image_key:"good"},{tag:"img",image_key:"bad"}]]})}};
  const run=await f.edge.receive(f.tenant,f.api,data);
  expect(run?.attachments).toEqual([]);expect(run?.inherit_attachments).toBe(false);expect(run?.text).not.toMatch(/不要|必须|不能/);
  expect(f.events.some(event=>event[1]==="feishu-image-receive-failed" && event[2].messageType==="post")).toBe(true);
});
test("bot messages and unsupported inbound audio are not mislabeled as text or images",async()=>{
  const f=await fixture();
  for(const [senderType,messageType] of [["app","image"],["user","audio"]]) await f.edge.receive(f.tenant,f.api,{sender:{sender_type:senderType},message:{message_id:"m",chat_id:"chat",message_type:messageType,content:'{"text":"text"}'}});
  expect(f.store.enqueue).not.toHaveBeenCalled();expect(f.api.im.messageResource.get).not.toHaveBeenCalled();
});

test('a successful attachment-only response gets a neutral caption instead of a failure claim',async()=>{
 const f=await fixture();f.run.output='';
 await f.edge.media(f.run,[{kind:'image',ref:'/workspace/final.png',buffer:png}]);
 await f.edge.deliver(f.run,f.api);
 const caption=f.api.im.message.reply.mock.calls.find((args:any[])=>args[0].data.msg_type==='text');
 expect(JSON.parse(caption[0].data.content).text).toBe('附件已准备好。');
 expect(f.api.im.message.reply.mock.calls.some((args:any[])=>args[0].data.msg_type==='image')).toBe(true);
});
test("a turn the platform starts itself (no inbound message) posts its reply into the chat", async () => {
  const f = await fixture(); f.run.message_id = null; f.run.chat_id = "oc_owner"; f.run.output = "你好，我是 Mirror V";
  await f.edge.deliver(f.run, f.api);
  const calls = f.api.im.message.create.mock.calls.map((args: any[]) => args[0]);
  expect(calls).toHaveLength(1);
  expect(calls[0].params.receive_id_type).toBe("chat_id");
  expect(calls[0].data.receive_id).toBe("oc_owner");
  expect(JSON.parse(calls[0].data.content)).toEqual({ text: "你好，我是 Mirror V" });
  expect(f.api.im.message.reply).not.toHaveBeenCalled();
});
test("a failed platform-started turn tells the owner in plain words instead of the scheduled-task notice", async () => {
  const f = await fixture(); f.run.message_id = null; f.run.chat_id = "oc_owner"; f.run.status = "failed"; f.run.output = "";
  await f.edge.deliver(f.run, f.api);
  const text = JSON.parse(f.api.im.message.create.mock.calls[0][0].data.content).text;
  expect(text).not.toContain("定时任务");
  expect(text).toContain("回我一句话");
});
test("a run with neither a chat nor a message to reply to still refuses to guess a target", async () => {
  const f = await fixture(); f.run.message_id = null; f.run.chat_id = null;
  await expect(f.edge.deliver(f.run, f.api)).rejects.toThrow("FEISHU_DELIVERY_TARGET_MISSING");
});
