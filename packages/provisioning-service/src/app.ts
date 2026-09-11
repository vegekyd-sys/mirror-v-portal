import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pg from 'pg';
import { createTenantRoutes } from './routes/tenants.js';
import { createRuntimeConfigRoutes } from './routes/runtime-configs.js';
import { createAdminOpsRoutes } from './routes/admin-ops.js';
import { createFeishuAppScanRoutes } from './routes/feishu-app-scan.js';
import { createWeChatBindingRoutes } from './routes/wechat-binding.js';
import { createExternalApiRoutes } from './routes/external-api.js';
import { createConversationExternalRoutes } from './routes/conversation-external.js';
import { createChatExternalRoutes } from './routes/chat-external.js';
import { createPodConsoleRoutes } from './routes/pod-console.js';
import { createChatMessageRoutes } from './routes/chat-messages.js';
import { createLlmPushRoutes } from './routes/llm-push.js';
import type { ProvisioningConfig } from './config.js';
import { SseBroker } from './services/sse-broker.js';
import { createServiceOrAdminAuthMiddleware } from './middleware/auth.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAuditMiddleware } from './services/audit.js';
import { createTenantMachineAssertionRoutes } from './routes/tenant-machine-assertions.js';

export function createApp(pool: pg.Pool, config: ProvisioningConfig, broker: SseBroker = new SseBroker()) {
  const app = express();

  app.use(helmet());
  // NB2/NB8 FIX: restrict CORS to known origins
  app.use(cors({
    origin: process.env.CORS_ORIGIN || false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  }));
  app.use(express.json({ limit: '1mb' }));

  // Health check (no auth)
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'provisioning-service', version: '0.1.0' });
  });

  // NB2 FIX: Add Bearer token auth to all tenant routes.
  // Accepts the shared service token (internal callers) OR a valid admin
  // JWT (pure-frontend admin SPA calling directly, no proxy in front).
  const auth = createServiceOrAdminAuthMiddleware('PROVISIONING_API_TOKEN');
  const serviceAuth = createAuthMiddleware('PROVISIONING_API_TOKEN');

  // Audit: every non-GET auth-passed request is auto-recorded (actor, path,
  // redacted body, status). Chained AFTER auth so req.adminUser is set; high-
  // risk handlers additionally write explicit old→new rows via writeAuditLog.
  const audit = createAuditMiddleware(pool);
  const authAndAudit: typeof auth = (req, res, next) => {
    auth(req, res, () => audit(req, res, next));
  };

  // External API routes — third-party API key auth (managed in admin console).
  // MUST be mounted BEFORE the auth-protected routers below: those routers
  // call router.use(authMiddleware) (no path), which would otherwise block
  // /api/external/* with the admin/service-token gate before it reaches here.
  app.use(createExternalApiRoutes(pool, config));
  // External conversation-log pull endpoint (米奥 Agent 对话日志拉取) — same
  // external API-key auth + supplier→tenant isolation as supplier-summary above.
  app.use(createConversationExternalRoutes(pool, config));
  // External chat conversation endpoint (dlck_ apikey auth) — third-party
  // HTTP access to the agent. Mounted before the authAndAudit routers for
  // the same reason as the external-api routes above (its Bearer key is not
  // a service/admin token).
  app.use(createChatExternalRoutes(pool, config));

  // Internal machine assertion verification is service-token-only. Tenant
  // machines still need their own per-tenant HMAC; this shared token alone
  // grants no binding authority and no secret is returned.
  app.use(createTenantMachineAssertionRoutes(pool, serviceAuth));

  app.use(createTenantRoutes(pool, config, authAndAudit));
  app.use(createRuntimeConfigRoutes(pool, config, authAndAudit));
  // LLM push async task (SSE + REST) — worker publishes progress to the same
  // broker instance injected here from index.ts.
  app.use(createLlmPushRoutes(pool, broker, authAndAudit));
  app.use(createAdminOpsRoutes(pool, config, authAndAudit));
  // Pod logs (admin console) — GET /v1/tenants/:id/logs[/stream]. The pod
  // terminal (exec) is NOT here: it is a WebSocket and attaches to the HTTP
  // server directly in index.ts (see ws/pod-exec.ts).
  app.use(createPodConsoleRoutes(pool, config, authAndAudit));
  // Chat message log — ingest from the in-agent dealclaw-chatlog plugin +
  // conversation-history queries for the admin console. (The ingest endpoint
  // is high-volume machine traffic and is excluded from the audit net.)
  app.use(createChatMessageRoutes(pool, config, authAndAudit));
  // Feishu app QR-scan (registerApp device flow) — credentials-only,
  // feeds the customer-creation / feishu-binding forms in the admin SPA.
  app.use(createFeishuAppScanRoutes(authAndAudit));
  // WeChat (personal WeChat) binding — QR-login direct connection.
  app.use(createWeChatBindingRoutes(pool, config, authAndAudit));

  // 404 fallback
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  });

  return app;
}
