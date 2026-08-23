import { describe, it, expect } from 'vitest';

/**
 * FeishuAppScanStore unit tests — registerApp is injected as a fake, so no
 * network access ever happens. Route tests mount the router with the real
 * store + fake SDK so the HTTP surface is covered too.
 */
import {
  FeishuAppScanStore,
  FeishuAppScanError,
  SCAN_SESSION_TTL_MS,
  COMPLETED_RETENTION_MS,
  MAX_ACTIVE_SESSIONS,
  type FeishuAppScanSession,
  type RegisterAppFn,
} from '../services/feishu-app-scan.js';
import { createFeishuAppScanRoutes } from '../routes/feishu-app-scan.js';

let seq = 0;

/**
 * Fake registerApp. Emits a UNIQUE QR per call (mirrors the real SDK),
 * then either resolves with credentials, rejects, or waits for abort.
 */
function makeFakeRegisterApp(opts: {
  resolve?: { client_id: string; client_secret: string };
  reject?: { code: string; message: string };
  noQR?: boolean;
  onAbort?: boolean;
} = {}): RegisterAppFn {
  return (handlers) =>
    new Promise((resolve, reject) => {
      if (!opts.noQR) {
        const code = `DC${++seq}`;
        handlers.onQRCodeReady({ url: `https://open.feishu.cn/device?user_code=${code}`, expireIn: 600 });
        handlers.onStatusChange({ status: 'polling' });
      }
      if (opts.reject) {
        reject(opts.reject);
        return;
      }
      if (opts.onAbort) {
        handlers.signal.addEventListener('abort', () => reject({ code: 'abort', message: 'aborted' }));
        return; // only settles via abort
      }
      setTimeout(() => resolve(opts.resolve ?? { client_id: 'cli_test123', client_secret: 'secretXXX' }), 0);
    });
}

describe('FeishuAppScanStore', () => {
  it('start() exposes the QR while registration is still pending', async () => {
    const fake = deferredFake();
    const store = new FeishuAppScanStore(fake.impl);
    const session = await store.start();
    expect(session.deviceCode).toMatch(/^DC\d+$/);
    expect(session.qrUrl).toContain(`user_code=${session.deviceCode}`);
    expect(session.qrDataUri).toMatch(/^data:image\/png;base64,/);
    expect(session.status).toBe('pending');

    fake.complete();
    await session._completionPromise;
    expect(session.status).toBe('completed');
    expect(session.appId).toBe('cli_test123');
    expect(session.appSecret).toBe('secretXXX');
    expect(store.get(session.deviceCode)?.status).toBe('completed');
  });

  it('throws REGISTER_FAILED when registerApp fails before emitting a QR', async () => {
    const store = new FeishuAppScanStore(
      makeFakeRegisterApp({ noQR: true, reject: { code: 'network', message: 'no egress' } }),
    );
    await expect(store.start()).rejects.toMatchObject({ code: 'REGISTER_FAILED' });
  });

  it('marks the session failed when the customer denies / Feishu errors', async () => {
    const store = new FeishuAppScanStore(
      makeFakeRegisterApp({ reject: { code: 'access_denied', message: 'User denied access' } }),
    );
    const session = await store.start();
    await session._completionPromise;
    expect(session.status).toBe('failed');
    expect(session.error).toContain('access_denied');
  });

  it('cancel() aborts a pending scan and the session reports cancelled', async () => {
    const store = new FeishuAppScanStore(makeFakeRegisterApp({ onAbort: true }));
    const session = await store.start();
    expect(store.cancel(session.deviceCode)).toBe(true);
    await session._completionPromise;
    expect(store.get(session.deviceCode)?.status).toBe('cancelled');
    expect(store.cancel('nope')).toBe(false);
  });

  it('get() returns undefined for unknown / swept sessions', async () => {
    const store = new FeishuAppScanStore(makeFakeRegisterApp());
    expect(store.get('missing')).toBeUndefined();

    const session = await store.start();
    // Simulate TTL expiry: started 21 minutes ago.
    (store as any).sessions.get(session.deviceCode).startedAt = new Date(Date.now() - SCAN_SESSION_TTL_MS - 60_000);
    expect(store.get(session.deviceCode)).toBeUndefined();
  });

  it('sweep() keeps completed sessions briefly, then removes them', async () => {
    const store = new FeishuAppScanStore(makeFakeRegisterApp());
    const session = await store.start();
    await session._completionPromise;
    expect(store.get(session.deviceCode)?.status).toBe('completed');

    const done = store.get(session.deviceCode)!;
    done.completedAt = new Date(Date.now() - COMPLETED_RETENTION_MS - 60_000);
    expect(store.get(session.deviceCode)).toBeUndefined();
  });

  it('caps concurrent pending sessions', async () => {
    const store = new FeishuAppScanStore(makeFakeRegisterApp({ onAbort: true }));
    for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) {
      await store.start();
    }
    await expect(store.start()).rejects.toBeInstanceOf(FeishuAppScanError);
  });
});

// ── Route surface ──────────────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';

function makeApp(store: FeishuAppScanStore) {
  const app = express();
  app.use(express.json());
  app.use(createFeishuAppScanRoutes(undefined, store));
  return app;
}

/** Fake that stays pending until `complete()` is called explicitly. */
function deferredFake() {
  let resolveFn!: (v: { client_id: string; client_secret: string }) => void;
  const impl: RegisterAppFn = (handlers) =>
    new Promise((resolve) => {
      const code = `DC${++seq}`;
      handlers.onQRCodeReady({ url: `https://open.feishu.cn/device?user_code=${code}`, expireIn: 600 });
      resolveFn = resolve;
    });
  return {
    impl,
    complete: () => resolveFn({ client_id: 'cli_test123', client_secret: 'secretXXX' }),
  };
}

describe('feishu-app-scan routes', () => {
  it('start → status(pending) → status(completed with credentials)', async () => {
    const fake = deferredFake();
    const store = new FeishuAppScanStore(fake.impl);
    const app = makeApp(store);

    const start = await request(app).post('/v1/admin/feishu-app/scan/start').expect(200);
    expect(start.body.ok).toBe(true);
    const deviceCode: string = start.body.deviceCode;
    expect(deviceCode).toMatch(/^DC\d+$/);
    expect(start.body.qrDataUri).toMatch(/^data:image\/png;base64,/);

    const pending = await request(app)
      .get(`/v1/admin/feishu-app/scan/status/${deviceCode}`)
      .expect(200);
    expect(pending.body.status).toBe('pending');
    expect(pending.body.result).toBeUndefined();

    fake.complete();
    await new Promise((r) => setTimeout(r, 10));

    const done = await request(app)
      .get(`/v1/admin/feishu-app/scan/status/${deviceCode}`)
      .expect(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.result).toEqual({ appId: 'cli_test123', appSecret: 'secretXXX' });
  });

  it('status 404 for unknown deviceCode', async () => {
    const app = makeApp(new FeishuAppScanStore(makeFakeRegisterApp()));
    await request(app).get('/v1/admin/feishu-app/scan/status/nope').expect(404);
  });

  it('cancel requires deviceCode and reports unknown sessions', async () => {
    const app = makeApp(new FeishuAppScanStore(makeFakeRegisterApp()));
    await request(app).post('/v1/admin/feishu-app/scan/cancel').send({}).expect(400);
    await request(app).post('/v1/admin/feishu-app/scan/cancel').send({ deviceCode: 'x' }).expect(404);
  });
});
