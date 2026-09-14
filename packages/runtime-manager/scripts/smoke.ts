import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { VercelProvider } from "../src/provider.js";
const c = loadConfig(),
  s = new Store(c),
  p = new VercelProvider(c);
await s.init();
const t = await s.createTenant(c.trialTenantId, "DealClaw 试用");
try {
  const h = await p.ensure(t);
  console.log("READY", h);
  t.sandbox_name = h.name;
  await s.pool.query(
    "UPDATE elastic_tenants SET sandbox_name=$2,state=$3 WHERE id=$1",
    [t.id, h.name, "ready"],
  );
  console.log(
    await p.execute(
      t,
      "trial-acceptance",
      "请使用文件工具把 nexus-trial-914 写入工作目录的 trial-marker.txt，然后告诉我文件路径。",
      async () => {},
    ),
  );
  console.log("STOP", await p.stop(t));
} finally {
  await s.close();
}
