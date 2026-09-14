import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { VercelProvider } from "../src/provider.js";
const c = loadConfig(),
  s = new Store(c),
  p = new VercelProvider(c);
await s.init();
try {
  const t = await s.tenant(c.trialTenantId);
  t.state = "sleeping";
  console.log("RESUME", await p.ensure(t));
  console.log(
    await p.execute(
      t,
      "trial-acceptance",
      "请用文件工具读取 trial-marker.txt，告诉我内容，并简述我上一条消息要求你做什么。",
      async () => {},
    ),
  );
  console.log("STOP", await p.stop(t));
  await s.pool.query(
    "UPDATE elastic_tenants SET state='sleeping' WHERE id=$1",
    [t.id],
  );
} finally {
  await s.close();
}
