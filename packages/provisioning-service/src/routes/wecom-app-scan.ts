/**
 * WeCom (企业微信) app scan-to-fetch routes (admin console).
 *
 * Lets the admin SPA obtain WeCom bot credentials by QR scan:
 *   POST /v1/admin/wecom-app/scan/start            → { scode, qrDataUri, scanPageUrl, expireIn }
 *   GET  /v1/admin/wecom-app/scan/status/:scode    → { status, result?{botId,secret} }
 *   POST /v1/admin/wecom-app/scan/cancel           → { ok }
 *
 * Auth: same service-token / admin-JWT middleware as every other route.
 * Nothing is persisted here — the SPA feeds the credentials into the existing
 * WeCom binding form, whose backend still stores the secret in the K8s Secret
 * (never the DB).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { ProvisioningConfig } from '../config.js';
import {
  WeComAppScanStore,
  WeComAppScanError,
  scanStatusMessage,
  QR_EXPIRE_SECONDS,
} from '../services/wecom-app-scan.js';

export function createWeComAppScanRoutes(
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
  store?: WeComAppScanStore,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  const scanStore =
    store ??
    new WeComAppScanStore({
      source: config.wecomScanSource,
      plat: config.wecomScanPlat,
    });

  router.post('/v1/admin/wecom-app/scan/start', async (_req: Request, res: Response) => {
    try {
      const session = await scanStore.start();
      res.json({
        ok: true,
        scode: session.scode,
        qrDataUri: session.qrDataUri,
        scanPageUrl: session.scanPageUrl,
        expireIn: QR_EXPIRE_SECONDS,
        status: session.status,
      });
    } catch (err: unknown) {
      if (err instanceof WeComAppScanError) {
        res.status(err.status).json({ code: err.code, message: err.message });
        return;
      }
      console.error('[wecom-app-scan] start error:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
    }
  });

  router.get('/v1/admin/wecom-app/scan/status/:scode', async (req: Request, res: Response) => {
    try {
      const session = await scanStore.poll(req.params.scode);
      res.json({
        ok: true,
        scode: session.scode,
        status: session.status,
        message: scanStatusMessage(session),
        result:
          session.status === 'completed' && session.botId && session.secret
            ? { botId: session.botId, secret: session.secret }
            : undefined,
        error: session.error || undefined,
      });
    } catch (err: unknown) {
      if (err instanceof WeComAppScanError) {
        res.status(err.status).json({ code: err.code, message: err.message });
        return;
      }
      console.error('[wecom-app-scan] status error:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
    }
  });

  router.post('/v1/admin/wecom-app/scan/cancel', (req: Request, res: Response) => {
    const { scode } = req.body || {};
    if (!scode || typeof scode !== 'string') {
      res.status(400).json({ code: 'INVALID_INPUT', message: 'scode is required' });
      return;
    }
    const ok = scanStore.cancel(scode);
    if (!ok) {
      res.status(404).json({ code: 'NOT_FOUND', message: '扫码会话不存在或已过期' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
