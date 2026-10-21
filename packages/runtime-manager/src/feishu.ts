import { createHash } from "node:crypto";
import type { ChannelEdge } from "./channel-edge.js";
import { isSilentReply } from "./reply-sentinel.js";
import type { MediaFile } from "./provider.js";
import * as lark from "@larksuiteoapi/node-sdk";
import { TypingReaction } from "./typing-reaction.js";
import { StreamingReply } from "./streaming-reply.js";
import type { Run, Store, Tenant } from "./store.js";
import { prepareFeishuMedia, uploadKey } from "./feishu-media.js";
import { FeishuOutboundVault } from "./feishu-outbound.js";
import { downloadFeishuVideo, persistFeishuVideo, parseFeishuVideos, downloadFeishuImage, parseFeishuContent, persistFeishuImage } from "./feishu-inbound.js";
import { MAX_INBOUND_IMAGES, normalizeInboundAttachments, type InboundAttachment } from "./inbound-media.js";

// Preserve the SDK's response-unwrapping and $return_headers interceptor; a fresh axios instance loses both.
const feishuHttp: NonNullable<ConstructorParameters<typeof lark.Client>[0]["httpInstance"]> = {
  request: (opts:any) => lark.defaultHttpInstance.request({...opts,timeout:opts?.timeout ?? 60_000}) as any,
  get: (url:string,opts:any) => lark.defaultHttpInstance.get(url,{...opts,timeout:opts?.timeout ?? 60_000}) as any,
  delete: (url:string,opts:any) => lark.defaultHttpInstance.delete(url,{...opts,timeout:opts?.timeout ?? 60_000}) as any,
  head: (url:string,opts:any) => lark.defaultHttpInstance.head(url,{...opts,timeout:opts?.timeout ?? 60_000}) as any,
  options: (url:string,opts:any) => lark.defaultHttpInstance.options(url,{...opts,timeout:opts?.timeout ?? 60_000}) as any,
  post: (url:string,data:any,opts:any) => lark.defaultHttpInstance.post(url,data,{...opts,timeout:opts?.timeout ?? 60_000}) as any,
  put: (url:string,data:any,opts:any) => lark.defaultHttpInstance.put(url,data,{...opts,timeout:opts?.timeout ?? 60_000}) as any,
  patch: (url:string,data:any,opts:any) => lark.defaultHttpInstance.patch(url,data,{...opts,timeout:opts?.timeout ?? 60_000}) as any,
};
export class FeishuEdge implements ChannelEdge {
  readonly channel = "feishu";
  clients = new Map<string, { ws: lark.WSClient; api: lark.Client }>();
  streams = new Map<string, StreamingReply>();
  private connectionTimer?: NodeJS.Timeout;
  private connectionStates = new Map<string,string>();
  private lastTick = Date.now();
  private lastLoopLagMs = 0;
  readonly typing: TypingReaction;
  constructor(readonly store: Store) { this.typing = new TypingReaction(store); }
  private stream(run: Run) {
    if (run.channel !== "feishu" || !run.message_id) return;
    const api = this.clients.get(run.tenant_id)?.api;
    if (!api) return;
    let stream = this.streams.get(run.id);
    if (!stream) {
      stream = new StreamingReply(
        this.store,
        api,
        run.id,
        run.tenant_id,
        run.message_id,
      );
      this.streams.set(run.id, stream);
    }
    return stream;
  }
  private get vault() { return new FeishuOutboundVault(this.store.config.dataDir); }
  /** Stage only: the delivery queue uploads these exact bytes after the agent turn commits. */
  async media(run: Run, files: MediaFile[]) {
    if (run.channel !== this.channel || !files.length) return;
    if (!run.message_id && !run.chat_id) throw Error("FEISHU_DELIVERY_TARGET_MISSING");
    await this.vault.stage(run.tenant_id,run.id,files);
    await this.store.event(run.tenant_id,"feishu-media-staged",{
      files:files.map(file => ({kind:file.kind,bytes:file.buffer.length,sha256:createHash("sha256").update(file.buffer).digest("hex")})),
    },run.id);
  }
  /** Retry delivery, never the creation task. Keys and successful sends are persisted per file. */
  async deliverMedia(run: Run, api: lark.Client) {
    const vault = this.vault, manifest = await vault.load(run.tenant_id,run.id);
    if (!manifest) return;
    let failure: string | undefined;
    for (const file of manifest.files) {
      if (file.sent) continue;
      try {
        if (!file.prepared) {
          const buffer = await vault.readBlob(run.tenant_id,run.id,file);
          await vault.prepared(manifest,file,await prepareFeishuMedia({ref:file.ref,kind:file.kind,buffer}));
        }
        const prepared = file.prepared!;
        if (!file.uploadKey) {
          const buffer = await vault.readBlob(run.tenant_id,run.id,prepared);
          file.uploadKey = prepared.msgType === "image"
            ? uploadKey(await api.im.image.create({data:{image_type:"message",image:buffer}}),"image_key")
            : uploadKey(await api.im.file.create({data:{file_type:prepared.fileType!,file_name:prepared.filename,file:buffer,...(prepared.duration ? {duration:prepared.duration} : {})}}),"file_key");
          await vault.save(manifest);
        }
        if (prepared.cover && !file.coverKey) {
          const buffer = await vault.readBlob(run.tenant_id,run.id,prepared.cover);
          file.coverKey = uploadKey(await api.im.image.create({data:{image_type:"message",image:buffer}}),"image_key");
          await vault.save(manifest);
        }
        const content = prepared.msgType === "image" ? {image_key:file.uploadKey} : {file_key:file.uploadKey,...(file.coverKey ? {image_key:file.coverKey} : {})};
        const data = {msg_type:prepared.msgType,content:JSON.stringify(content),uuid:createHash("sha256").update(`${run.id}:media:${file.id}`).digest("hex").slice(0,40)};
        const sent = run.message_id
          ? await api.im.message.reply({path:{message_id:run.message_id},data})
          : await api.im.message.create({params:{receive_id_type:"chat_id"},data:{receive_id:run.chat_id!,...data}});
        if (sent.code !== 0) throw Error(`FEISHU_MEDIA_SEND_${Number(sent.code) || "FAILED"}`);
        if (typeof sent.data?.message_id !== "string" || !sent.data.message_id.trim()) throw Error("FEISHU_MEDIA_SEND_UNCONFIRMED");
        file.sent = true;
        file.messageId = sent.data.message_id;
        await vault.save(manifest);
        await this.store.event(run.tenant_id,"feishu-media-sent",{
          sha256:file.sha256,kind:file.kind,bytes:file.bytes,msgType:prepared.msgType,deliveredBytes:prepared.bytes,duration:prepared.duration ?? null,messageId:file.messageId ?? null,
        },run.id);
      } catch (error: any) {
        // Do not log SDK response bodies, signed URLs, multipart payloads, or arbitrary stderr.
        const code = /^FEISHU_[A-Z0-9_]+$/.test(error?.message) ? error.message : "FEISHU_MEDIA_DELIVERY_FAILED";
        await this.store.event(run.tenant_id,"feishu-media-failed",{sha256:file.sha256,kind:file.kind,code},run.id).catch(()=>{});
        failure = code;
      }
    }
    if (failure) throw Error(failure);
  }
  /** Final text and native attachments must both finish before delivery is marked sent. */
  async deliver(run: Run, api: lark.Client) {
    const vault = this.vault;
    const manifest = await vault.load(run.tenant_id,run.id);
    const quiet = run.status === "succeeded" && isSilentReply(run.output,run.schedule_kind);
    if (!manifest?.textDelivered) {
      // Runs with no inbound message to reply to — scheduled tasks, and turns the
      // platform starts itself (the greeting right after a scan, a takeover handing
      // control back) — post a new message into their chat instead.
      if (run.chat_id && (run.schedule_id || !run.message_id)) {
        if (!quiet) {
          const text = run.status === "succeeded" ? run.output
            : run.schedule_id ? "定时任务未能完成，请检查 Mirror V Portal 任务状态。"
            : "我这边刚才没能完成，你直接回我一句话，我接着来。";
          const chars = Array.from(text);
          for (let offset=0;offset<chars.length;offset+=5000) {
            const result = await api.im.message.create({params:{receive_id_type:"chat_id"},data:{receive_id:run.chat_id,msg_type:"text",content:JSON.stringify({text:chars.slice(offset,offset+5000).join("")}),uuid:createHash("sha256").update(`${run.id}:${offset}`).digest("hex").slice(0,40)}});
            if (result.code !== 0) throw Error(`FEISHU_SCHEDULE_REPLY_${result.code}`);
          }
        }
      } else if (quiet) {
        await this.streams.get(run.id)?.discard();
        this.streams.delete(run.id);
      } else {
        const text = run.output || (run.status === "succeeded" && manifest?.files.length ? "附件已准备好。" : "本次执行未能安全完成，请在 Mirror V Portal 试用页查看状态。为避免重复操作，系统没有自动重做。");
        if (!run.message_id) throw Error("FEISHU_DELIVERY_TARGET_MISSING");
        const stream = this.streams.get(run.id) || new StreamingReply(this.store,api,run.id,run.tenant_id,run.message_id);
        const streamed = await stream.finish(text);
        this.streams.delete(run.id);
        const chars = Array.from(streamed ? "" : text);
        for (let offset=0;offset<chars.length;offset+=5000) {
          const reply = await api.im.message.reply({path:{message_id:run.message_id},data:{msg_type:"text",content:JSON.stringify({text:chars.slice(offset,offset+5000).join("")}),uuid:createHash("sha256").update(`${run.id}:${offset}`).digest("hex").slice(0,40)}});
          if (reply.code !== 0) throw Error(`FEISHU_REPLY_${reply.code}`);
        }
      }
      if (manifest) {manifest.textDelivered=true;await vault.save(manifest);}
    }
    await this.deliverMedia(run,api);
    await this.store.pool.query("UPDATE elastic_runs SET delivery='sent' WHERE id=$1",[run.id]);
    await this.store.event(run.tenant_id,quiet ? (run.schedule_id ? "heartbeat-quiet" : "reply-suppressed") : "feishu-delivered",{...(run.schedule_id ? {scheduleId:run.schedule_id} : {}),...(quiet ? {marker:run.output.trim().slice(0,32)} : {})},run.id);
    await this.typing.stop(run,api).catch(async()=>{await this.store.event(run.tenant_id,"typing-cleanup-error",{},run.id);});
  }
  delta(run: Run, text: string) { this.stream(run)?.push(text); }
  progress(run: Run, kind: string, data: any) {
    if (kind === "waking") {
      const api=this.clients.get(run.tenant_id)?.api;
      if(api && run.channel === "feishu" && run.message_id) this.typing.start(run,api);
      // Typing acknowledges receipt; do not count a placeholder as model first text.
      return;
    }
    if(kind === "tool-progress") {
      const labels: Record<string,string>={read:"读取文件",write:"写入文件",edit:"编辑文件",exec:"执行命令",process:"等待执行结果",web_search:"搜索资料",web_fetch:"读取网页",makaron_generate_image:"图片生成／状态查询",makaron_generate_animation:"视频生成／状态查询",makaron_generate_audio:"音乐生成／状态查询",makaron_run_code:"设计渲染／状态查询",makaron_preview_frame:"预览检查",makaron_materialize_media:"保存媒体",makaron_materialize_artifact:"接入媒体",makaron_project:"同步项目",makaron_discover:"查询当前能力",makaron_transcribe_audio:"语音转录",makaron_read_file:"读取创作指南"};
      const label=labels[data.name] || "执行工具";
      this.stream(run)?.progress(data.phase === "result" ? `✓ ${label}工具已返回` : `⏳ 正在${label}…`);
    } else if(kind === "public-progress") this.stream(run)?.progress("",data.text);
    else if(kind === "preview") this.stream(run)?.showPreview(data.text);
    else if(kind === "commentary") this.stream(run)?.commentary(data.text, data.retract);
    else if(kind === "runtime-completed") this.streams.get(run.id)?.progress("");
  }
  async start() {
    const { rows } = await this.store.pool.query<Tenant>(
      "SELECT * FROM elastic_tenants WHERE app_id IS NOT NULL AND secret IS NOT NULL",
    );
    for (const tenant of rows) this.connect(tenant);
    this.lastTick = Date.now();
    this.connectionTimer = setInterval(() => {
      const now=Date.now();
      this.lastLoopLagMs=Math.max(0,now-this.lastTick-5000);
      this.lastTick=now;
      for(const [id,{ws}] of this.clients) {
        const status=ws.getConnectionStatus();
        const key=JSON.stringify(status);
        if(this.connectionStates.get(id)!==key || this.lastLoopLagMs>1000) {
          this.connectionStates.set(id,key);
          void this.store.event(id,"feishu-connection",{...status,eventLoopLagMs:this.lastLoopLagMs,at:now}).catch(()=>{});
        }
      }
    },5000);
    const stale = await this.store.pool.query<Run>("SELECT r.* FROM elastic_runs r WHERE r.delivery='sent' AND EXISTS (SELECT 1 FROM elastic_events e WHERE e.run_id=r.id AND e.kind='typing-added') AND NOT EXISTS (SELECT 1 FROM elastic_events e WHERE e.run_id=r.id AND e.kind='typing-removed')");
    for(const run of stale.rows) {
      const api=this.clients.get(run.tenant_id)?.api;
      if(api) await this.typing.stop(run,api).catch(()=>{});
    }
    await this.store.boss.work<{ runId: string }>(
      "feishu-reply",
      { pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          const run = await this.store.run(job.data.runId);
          if (run.delivery === "sent") continue;
          const client = this.clients.get(run.tenant_id);
          if (!client) throw new Error("FEISHU_NOT_CONNECTED");
          await this.deliver(run,client.api);
        }
      },
    );
  }
  async receive(tenant: Tenant, api: lark.Client, data: any, connection?: unknown) {
    const receivedAt = Date.now(), m = data.message;
    if (!m?.message_id || data.sender?.sender_type === "app") return;
    if (!["text","image","post","media","file"].includes(m.message_type)) return;
    const videos=parseFeishuVideos(m.message_type,m.content);
    if (m.message_type === "file" && !videos.length) return;
    if (typeof m.message_id !== "string" || typeof m.chat_id !== "string" || !m.chat_id) return;
    const content = parseFeishuContent(m.message_type,m.content);
    let text = content.text;
    if (m.message_type === "text" && !text.trim()) return;
    if (m.message_type === "post" && !text.trim() && !content.imageKeys.length && !videos.length) return;
    // A replay reuses the durable run. Never redownload or rewrite an already committed image turn.
    const prior = await this.store.pool.query<Run>("SELECT * FROM elastic_runs WHERE tenant_id=$1 AND request_key=$2",[tenant.id,m.message_id]);
    if (prior.rows[0]) {if (prior.rows[0].delivery !== "sent") this.typing.start(prior.rows[0],api);return prior.rows[0];}
    let attachments: InboundAttachment[] = [], failedImage = false;
    if (m.message_type === "image" || content.imageKeys.length) {
      let failure: string | undefined;
      if (!content.imageKeys.length) failure="FEISHU_IMAGE_RESOURCE_INVALID";
      if (content.imageKeys.length > MAX_INBOUND_IMAGES) failure="FEISHU_IMAGES_TOO_MANY";
      for (const imageKey of failure ? [] : content.imageKeys) {
        let buffer: Buffer | undefined;
        for (let attempt=0;attempt<3;attempt++) {
          try {buffer=await downloadFeishuImage(api,m.message_id,imageKey);break;}
          catch (error: any) {
            failure=error.message;
            if (["FEISHU_IMAGE_RESOURCE_INVALID","FEISHU_IMAGE_TOO_LARGE","FEISHU_IMAGE_EMPTY","FEISHU_IMAGE_FORMAT_UNSUPPORTED"].includes(failure!)) break;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve,250 * (attempt+1)));
          }
        }
        if (!buffer) break;
        failure=undefined;
        // Filesystem failures escape before enqueue; they must not be acknowledged as an empty image.
        attachments.push(await persistFeishuImage(this.store.config.dataDir,tenant.id,m.message_id,buffer));
        try {normalizeInboundAttachments(attachments,tenant.id);} catch {failure="FEISHU_IMAGES_TOO_LARGE";break;}
      }
      if (!failure && attachments.length) {
        if (!text.trim()) text="【Portal 附件信息】本条消息只有用户图片，没有附带文字。";
      } else {
        failedImage=true;
        attachments=[];
        await this.store.event(tenant.id,"feishu-image-receive-failed",{code:failure ?? "FEISHU_IMAGE_RESOURCE_INVALID",messageType:m.message_type});
        text="【Portal 附件接收失败】本条飞书图片的实际原图未能接入；本轮没有可用图片附件。";
      }
    }
    if (m.message_type === "media" || videos.length) {
      let failure:string|undefined=failedImage ? "FEISHU_IMAGE_RESOURCE_INVALID" : undefined;
      if (!videos.length || videos.length + attachments.length > MAX_INBOUND_IMAGES) failure="FEISHU_VIDEO_RESOURCE_INVALID";
      for (const video of failure ? [] : videos) {
        let buffer:Buffer;
        try {buffer=await downloadFeishuVideo(api,m.message_id,video.fileKey);}
        catch(error:any){failure=/^[A-Z_]+$/.test(error.message) ? error.message : "FEISHU_VIDEO_DOWNLOAD_FAILED";break;}
        // Durable filesystem failures must escape before acknowledging the message.
        attachments.push(await persistFeishuVideo(this.store.config.dataDir,tenant.id,m.message_id,buffer));
        try {normalizeInboundAttachments(attachments,tenant.id);}catch{failure="FEISHU_VIDEOS_TOO_LARGE";break;}
      }
      if(failure){failedImage=true;attachments=[];await this.store.event(tenant.id,"feishu-video-receive-failed",{code:failure,messageType:m.message_type});text="【Portal 附件接收失败】本条飞书视频原文件未能接入；本轮没有可用视频附件。";}
      else if(!text.trim())text="【Portal 附件信息】本条消息只有用户视频，没有附带文字。";
    }
    const run=await this.store.enqueue(tenant.id,m.message_id,`${tenant.id}:${m.chat_id}`,text,"feishu",m.message_id,attachments,failedImage ? {inheritAttachments:false} : {});
    if (run.delivery !== "sent") this.typing.start(run,api);
    const createdAt=Number(m.create_time);
    await this.store.event(tenant.id,"feishu-ingress",{
      messageCreatedAt:Number.isFinite(createdAt)?createdAt:null,handlerReceivedAt:receivedAt,committedAt:Date.now(),
      transportMs:Number.isFinite(createdAt)?receivedAt-createdAt:null,enqueueMs:Date.now()-receivedAt,eventLoopLagMs:this.lastLoopLagMs,
      connection:connection ?? null,messageType:m.message_type,attachments:attachments.map(file=>({sha256:file.sha256,bytes:file.bytes,mimeType:file.mimeType})),
    },run.id);
    return run;
  }
  connect(tenant: Tenant) {
    if (this.clients.has(tenant.id) || !tenant.app_id || !tenant.secret) return;
    const opts = {
      appId: tenant.app_id,
      appSecret: this.store.unseal(tenant.secret),
      loggerLevel: lark.LoggerLevel.error,
      // SDK errors may contain axios request headers. Keep credential-bearing payloads out of logs.
      logger: {error:()=>console.error("[feishu] FEISHU_SDK_ERROR"),warn:()=>{},info:()=>{},debug:()=>{},trace:()=>{}},
      httpInstance: feishuHttp,
    };
    const api = new lark.Client(opts),
      ws = new lark.WSClient(opts);
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        await this.receive(tenant,api,data,ws.getConnectionStatus());
      },
    });
    this.clients.set(tenant.id, { ws, api });
    void ws.start({ eventDispatcher: dispatcher }).catch(async () => {
      this.clients.delete(tenant.id);
      await this.store.event(tenant.id, "feishu-connect-failed", {
        code: "FEISHU_CONNECT_FAILED",
      }).catch(() => {});
    });
  }
  close() {
    if(this.connectionTimer) clearInterval(this.connectionTimer);
    for (const { ws } of this.clients.values()) ws.close();
  }
}
