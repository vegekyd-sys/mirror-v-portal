// HTTP face of the VSync broker. The Gateway forwards /onboard/vsync/v1/* here;
// callers identify with x-vsync-agent / x-vsync-token (see vsync-hub.ts).
import express from "express";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { HubRepo, tenantAgentId, VsyncBroker, VsyncError } from "./vsync-hub.js";

export function vsyncRoutes(config: Config, store: Store) {
  const router = express.Router();
  const cfg = config.vsync;
  let known: { at: number; ids: Set<string> } = { at: 0, ids: new Set() };
  const broker = cfg ? new VsyncBroker(cfg, config.encryptionKey, new HubRepo(cfg), async (agent) => {
    if (Date.now() - known.at > 60_000) {
      const templates = cfg.templates?.length ? cfg.templates : ["mirror-v-full"];
      const rows = (await store.pool.query<{ id: string }>("SELECT id FROM elastic_tenants WHERE template_id = ANY($1)", [templates])).rows;
      known = { at: Date.now(), ids: new Set(rows.map((r) => tenantAgentId(cfg, r.id))) };
    }
    return known.ids.has(agent);
  }) : null;
  const handle = (fn: (caller: { agent: string }, req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        if (!broker) throw new VsyncError("VSYNC_DISABLED", 404);
        const caller = await broker.authenticate(req.get("x-vsync-agent"), req.get("x-vsync-token"));
        const out = await fn(caller, req, res);
        if (out !== undefined) res.set("cache-control", "no-store").json(out);
      } catch (e) {
        const known = e instanceof VsyncError;
        if (!known) console.error("[vsync]", e instanceof Error ? e.message.split("\n")[0] : "failed");
        res.status(known ? e.status : 503).json({ error: known ? e.code : "VSYNC_FAILED" });
      }
    };
  router.use(express.json({ limit: "1mb" }));
  router.get("/whoami", handle(async (c) => broker!.whoami(c)));
  router.get("/inbox", handle(async (c) => broker!.inbox(c)));
  router.get("/acks", handle(async (c) => broker!.acks(c)));
  router.get("/replies", handle(async (c) => broker!.replies(c)));
  router.get("/packages", handle(async (c) => broker!.packages(c)));
  router.get("/file", handle(async (c, req, res) => {
    const body = await broker!.file(c, req.query.path);
    res.set({ "content-type": "application/octet-stream", "cache-control": "no-store" }).send(body);
    return undefined;
  }));
  router.post("/ack", handle(async (c, req) => broker!.ack(c, req.body?.row ?? req.body)));
  router.post("/send", handle(async (c, req) => broker!.send(c, req.body)));
  return router;
}
