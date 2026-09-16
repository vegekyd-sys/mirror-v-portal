import { Scheduler } from './scheduler.js';
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { VercelProvider } from "./provider.js";
import { AlibabaProvider, alibabaReady } from "./alibaba-provider.js";
import { ProviderRouter } from "./provider-router.js";
import { RuntimeManager } from "./manager.js";
import { FeishuEdge } from "./feishu.js";
const config = loadConfig(),
  store = new Store(config);
await store.init();
const scheduler=new Scheduler(store);await scheduler.init();
await store.createTenant(config.trialTenantId, "DealClaw 试用");
const alibabaTrialId = config.alibaba?.trialTenantId || "alibaba-trial";
if (alibabaReady(config))
  await store.createTenant(alibabaTrialId, "DealClaw 阿里云试用", undefined, undefined, "alibaba");
const edge = new FeishuEdge(store);
const manager = new RuntimeManager(
  store,
  new ProviderRouter({ vercel: new VercelProvider(config), alibaba: new AlibabaProvider(config) }),
  (run, text) => edge.delta(run, text),
  (run, kind, data) => edge.progress(run, kind, data),
);
await edge.start();
await manager.start();
scheduler.start();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
const cookie = randomUUID();
app.use((req, res, next) => {
  if (!["127.0.0.1", "localhost"].includes(req.hostname)) {
    res.sendStatus(403);
    return;
  }
  const origin = req.get("origin");
  if (origin && origin !== `http://${req.get("host")}`) {
    res.sendStatus(403);
    return;
  }
  next();
});
app.get("/", (_req, res) => {
  res.cookie("nexus_trial", cookie, { httpOnly: true, sameSite: "strict" });
  res
    .type("html")
    .send(
      fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8"),
    );
});
app.use((req, res, next) => {
  const token = req.get("authorization")?.replace(/^Bearer /, "") || "";
  const admin =
    token.length === config.adminToken.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(config.adminToken));
  if (
    admin ||
    (req.headers.cookie || "")
      .split(";")
      .some((v) => v.trim() === `nexus_trial=${cookie}`)
  ) {
    next();
    return;
  }
  res.sendStatus(401);
});
app.use("/onboard", async (req, res, next) => {
  try {
    const response = await fetch(`http://127.0.0.1:8098/onboard${req.url}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
    });
    res
      .status(response.status)
      .type(response.headers.get("content-type") || "text/html")
      .send(await response.text());
  } catch (e) {
    next(e);
  }
});
app.post("/v1/tenants", async (req, res, next) => {
  try {
    const { botAppId, botAppSecret } = req.body;
    const runtimeProvider = req.body.runtimeProvider ?? "vercel";
    if (!["vercel", "alibaba"].includes(runtimeProvider)) {
      res.status(400).json({ error: "INVALID_RUNTIME_PROVIDER" }); return;
    }
    if (runtimeProvider === "alibaba" && !alibabaReady(config)) {
      res.status(503).json({ error: "ALIBABA_NOT_CONFIGURED" }); return;
    }
    if (!botAppId || !botAppSecret) {
      res.status(400).json({ error: "APP_CREDENTIALS_REQUIRED" });
      return;
    }
    const t = await store.createTenant(
      randomUUID(),
      "扫码创建的 DealClaw",
      botAppId,
      botAppSecret,
      runtimeProvider,
    );
    edge.connect(t);
    res.json({ tenant: { tenantId: t.id } });
  } catch (e) {
    next(e);
  }
});
app.put("/v1/tenants/:id/credentials", async (req, res, next) => {
  try {
    const t = await store.tenant(req.params.id);
    if (t.app_id !== req.body.appId) {
      res.sendStatus(409);
      return;
    }
    edge.connect(t);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});
app.get("/api/state", async (_req, res, next) => {
  try {
    const tenants = await store.pool.query(
      "SELECT id,name,app_id,state,sandbox_name,idle_seconds,last_error,last_wake_ms,wake_count,runtime_provider FROM elastic_tenants WHERE app_id IS NOT NULL OR id=ANY($1::text[]) ORDER BY created_at",
      [[config.trialTenantId, alibabaTrialId]],
    );
    const runs = await store.pool.query(
      "SELECT id,tenant_id,text,status,CASE WHEN status='running' THEN coalesce((SELECT string_agg(data->>'text','' ORDER BY seq) FROM elastic_events WHERE run_id=elastic_runs.id AND kind='delta'),output) ELSE output END AS output,error,delivery FROM elastic_runs WHERE channel <> 'profile' ORDER BY created_at DESC LIMIT 50",
    );
    const events = await store.pool.query(
      "SELECT kind,data,created_at,tenant_id FROM elastic_events WHERE kind NOT IN ($1,$2) ORDER BY seq DESC LIMIT 30",
      ["delta", "runtime-completed"],
    );
    res.json({ tenants: tenants.rows, runs: runs.rows, events: events.rows });
  } catch (e) {
    next(e);
  }
});
app.post("/api/messages", async (req, res, next) => {
  try {
    const run = await store.enqueue(
      req.body.tenantId || config.trialTenantId,
      req.body.requestId || randomUUID(),
      "browser-trial",
      req.body.text,
    );
    res.status(202).json({ runId: run.id });
  } catch (e) {
    next(e);
  }
});
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("[http]", err.message);
  res.status(500).json({ error: "REQUEST_FAILED" });
});
const server = app.listen(config.port, "127.0.0.1", () =>
  console.log(`Nexus trial http://127.0.0.1:${config.port}`),
);
async function close() {
  manager.stopTimer();
  await scheduler.close();
  edge.close();
  server.close();
  await manager.drainCollector();
  await store.close();
  process.exit(0);
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
