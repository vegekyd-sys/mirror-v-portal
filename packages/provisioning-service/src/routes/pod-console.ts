/**
 * Pod console routes — per-tenant pod logs (admin console feature).
 *
 * - GET /v1/tenants/:tenantId/logs          one-shot log fetch (JSON)
 * - GET /v1/tenants/:tenantId/logs/stream   chunked live log stream
 *
 * The interactive terminal (exec) is served over WebSocket on
 * /v1/tenants/:tenantId/exec — see src/ws/pod-exec.ts (Express cannot
 * handle WS upgrades, so it is attached to the HTTP server directly).
 *
 * Security: tenantId must be a 32-hex UUID, pod/container names must be
 * RFC 1123, and the pod is verified to exist in the tenant's namespace with
 * the dealclaw.io/tenant-id label before any log bytes are returned.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { Readable } from 'node:stream';
import {
  getPodLogs,
  getTenantPod,
  isSafeK8sName,
  isSafeTenantId,
  streamPodLogs,
} from '../services/k8s-client.js';
import { tenantNamespace } from '../services/provisioning.js';
import type { ProvisioningConfig } from '../config.js';

interface PodConsoleRouteError extends Error {
  status?: number;
  code?: string;
}

/** Respond 400/404 for validation failures instead of 500. */
function handleConsoleError(res: Response, err: unknown) {
  const e = err as PodConsoleRouteError;
  const status = e?.status || 500;
  const code = e?.code || (status === 404 ? 'NOT_FOUND' : 'INTERNAL');
  if (status >= 500) console.error('[pod-console]', e?.message || err);
  res.status(status).json({ code, message: e?.message || 'Internal error' });
}

export function createPodConsoleRoutes(
  _pool: import('pg').Pool,
  _config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  // Validate path params + resolve the tenant namespace.
  function resolveTarget(req: Request, res: Response): { namespace: string; pod: string; container?: string } | null {
    const { tenantId } = req.params as { tenantId: string };
    const pod = String(req.query.pod ?? '');
    const container = req.query.container ? String(req.query.container) : undefined;

    if (!isSafeTenantId(tenantId)) {
      res.status(400).json({ code: 'BAD_TENANT_ID', message: 'tenantId 必须是 32 位十六进制 UUID' });
      return null;
    }
    if (!isSafeK8sName(pod)) {
      res.status(400).json({ code: 'BAD_POD_NAME', message: 'pod 名称不合法（RFC 1123）' });
      return null;
    }
    if (container !== undefined && !isSafeK8sName(container)) {
      res.status(400).json({ code: 'BAD_CONTAINER_NAME', message: 'container 名称不合法（RFC 1123）' });
      return null;
    }
    return { namespace: tenantNamespace(tenantId), pod, container };
  }

  // GET /v1/tenants/:tenantId/logs?pod=&container=&tailLines=&sinceSeconds=&timestamps=
  router.get('/v1/tenants/:tenantId/logs', async (req: Request, res: Response) => {
    try {
      const target = resolveTarget(req, res);
      if (!target) return;

      // Verify the pod exists and belongs to this tenant.
      const { tenantId } = req.params as { tenantId: string };
      const pod = await getTenantPod(target.namespace, tenantId, target.pod);
      if (!pod) {
        res.status(404).json({ code: 'POD_NOT_FOUND', message: 'Pod 不存在或不属于该租户' });
        return;
      }

      const tailLines = req.query.tailLines ? Number(req.query.tailLines) : undefined;
      const sinceSeconds = req.query.sinceSeconds ? Number(req.query.sinceSeconds) : undefined;
      const timestamps = req.query.timestamps === 'true' || req.query.timestamps === '1';
      const text = await getPodLogs(target.namespace, target.pod, {
        container: target.container,
        tailLines: Number.isFinite(tailLines as number) ? (tailLines as number) : undefined,
        sinceSeconds: Number.isFinite(sinceSeconds as number) ? (sinceSeconds as number) : undefined,
        timestamps,
      });
      res.json({ logs: text, namespace: target.namespace, pod: target.pod, container: target.container ?? null });
    } catch (err) {
      handleConsoleError(res, err);
    }
  });

  // GET /v1/tenants/:tenantId/logs/stream?pod=&container=&tailLines=&follow=&timestamps=
  // Chunked text/plain stream — replays the last tailLines then follows live
  // when follow=true. Client disconnect aborts the upstream apiserver fetch.
  router.get('/v1/tenants/:tenantId/logs/stream', async (req: Request, res: Response) => {
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
      const target = resolveTarget(req, res);
      if (!target) return;

      const { tenantId } = req.params as { tenantId: string };
      const pod = await getTenantPod(target.namespace, tenantId, target.pod);
      if (!pod) {
        res.status(404).json({ code: 'POD_NOT_FOUND', message: 'Pod 不存在或不属于该租户' });
        return;
      }

      const tailLines = req.query.tailLines ? Number(req.query.tailLines) : 500;
      const follow = req.query.follow !== 'false' && req.query.follow !== '0';
      const timestamps = req.query.timestamps === 'true' || req.query.timestamps === '1';

      const upstream = await streamPodLogs(
        target.namespace,
        target.pod,
        {
          container: target.container,
          tailLines: Number.isFinite(tailLines) ? tailLines : 500,
          timestamps,
        },
        ac.signal,
      );

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => '');
        res.status(502).json({ code: 'UPSTREAM_ERROR', message: `apiserver ${upstream.status}: ${errText.slice(0, 300)}` });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });

      const body = Readable.fromWeb(upstream.body as any);
      body.on('data', (chunk: Buffer) => res.write(chunk));
      body.on('end', () => res.end());
      body.on('error', (err) => {
        console.error('[pod-console] stream error:', err?.message);
        res.end();
      });
    } catch (err) {
      if (ac.signal.aborted) return; // client went away — normal
      handleConsoleError(res, err);
    }
  });

  return router;
}
