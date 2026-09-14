import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { VercelProvider } from "../src/provider.js";
import { StreamingReply } from "../src/streaming-reply.js";
const c = loadConfig();
const privateProfile = JSON.parse(
  fs.readFileSync(path.join(c.dataDir, "profile/config.json"), "utf8"),
);
const s = new Store(c);
await s.init();
const owner = await s.tenant(
  process.env.NEXUS_PROFILE_TENANT_ID ||
    (() => {
      throw Error("NEXUS_PROFILE_TENANT_ID required");
    })(),
);
const {
  rows: [parent],
} = await s.pool.query(
  "SELECT message_id FROM elastic_runs WHERE tenant_id=$1 AND channel='feishu' ORDER BY created_at DESC LIMIT 1",
  [owner.id],
);
if (!parent?.message_id) throw Error("NO_AUTHORIZED_TRIAL_CHAT");
const api = new lark.Client({
  appId: owner.app_id!,
  appSecret: s.unseal(owner.secret!),
  loggerLevel: lark.LoggerLevel.fatal,
});
const results: any[] = [];
const destination = path.join(c.dataDir, "profile/results.json");
try {
  for (const optimized of [false, true]) {
    const phase = optimized ? "optimized" : "baseline";
    const tenant = await s.createTenant(
      `profile-${phase}-${Date.now()}`,
      `性能测试 ${phase}`,
    );
    await s.pool.query(
      "UPDATE elastic_tenants SET state='profiling' WHERE id=$1",
      [tenant.id],
    );
    const p = new VercelProvider({
      ...c,
      model: privateProfile.model,
      optimizeRuntime: optimized,
    });
    try {
      for (let i = 0; i < (optimized ? 6 : 4); i++) {
        const kind = i % 2 === 0 ? "cold" : "hot";
        const runId = randomUUID();
        const label = `性能测试 ${phase} ${i + 1} (${kind})`;
        const prompt = `这是首字速度测试，不调用工具。请以“${label}”开头，用约150字中文解释外贸销售第一次联系潜在客户时应该注意什么。`;
        await s.pool.query(
          "INSERT INTO elastic_runs(id,tenant_id,request_key,session_key,text,channel,status,message_id) VALUES($1::uuid,$2,$1::text,$1::text,$3,'profile','running',$4)",
          [runId, tenant.id, prompt, parent.message_id],
        );
        const start = Date.now();
        const events: any[] = [];
        const stream = optimized
          ? new StreamingReply(s, api, runId, tenant.id, parent.message_id)
          : undefined;
        try {
          const handle = await p.ensure(tenant, async (name) => {
            tenant.sandbox_name = name;
            await s.pool.query(
              "UPDATE elastic_tenants SET sandbox_name=$2 WHERE id=$1",
              [tenant.id, name],
            );
          });
          const readyAt = Date.now();
          tenant.state = "ready";
          const output = await p.execute(
            tenant,
            runId,
            prompt,
            async (kind, data) => {
              events.push({ kind, data, at: Date.now() });
              await s.event(tenant.id, kind, data, runId);
              if (kind === "delta") stream?.push(data.text);
            },
          );
          if (stream) {
            if (!(await stream.finish(output)))
              throw Error("STREAM_FINALIZE_FAILED");
          } else {
            const r = await api.im.message.reply({
              path: { message_id: parent.message_id },
              data: {
                msg_type: "text",
                content: JSON.stringify({ text: output }),
                uuid: runId,
              },
            });
            if (r.code !== 0) throw Error("BASELINE_REPLY_FAILED");
          }
          const finish = Date.now();
          const { rows: delivery } = await s.pool.query(
            "SELECT data FROM elastic_events WHERE run_id=$1 AND kind='feishu-first-content' ORDER BY seq LIMIT 1",
            [runId],
          );
          const first = events.find((x) => x.kind === "first-delta");
          const model = events
            .filter((x) => x.kind === "model-timing")
            .map((x) => x.data);
          const row = {
            phase,
            kind,
            runId,
            model: privateProfile.model.id,
            start,
            readyMs: readyAt - start,
            ...handle.timings,
            firstDeltaMs: first ? first.at - start : null,
            feishuFirstContentMs: delivery[0]
              ? delivery[0].data.at - start
              : finish - start,
            totalMs: finish - start,
            modelTimings: model,
            events: events.filter((x) => x.kind !== "delta"),
            characters: output.length,
          };
          results.push(row);
          fs.writeFileSync(destination, JSON.stringify(results, null, 2));
          await s.pool.query(
            "UPDATE elastic_runs SET status='succeeded',output=$2,delivery='sent',completed_at=now() WHERE id=$1",
            [runId, output],
          );
          console.log(JSON.stringify({ ...row, events: undefined }));
        } catch (e) {
          console.log(
            "PROFILE_ERROR",
            phase,
            kind,
            e instanceof Error ? e.message : "unknown",
          );
          await s.pool.query(
            "UPDATE elastic_runs SET status='failed',error=$2 WHERE id=$1",
            [runId, e instanceof Error ? e.message : "unknown"],
          );
          throw e;
        }
        if (kind === "hot") {
          console.log("RELEASE", await p.stop(tenant));
          tenant.state = "sleeping";
        }
      }
    } finally {
      await p.stop(tenant).catch(() => {});
      await s.pool.query(
        "UPDATE elastic_tenants SET state='sleeping' WHERE id=$1",
        [tenant.id],
      );
    }
  }
} finally {
  await s.close();
}
