import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import * as lark from "@larksuiteoapi/node-sdk";
const c = loadConfig(),
  s = new Store(c);
const tenantId = process.env.NEXUS_PROFILE_TENANT_ID;
if (!tenantId) throw Error("NEXUS_PROFILE_TENANT_ID required");
await s.init();
try {
  const t = await s.tenant(tenantId);
  const {
    rows: [parent],
  } = await s.pool.query(
    "SELECT message_id,session_key FROM elastic_runs WHERE tenant_id=$1 AND channel='feishu' ORDER BY created_at DESC LIMIT 1",
    [t.id],
  );
  const run = await s.enqueue(
    t.id,
    "rollout-proof-" + Date.now(),
    parent.session_key,
    "【Nexus 升级验收】这是技术验收，不接续其他业务话题。不要修改文件。请用文件工具读取工作目录的 nexus-profile-proof.txt，只回复“升级验收：”和文件原文。",
    "feishu",
    parent.message_id,
  );
  console.log("RUN", run.id);
  for (let i = 0; i < 180; i++) {
    const r = await s.run(run.id);
    if (r.status === "failed" || r.status === "uncertain")
      throw Error(r.error || r.status);
    if (r.delivery === "sent") {
      const events = (
        await s.pool.query(
          "SELECT kind,data,created_at FROM elastic_events WHERE run_id=$1 AND kind<>'delta' ORDER BY seq",
          [r.id],
        )
      ).rows;
      const sr = (
        await s.pool.query(
          "SELECT message_id FROM elastic_streams WHERE run_id=$1",
          [r.id],
        )
      ).rows[0];
      let readback = false;
      if (sr?.message_id) {
        const api = new lark.Client({
          appId: t.app_id!,
          appSecret: s.unseal(t.secret!),
          loggerLevel: lark.LoggerLevel.fatal,
        });
        const result = await api.im.message.get({
          path: { message_id: sr.message_id },
        });
        readback =
          result.code === 0 &&
          JSON.stringify(result.data).includes("official-deepseek-stream-914");
      }
      const proof = {
        runId: r.id,
        status: r.status,
        delivery: r.delivery,
        outputContainsMarker: r.output.includes("official-deepseek-stream-914"),
        feishuReadback: readback,
        events,
      };
      fs.writeFileSync(
        path.join(c.dataDir, "profile/rollout-verification.json"),
        JSON.stringify(proof, null, 2),
      );
      console.log(JSON.stringify(proof));
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
    if (i === 179) throw Error("VERIFY_TIMEOUT");
  }
} finally {
  await s.close();
}
