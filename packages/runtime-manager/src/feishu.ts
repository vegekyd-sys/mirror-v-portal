import { createHash } from "node:crypto";
import type { ChannelEdge } from "./channel-edge.js";
import { isSilentReply } from "./reply-sentinel.js";
import * as lark from "@larksuiteoapi/node-sdk";
import { TypingReaction } from "./typing-reaction.js";
import { StreamingReply } from "./streaming-reply.js";
import type { Run, Store, Tenant } from "./store.js";
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
  delta(run: Run, text: string) { this.stream(run)?.push(text); }
  progress(run: Run, kind: string, data: any) {
    if (kind === "waking") {
      const api=this.clients.get(run.tenant_id)?.api;
      if(api && run.channel === "feishu" && run.message_id) this.typing.start(run,api);
      // Typing acknowledges receipt; do not count a placeholder as model first text.
      return;
    }
    if(kind === "tool-progress") {
      const labels: Record<string,string>={read:"读取文件",write:"写入文件",edit:"编辑文件",exec:"执行命令",process:"等待执行结果",web_search:"搜索资料",web_fetch:"读取网页"};
      const label=labels[data.name] || "执行工具";
      this.stream(run)?.progress(data.phase === "result" ? `✓ ${label}完成` : `⏳ 正在${label}…`);
    } else if(kind === "public-progress") this.stream(run)?.progress("",data.text);
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
          if(run.schedule_id && run.chat_id) {
            const quiet=run.status==='succeeded' && isSilentReply(run.output, run.schedule_kind);
            if(!quiet) {
              const text=run.status==='succeeded'?run.output:'定时任务未能完成，请检查 Nexus 任务状态。';
              const chars=Array.from(text);
              for(let offset=0;offset<chars.length;offset+=5000){
                const result=await client.api.im.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:run.chat_id,msg_type:'text',content:JSON.stringify({text:chars.slice(offset,offset+5000).join('')}),uuid:createHash('sha256').update(`${run.id}:${offset}`).digest('hex').slice(0,40)}});
                if(result.code!==0)throw Error(`FEISHU_SCHEDULE_REPLY_${result.code}`);
              }
            }
            await this.store.pool.query("UPDATE elastic_runs SET delivery='sent' WHERE id=$1",[run.id]);
            await this.store.event(run.tenant_id,quiet?'heartbeat-quiet':'feishu-delivered',{scheduleId:run.schedule_id},run.id);
            continue;
          }
          const text =
            run.output ||
            "本次执行未能安全完成，请在 Nexus 试用页查看状态。为避免重复操作，系统没有自动重做。";
          // The agent asked to stay silent — mark the turn delivered and send nothing.
          if (run.status === "succeeded" && isSilentReply(text, run.schedule_kind)) {
            await this.streams.get(run.id)?.discard();
            this.streams.delete(run.id);
            await this.store.pool.query("UPDATE elastic_runs SET delivery='sent' WHERE id=$1", [run.id]);
            await this.store.event(run.tenant_id, "reply-suppressed", { marker: text.trim().slice(0, 32) }, run.id);
            continue;
          }
          const stream =
            this.streams.get(run.id) ||
            new StreamingReply(
              this.store,
              client.api,
              run.id,
              run.tenant_id,
              run.message_id!,
            );
          const streamed = await stream.finish(text);
          this.streams.delete(run.id);
          const chars = Array.from(streamed ? "" : text);
          for (let offset = 0; offset < chars.length; offset += 5000) {
            const uuid = createHash("sha256")
              .update(`${run.id}:${offset}`)
              .digest("hex")
              .slice(0, 40);
            const reply = await client.api.im.message.reply({
              path: { message_id: run.message_id! },
              data: {
                msg_type: "text",
                content: JSON.stringify({
                  text: chars.slice(offset, offset + 5000).join(""),
                }),
                uuid,
              },
            });
            if (reply.code !== 0) throw new Error(`FEISHU_REPLY_${reply.code}`);
          }
          await this.store.pool.query(
            "UPDATE elastic_runs SET delivery='sent' WHERE id=$1",
            [run.id],
          );
          await this.store.event(run.tenant_id, "feishu-delivered", {}, run.id);
          await this.typing.stop(run,client.api).catch(async()=>{
            await this.store.event(run.tenant_id,"typing-cleanup-error",{},run.id);
          });
        }
      },
    );
  }
  connect(tenant: Tenant) {
    if (this.clients.has(tenant.id) || !tenant.app_id || !tenant.secret) return;
    const opts = {
      appId: tenant.app_id,
      appSecret: this.store.unseal(tenant.secret),
      loggerLevel: lark.LoggerLevel.error,
    };
    const api = new lark.Client(opts),
      ws = new lark.WSClient(opts);
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        const receivedAt = Date.now();
        const m = data.message;
        if (!m?.message_id || data.sender?.sender_type === "app") return;
        let text = "";
        try {
          text = JSON.parse(m.content).text || "";
        } catch {}
        if (m.message_type !== "text" || !text.trim()) return;
        // Acknowledge after the durable transaction; agent execution never blocks WS delivery.
        const run = await this.store.enqueue(
          tenant.id,
          m.message_id,
          `${tenant.id}:${m.chat_id}`,
          text,
          "feishu",
          m.message_id,
        );
        if (run.delivery !== "sent") this.typing.start(run,api);
        const createdAt = Number(m.create_time);
        await this.store.event(tenant.id,"feishu-ingress",{
          messageCreatedAt:Number.isFinite(createdAt)?createdAt:null,
          handlerReceivedAt:receivedAt,
          committedAt:Date.now(),
          transportMs:Number.isFinite(createdAt)?receivedAt-createdAt:null,
          enqueueMs:Date.now()-receivedAt,
          eventLoopLagMs:this.lastLoopLagMs,
          connection:ws.getConnectionStatus(),
        },run.id);
      },
    });
    this.clients.set(tenant.id, { ws, api });
    void ws.start({ eventDispatcher: dispatcher });
  }
  close() {
    if(this.connectionTimer) clearInterval(this.connectionTimer);
    for (const { ws } of this.clients.values()) ws.close();
  }
}
