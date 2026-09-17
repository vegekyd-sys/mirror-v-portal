/**
 * DingTalk (钉钉) app scan-to-create routes (admin console).
 *
 * Lets the admin SPA obtain DingTalk bot credentials by QR scan:
 *   POST /v1/admin/dingtalk-app/scan/start               → { deviceCode, qrDataUri, verificationUriComplete, expireIn }
 *   GET  /v1/admin/dingtalk-app/scan/status/:deviceCode  → { status, result?{clientId,clientSecret} }
 *   POST /v1/admin/dingtalk-app/scan/cancel              → { ok }
 *
 * Auth: same service-token / admin-JWT middleware as every other route.
 * Nothing is persisted here — the SPA feeds the credentials into the existing
 * DingTalk binding form, whose backend still stores the secret in the K8s Secret
 * (never the DB).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { ProvisioningConfig } from '../config.js';
import {
  DingTalkAppScanStore,
  DingTalkAppScanError,
  scanStatusMessage,
} from '../services/dingtalk-app-scan.js';

export function createDingTalkAppScanRoutes(
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
  store?: DingTalkAppScanStore,
) {
  const router = Router();
  if (authMiddleware) router.use(authMiddleware);

  const scanStore =
    store ??
    new DingTalkAppScanStore({
      source: config.dingtalkScanSource,
      baseUrl: config.dingtalkScanBaseUrl,
    });

  router.post('/v1/admin/dingtalk-app/scan/start', async (_req: Request, res: Response) => {
    try {
      const session = await scanStore.start();
      res.json({
        ok: true,
        deviceCode: session.deviceCode,
        userCode: session.userCode,
        verificationUri: session.verificationUri,
        verificationUriComplete: session.verificationUriComplete,
        qrDataUri: session.qrDataUri,
        expireIn: session.expireIn,
        status: session.status,
      });
    } catch (err: unknown) {
      if (err instanceof DingTalkAppScanError) {
        res.status(err.status).json({ code: err.code, message: err.message });
        return;
      }
      console.error('[dingtalk-app-scan] start error:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
    }
  });

  router.get('/v1/admin/dingtalk-app/scan/status/:deviceCode', async (req: Request, res: Response) => {
    try {
      const session = await scanStore.poll(req.params.deviceCode);
      res.json({
        ok: true,
        deviceCode: session.deviceCode,
        status: session.status,
        message: scanStatusMessage(session),
        result:
          session.status === 'completed' && session.clientId && session.clientSecret
            ? { clientId: session.clientId, clientSecret: session.clientSecret }
            : undefined,
        error: session.error || undefined,
      });
    } catch (err: unknown) {
      if (err instanceof DingTalkAppScanError) {
        res.status(err.status).json({ code: err.code, message: err.message });
        return;
      }
      console.error('[dingtalk-app-scan] status error:', err);
      res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
    }
  });

  router.post('/v1/admin/dingtalk-app/scan/cancel', (req: Request, res: Response) => {
    const { deviceCode } = req.body || {};
    if (!deviceCode || typeof deviceCode !== 'string') {
      res.status(400).json({ code: 'INVALID_INPUT', message: 'deviceCode is required' });
      return;
    }
    const ok = scanStore.cancel(deviceCode);
    if (!ok) {
      res.status(404).json({ code: 'NOT_FOUND', message: '扫码会话不存在或已过期' });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
