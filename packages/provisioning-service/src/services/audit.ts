/**
 * Audit log — every mutating admin/tenant operation gets a row in audit_logs.
 *
 * Two capture layers (see routes/admin-ops.ts + the promote incident of
 * 2026-08-31 for the motivation):
 *   1. Global Express middleware (createAuditMiddleware): auto-records every
 *      non-GET request that passed auth — actor, method, path, redacted body,
 *      status, duration. Coverage net for anything not explicitly audited.
 *   2. Explicit writes from high-risk handlers (writeAuditLog): the same table
 *      but with old→new value snapshots (e.g. image-release promote records
 *      the previous rollout target; tenant status changes record from/to).
 *
 * Both writes are fire-and-forget: a failed audit INSERT logs to stderr and
 * never fails the user request.
 *
 * Retention: pruneAuditLogs(days=180), called from the periodic maintenance
 * loop (index.ts, same cadence as registry sync).
 */
import type { Request, Response, NextFunction } from 'express';
import type pg from 'pg';

/** Key names whose values must never land in the audit trail (case-insensitive). */
const SENSITIVE_KEY_RE = /(api[-_]?key|secret|password|token|credential|authorization|cookie)/i;
/** Max recursion depth / body size guard for redaction. */
const MAX_REDACT_DEPTH = 6;

export type ActorType = 'admin' | 'service' | 'external';

export interface AuditEntry {
  actor: string;
  actorType: ActorType;
  action: string;
  method?: string;
  path?: string;
  resourceType?: string;
  resourceId?: string;
  tenantId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  statusCode?: number;
  durationMs?: number;
  ip?: string;
  requestId?: string;
}

/** Redact sensitive values in a JSON-ish structure (objects, arrays, nested). */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? (v == null ? v : '***') : redactSensitive(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return value.slice(0, 2000) + '…';
  return value;
}

/** Actor identity from the authenticated request (admin JWT or service token). */
export function actorFromRequest(req: Request): { actor: string; actorType: ActorType } {
  const u = (req as any).adminUser;
  if (u && (u.username || u.sub)) {
    return { actor: String(u.username || u.sub), actorType: 'admin' };
  }
  return { actor: 'service-token', actorType: 'service' };
}

/**
 * Derive a semantic action name from method + path, e.g.
 *   POST /v1/tenants                → tenant.create
 *   PATCH /v1/tenants/:id/status    → tenant.status.update
 *   POST /v1/admin/image-releases/promote → image-release.promote
 *   DELETE /v1/admin/external-api-keys/:id → external-api-key.delete
 */
export function deriveAction(method: string, pathName: string): string {
  const verb = method === 'DELETE' ? 'delete' : method === 'POST' ? 'create' : 'update';
  const seg = pathName.split('/').filter(Boolean);

  // /v1/admin/* — service-specific actions
  if (seg[0] === 'v1' && seg[1] === 'admin') {
    if (seg[2] === 'image-releases' && seg[3] === 'promote') return 'image-release.promote';
    if (seg[2] === 'image-releases' && seg[3] === 'sync') return 'image-release.sync';
    if (seg[2] === 'llm-providers' && seg[3] === 'selection') return 'llm-provider.selection';
    if (seg[2] === 'llm-providers') return `llm-provider.${verb}`;
    if (seg[2] === 'runtime-configs') return `runtime-config.${verb}`;
    if (seg[2] === 'external-api-keys') return `external-api-key.${verb}`;
    if (seg[2] === 'feishu-app' && seg[3] === 'scan') return `feishu-app-scan.${seg[4] ?? 'start'}`;
    if (seg[2] === 'tenants' && seg[4] === 'chat') return 'tenant.chat-proxy';
    return `${seg.slice(2).join('-')}.${verb}`;
  }

  // /v1/tenants/batch/*
  if (seg[0] === 'v1' && seg[1] === 'tenants' && seg[2] === 'batch') {
    return `tenant.batch-${seg.slice(3).join('-')}`;
  }

  // /v1/tenants/:id[/sub...]
  if (seg[0] === 'v1' && seg[1] === 'tenants') {
    const sub = seg.slice(3).filter((s) => !s.startsWith(':'));
    return sub.length ? `tenant.${sub.join('-')}.${verb}` : `tenant.${verb}`;
  }

  return pathName;
}

/** Extract the tenant id path param (/v1/tenants/<id>/...) when present. */
function tenantIdFromPath(pathName: string): string | undefined {
  const seg = pathName.split('/').filter(Boolean);
  if (seg[0] === 'v1' && seg[1] === 'tenants' && seg[2] && !seg[2].startsWith(':') && seg[2] !== 'batch') {
    return seg[2];
  }
  return undefined;
}

/** Fire-and-forget audit write; failures are logged, never thrown. */
export async function writeAuditLog(pool: pg.Pool, entry: AuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs
         (actor, actor_type, action, method, path, resource_type, resource_id,
          tenant_id, old_value, new_value, status_code, duration_ms, ip, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        entry.actor,
        entry.actorType,
        entry.action,
        entry.method ?? null,
        entry.path ?? null,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.tenantId ?? null,
        entry.oldValue === undefined ? null : JSON.stringify(redactSensitive(entry.oldValue)),
        entry.newValue === undefined ? null : JSON.stringify(redactSensitive(entry.newValue)),
        entry.statusCode ?? null,
        entry.durationMs ?? null,
        entry.ip ?? null,
        entry.requestId ?? null,
      ],
    );
  } catch (err: unknown) {
    console.error(
      '[audit] failed to write audit log:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Endpoints that must not hit the audit net (high-volume machine ingest). */
const AUDIT_PATH_EXCLUSIONS = [
  // dealclaw-chatlog plugin fire-and-forget ingest — every chat message.
  /^\/v1\/tenants\/[^/]+\/chat-messages$/,
];

/**
 * Path-specific body sanitizers for the middleware net: fields that generic
 * key-name redaction cannot catch. Each returns a SHALLOW COPY — the original
 * req.body must never be mutated.
 */
const BODY_SANITIZERS: Array<{ re: RegExp; sanitize: (body: any) => any }> = [
  {
    // PUT /v1/admin/runtime-configs: `value` is a generic key name, but when
    // isSecret=true it carries the plaintext secret — mask it.
    re: /^\/v1\/admin\/runtime-configs$/,
    sanitize: (body) =>
      body && typeof body === 'object' && body.isSecret === true
        ? { ...body, value: '***' }
        : body,
  },
];

/**
 * Global audit middleware: records every non-GET, auth-passed request with a
 * redacted body snapshot. Mounted AFTER auth (so req.adminUser is set) and
 * per-router in app.ts.
 */
export function createAuditMiddleware(pool: pg.Pool) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const pathName = req.path;
    if (
      req.method === 'GET' ||
      req.method === 'HEAD' ||
      req.method === 'OPTIONS' ||
      AUDIT_PATH_EXCLUSIONS.some((re) => re.test(pathName))
    ) {
      next();
      return;
    }

    const start = Date.now();
    const { actor, actorType } = actorFromRequest(req);
    const requestId = (req.headers['x-request-id'] as string) || undefined;

    res.on('finish', () => {
      const sanitizer = BODY_SANITIZERS.find((s) => s.re.test(pathName));
      const rawBody = sanitizer ? sanitizer.sanitize(req.body) : req.body;
      const entry: AuditEntry = {
        actor,
        actorType,
        action: deriveAction(req.method, pathName),
        method: req.method,
        path: pathName,
        tenantId: tenantIdFromPath(pathName),
        newValue: redactSensitive(rawBody),
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        ip: req.ip,
        requestId,
      };
      void writeAuditLog(pool, entry);
    });

    next();
  };
}

/** Retention: delete audit rows older than `days` (default 180). */
export async function pruneAuditLogs(pool: pg.Pool, days = 180): Promise<number> {
  try {
    const result = await pool.query(
      'DELETE FROM audit_logs WHERE created_at < NOW() - ($1 || \' days\')::interval',
      [String(days)],
    );
    return result.rowCount ?? 0;
  } catch (err: unknown) {
    console.error(
      '[audit] prune failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}
