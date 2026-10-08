import { Scheduler } from './scheduler.js';
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { availableTemplates, requireTemplate, templateSecretNames, validateTenantSecrets } from "./templates.js";
import { VercelProvider } from "./provider.js";
import { AlibabaProvider, alibabaReady } from "./alibaba-provider.js";
import { ProviderRouter } from "./provider-router.js";
import { RuntimeManager } from "./manager.js";
import { FeishuEdge } from "./feishu.js";
import { EdgeRouter } from "./channel-edge.js";
import { WeixinEdge } from "./weixin.js";
import { WeixinLogin } from "./weixin-login.js";
import { DingtalkEdge } from "./dingtalk.js";
import { WecomEdge } from "./wecom.js";
const config = loadConfig(),
  store = new Store(config);
await store.init();
const scheduler=new Scheduler(store);await scheduler.init();
await store.createTenant(config.trialTenantId, "DealClaw 试用");
const alibabaTrialId = config.alibaba?.trialTenantId || "alibaba-trial";
if (alibabaReady(config))
  await store.createTenant(alibabaTrialId, "DealClaw 阿里云试用", undefined, undefined, "alibaba");
const feishu = new FeishuEdge(store);
const weixin = new WeixinEdge(store);
// Portal scans hold a template in memory and create the tenant only after the
// WeChat user confirms. Ordinary channel binding still uses an existing tenant.
const pendingWeixinTemplates = new Map<string, ReturnType<typeof requireTemplate>>();
const weixinLogin = new WeixinLogin({
  bind: async (tenantId, botToken, accountId, baseUrl) => {
    const template = pendingWeixinTemplates.get(tenantId);
    if (template) {
      await store.createTenant(tenantId, `扫码创建的 ${template.name}`, undefined, undefined, 'vercel', template);
    }
    await weixin.bind(tenantId, botToken, accountId, baseUrl);
    pendingWeixinTemplates.delete(tenantId);
  },
});
const dingtalk = new DingtalkEdge(store);
const wecom = new WecomEdge(store);
// One edge per surface the runtime serves; the manager stays channel-agnostic.
const edge = new EdgeRouter([feishu, weixin, dingtalk, wecom]);
const manager = new RuntimeManager(
  store,
  new ProviderRouter({ vercel: new VercelProvider(config), alibaba: new AlibabaProvider(config) }),
  (run, text) => edge.delta(run, text),
  (run, kind, data) => edge.progress(run, kind, data),
  (run, media) => edge.media(run, media),
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
// ── DingTalk (Stream Mode) binding ────────────────────────────────────────
// Stream Mode dials out, so DingTalk needs no inbound callback URL and this
// works without a filed domain — but the socket must live in the manager,
// since the sandbox is asleep between messages.
app.post("/v1/channels/dingtalk/bind", async (req, res, next) => {
  try {
    const tenantId = req.body?.tenantId || config.trialTenantId;
    const clientId = String(req.body?.clientId || "").trim();
    const clientSecret = String(req.body?.clientSecret || "").trim();
    if (!clientId || !clientSecret) {
      res.status(400).json({ error: "CREDENTIALS_REQUIRED" });
      return;
    }
    if (!(await store.tenant(tenantId))) {
      res.status(404).json({ error: "TENANT_NOT_FOUND" });
      return;
    }
    await dingtalk.bind(tenantId, clientId, clientSecret);
    res.json({ ok: true, tenantId, clientId });
  } catch (e) {
    next(e);
  }
});
// WeCom bots are created by the customer scanning 一键创建智能机器人 in their
// own org; that scan yields the botId/secret bound here.
app.post("/v1/channels/wecom/bind", async (req, res, next) => {
  try {
    const tenantId = req.body?.tenantId || config.trialTenantId;
    const botId = String(req.body?.botId || "").trim();
    const secret = String(req.body?.secret || "").trim();
    if (!botId || !secret) {
      res.status(400).json({ error: "CREDENTIALS_REQUIRED" });
      return;
    }
    if (!(await store.tenant(tenantId))) {
      res.status(404).json({ error: "TENANT_NOT_FOUND" });
      return;
    }
    await wecom.bind(tenantId, botId, secret);
    res.json({ ok: true, tenantId, botId });
  } catch (e) {
    next(e);
  }
});
app.get("/v1/channels/:channel/status", async (req, res, next) => {
  try {
    const tenantId = String(req.query.tenantId || config.trialTenantId);
    const binding = await store.channelBinding(tenantId, req.params.channel);
    res.json({
      bound: !!binding && binding.state === "active",
      state: binding?.state ?? null,
      externalId: binding?.external_id ?? null,
      lastError: binding?.last_error ?? null,
    });
  } catch (e) {
    next(e);
  }
});
// ── WeChat (iLink) QR binding ─────────────────────────────────────────────
// The scan must happen where the poll will live, so it runs here rather than
// inside the sandbox, which is asleep between messages.
app.post("/v1/channels/weixin/portal-login", async (req, res, next) => {
  try {
    let template;
    try {
      template = requireTemplate(config, req.body?.templateId, req.body?.templateVersion);
    } catch {
      res.status(400).json({ error: 'TEMPLATE_NOT_AVAILABLE' });
      return;
    }
    const tenantId = randomUUID();
    pendingWeixinTemplates.set(tenantId, template);
    setTimeout(() => pendingWeixinTemplates.delete(tenantId), 11 * 60_000).unref();
    try {
      const session = await weixinLogin.start(tenantId);
      res.json({
        ok: true,
        sessionId: session.id,
        qrImage: session.qrImage,
        expiresIn: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
      });
    } catch (error) {
      pendingWeixinTemplates.delete(tenantId);
      throw error;
    }
  } catch (error) {
    next(error);
  }
});
app.post("/v1/channels/weixin/login", async (req, res, next) => {
  try {
    const tenantId = req.body?.tenantId || config.trialTenantId;
    if (!(await store.tenant(tenantId))) {
      res.status(404).json({ error: "TENANT_NOT_FOUND" });
      return;
    }
    const session = await weixinLogin.start(tenantId);
    res.json({
      ok: true,
      sessionId: session.id,
      qrImage: session.qrImage,
      expiresIn: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
    });
  } catch (e) {
    next(e);
  }
});
app.get("/v1/channels/weixin/login/:sessionId", (req, res) => {
  const session = weixinLogin.status(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "SESSION_NOT_FOUND" });
    return;
  }
  res.json({
    status: session.status,
    needVerifyCode: !!session.needVerifyCode,
    tenantId: session.status === 'completed' ? session.tenantId : undefined,
    accountId: session.accountId,
    error: session.error,
    expiresIn: Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)),
  });
});
app.post("/v1/channels/weixin/login/:sessionId/verify", (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) {
    res.status(400).json({ error: "CODE_REQUIRED" });
    return;
  }
  res.json({ ok: weixinLogin.submitVerifyCode(req.params.sessionId, code) });
});
app.delete("/v1/channels/weixin/login/:sessionId", (req, res) => {
  weixinLogin.cancel(req.params.sessionId);
  res.json({ ok: true });
});
app.get("/v1/templates", (_req, res) => {
  res.json({ templates: availableTemplates(config).map(({ snapshotId: _snapshotId, ...template }) => template) });
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
    let template;
    try {
      template = requireTemplate(config, req.body.templateId || "dealclaw", req.body.templateVersion);
    } catch {
      res.status(400).json({ error: "TEMPLATE_NOT_AVAILABLE" }); return;
    }
    if (runtimeProvider === "alibaba" && template.id !== "dealclaw") {
      res.status(400).json({ error: "TEMPLATE_PROVIDER_UNSUPPORTED" }); return;
    }
    const t = await store.createTenant(
      randomUUID(),
      `扫码创建的 ${template.name}`,
      botAppId,
      botAppSecret,
      runtimeProvider,
      template,
    );
    await edge.connect(t);
    res.json({ tenant: { tenantId: t.id, templateId: t.template_id, templateVersion: t.template_version } });
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
// Operator-bound runtime secrets. Values go in, never come back out; a new
// binding reaches the agent the next time its sandbox boots (after idle sleep).
app.get("/v1/tenants/:id/secrets", async (req, res, next) => {
  try {
    const t = await store.tenant(req.params.id);
    const status = await store.tenantSecretStatus(t.id);
    const required = templateSecretNames(t.template_id);
    res.json({ templateId: t.template_id, required, bound: required.length > 0 && required.every((name) => status.names.includes(name)), ...status });
  } catch (e) {
    if (e instanceof Error && e.message === "TENANT_NOT_FOUND") { res.sendStatus(404); return; }
    next(e);
  }
});
app.put("/v1/tenants/:id/secrets", async (req, res, next) => {
  try {
    const t = await store.tenant(req.params.id);
    let secrets: Record<string, string>;
    try { secrets = validateTenantSecrets(t.template_id, req.body?.secrets); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    await store.setTenantSecrets(t.id, secrets);
    await store.event(t.id, "secrets-bound", { names: Object.keys(secrets) });
    res.json({ ok: true, names: Object.keys(secrets) });
  } catch (e) {
    if (e instanceof Error && e.message === "TENANT_NOT_FOUND") { res.sendStatus(404); return; }
    next(e);
  }
});
app.delete("/v1/tenants/:id/secrets", async (req, res, next) => {
  try {
    const t = await store.tenant(req.params.id);
    await store.setTenantSecrets(t.id, {});
    await store.event(t.id, "secrets-unbound", {});
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof Error && e.message === "TENANT_NOT_FOUND") { res.sendStatus(404); return; }
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
// A component inside a sandbox (proxied from the public Portal) continues a conversation.
app.post("/v1/tenants/:id/wake", async (req, res) => {
  try {
    res.json(await manager.wakeSession(req.params.id, String(req.query.sig ?? ""), req.body ?? {}));
  } catch (e) {
    const code = e instanceof Error ? e.message : "WAKE_FAILED";
    res.status(/INVALID|NOT_FOUND/.test(code) ? 404 : 503).json({ error: /^[A-Z_]+$/.test(code) ? code : "WAKE_FAILED" });
  }
});
// Signed owner link (proxied from the public Portal): wake and return the service URL.
app.get("/v1/tenants/:id/open/:service", async (req, res) => {
  try {
    res.json({ url: await manager.open(req.params.id, req.params.service, String(req.query.sig ?? "")) });
  } catch (e) {
    const code = e instanceof Error ? e.message : "OPEN_FAILED";
    res.status(code === "OPEN_LINK_INVALID" || code === "TENANT_NOT_FOUND" ? 404 : code === "AGENT_BUSY" ? 409 : 503).json({ error: /^[A-Z_]+$/.test(code) ? code : "OPEN_FAILED" });
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
