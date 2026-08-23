/**
 * Feishu app scan-to-fetch routes (admin console).
 *
 * Lets the admin SPA obtain Feishu app credentials by QR scan:
 *   POST /v1/admin/feishu-app/scan/start          → { deviceCode, qrDataUri, expireIn }
 *   GET  /v1/admin/feishu-app/scan/status/:deviceCode → { status, result?{appId,appSecret} }
 *   POST /v1/admin/feishu-app/scan/cancel         → { ok }
 *
 * Auth: same service-token / admin-JWT middleware as every other route.
 * Nothing is persisted here — the SPA feeds the credentials into the
 * existing customer-creation / feishu-binding forms, whose backends still
 * verify them against the Feishu open API before anything is stored.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  FeishuAppScanStore,
  FeishuAppScanError,
  scanStatusMessage,
} from '../services/feishu-app-scan.js';

export function createFeishuAppScanRoutes(
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
  store: FeishuAppScanStore = new FeishuAppScanStore(),
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  router.post('/v1/admin/feishu-app/scan/start', async (_req: Request, res: Response) => {
    try {
      const session = await store.start();
      res.json({
        ok: true,
        deviceCode: session.deviceCode,
        qrUrl: session.qrUrl,
        qrDataUri: session.qrDataUri,
        expireIn: session.expireIn,
        status: session.status,
      });
    } catch (err: unknown) {
      if (err instanceof FeishuAppScanError) {
        res.status(err.status).json({ code: err.code, message: err.message });
        return;
      }
      console.error('[feishu-app-scan] start error:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
    }
  });

  router.get('/v1/admin/feishu-app/scan/status/:deviceCode', (req: Request, res: Response) => {
    const session = store.get(req.params.deviceCode);
    if (!session) {
      res.status(404).json({ code: 'NOT_FOUND', message: '扫码会话不存在或已过期，请重新发起' });
      return;
    }
    res.json({
      ok: true,
      deviceCode: session.deviceCode,
      status: session.status,
      message: scanStatusMessage(session),
      result:
        session.status === 'completed' && session.appId && session.appSecret
          ? { appId: session.appId, appSecret: session.appSecret }
          : undefined,
      error: session.error || undefined,
    });
  });

  router.post('/v1/admin/feishu-app/scan/cancel', (req: Request, res: Response) => {
    const { deviceCode } = req.body || {};
    if (!deviceCode || typeof deviceCode !== 'string') {
      res.status(400).json({ code: 'INVALID_INPUT', message: 'deviceCode is required' });
      return;
    }
    const ok = store.cancel(deviceCode);
    if (!ok) {
      res.status(404).json({ code: 'NOT_FOUND', message: '扫码会话不存在或已过期' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
