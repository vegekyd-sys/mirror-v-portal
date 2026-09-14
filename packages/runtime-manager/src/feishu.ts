import { createHash } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import type { Store, Tenant } from "./store.js";
export class FeishuEdge {
  clients = new Map<string, { ws: lark.WSClient; api: lark.Client }>();
  constructor(readonly store: Store) {}
  async start() {
    const { rows } = await this.store.pool.query<Tenant>(
      "SELECT * FROM elastic_tenants WHERE app_id IS NOT NULL AND secret IS NOT NULL",
    );
    for (const tenant of rows) this.connect(tenant);
    await this.store.boss.work<{ runId: string }>(
      "feishu-reply",
      { pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          const run = await this.store.run(job.data.runId);
          if (run.delivery === "sent") continue;
          const client = this.clients.get(run.tenant_id);
          if (!client) throw new Error("FEISHU_NOT_CONNECTED");
          const text =
            run.output ||
            "本次执行未能安全完成，请在 Nexus 试用页查看状态。为避免重复操作，系统没有自动重做。";
          const chars = Array.from(text);
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
        const m = data.message;
        if (!m?.message_id || data.sender?.sender_type === "app") return;
        let text = "";
        try {
          text = JSON.parse(m.content).text || "";
        } catch {}
        if (m.message_type !== "text" || !text.trim()) return;
        // Acknowledge after the durable transaction; agent execution never blocks WS delivery.
        await this.store.enqueue(
          tenant.id,
          m.message_id,
          `${tenant.id}:${m.chat_id}`,
          text,
          "feishu",
          m.message_id,
        );
      },
    });
    this.clients.set(tenant.id, { ws, api });
    void ws.start({ eventDispatcher: dispatcher });
  }
  close() {
    for (const { ws } of this.clients.values()) ws.close();
  }
}
