import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import * as lark from "@larksuiteoapi/node-sdk";
import fs from "node:fs";
const c = loadConfig(),
  s = new Store(c);
try {
  const t = await s.tenant(
    process.env.NEXUS_PROFILE_TENANT_ID ||
      (() => {
        throw Error("NEXUS_PROFILE_TENANT_ID required");
      })(),
  );
  const api = new lark.Client({
    appId: t.app_id!,
    appSecret: s.unseal(t.secret!),
    loggerLevel: lark.LoggerLevel.fatal,
  });
  const r = await api.cardkit.v1.card.create({
    data: {
      type: "card_json",
      data: JSON.stringify({
        schema: "2.0",
        config: { streaming_mode: true, update_multi: true },
        body: {
          elements: [
            {
              tag: "markdown",
              element_id: "answer",
              content: "Profiling 准备",
            },
          ],
        },
      }),
    },
  });
  console.log("CARDKIT", r.code, r.data?.card_id ? "available" : "unavailable");
  if (r.data?.card_id)
    fs.writeFileSync(
      "../../.elastic/profile/probe-card.json",
      JSON.stringify(r.data),
      { mode: 0o600 },
    );
  const p = JSON.parse(
    fs.readFileSync("../../.elastic/profile/config.json", "utf8"),
  );
  const m = await fetch("https://api.deepseek.com/models", {
    headers: { Authorization: "Bearer " + p.model.apiKey },
  });
  const j: any = await m.json();
  console.log(
    "DEEPSEEK",
    m.status,
    j.data?.map((x: any) => x.id),
  );
} finally {
  await s.pool.end();
}
