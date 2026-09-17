import { describe, it, expect } from 'vitest';

import {
  DingTalkAppScanStore,
  DingTalkAppScanError,
  SCAN_SESSION_TTL_MS,
  COMPLETED_RETENTION_MS,
  MAX_ACTIVE_SESSIONS,
  scanStatusMessage,
} from '../services/dingtalk-app-scan.js';
import { createDingTalkAppScanRoutes } from '../routes/dingtalk-app-scan.js';
import type { ProvisioningConfig } from '../config.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface FakeFetch {
  fn: FetchLike;
  calls: string[];
  /** JSON-parsed request bodies, in call order (for asserting payloads). */
  bodies: Record<string, unknown>[];
}

/**
 * Fake fetch that serves the DingTalk registration endpoints:
 *   /app/registration/init   → nonce
 *   /app/registration/begin  → device_code + verification_uri_complete
 *   /app/registration/poll   → status (sequence consumed per poll call)
 *
 * `device_code` auto-increments per `begin` call so concurrent-session tests
 * get distinct keys (mirrors the WeCom fake).
 */
function makeFetch(opts: {
  init?: unknown;
  begin?: unknown;
  pollResults?: unknown[];
  initStatus?: number;
  failInit?: boolean;
  failPollOnce?: boolean;
} = {}): FakeFetch {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  let pollIdx = 0;
  let devSeq = 0;

  const fn: FetchLike = async (url: string, init?: RequestInit) => {
    calls.push(url);
    bodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});

    if (url.includes('/app/registration/init')) {
      if (opts.failInit) throw new Error('network down');
      return makeResponse(opts.init ?? { errcode: 0, nonce: 'nonce_abc', expires_in: 600 }, opts.initStatus ?? 200);
    }

    if (url.includes('/app/registration/begin')) {
      const code = `DC${++devSeq}`;
      const body =
        opts.begin ??
        {
          errcode: 0,
          device_code: code,
          user_code: `UC_${code}`,
          verification_uri: `https://login.dingtalk.com/device?user_code=${code}`,
          verification_uri_complete: `https://login.dingtalk.com/device?user_code=${code}`,
          expires_in: 600,
        };
      return makeResponse(body);
    }

    if (url.includes('/app/registration/poll')) {
      if (opts.failPollOnce && pollIdx === 0) {
        pollIdx++;
        throw new Error('network down');
      }
      const list = opts.pollResults?.length ? opts.pollResults : [{ errcode: 0, status: 'WAITING' }];
      const body = list[Math.min(pollIdx, list.length - 1)];
      pollIdx++;
      return makeResponse(body);
    }

    return makeResponse({ errcode: 0 }, 404);
  };

  return { fn, calls, bodies };
}

const SUCCESS_BODY = {
  errcode: 0,
  status: 'SUCCESS',
  client_id: 'cli_ding123',
  client_secret: 'sec_ding456',
};

const DUMMY_CONFIG = { dingtalkScanSource: 'DING_DWS_CLAW' } as ProvisioningConfig;

describe('DingTalkAppScanStore', () => {
  it('start() calls init→begin, exposes the QR while still pending', async () => {
    const fake = makeFetch();
    const store = new DingTalkAppScanStore({ fetchImpl: fake.fn });
    const session = await store.start();

    expect(session.deviceCode).toMatch(/^DC\d+$/);
    expect(session.verificationUriComplete).toContain('login.dingtalk.com');
    expect(session.qrDataUri).toMatch(/^data:image\/png;base64,/);
    expect(session.expireIn).toBeGreaterThan(0);
    expect(session.status).toBe('pending');

    // init carries the configured source; begin reuses the nonce.
    expect(fake.calls[0]).toContain('/app/registration/init');
    expect(fake.calls[1]).toContain('/app/registration/begin');
    expect(fake.bodies[0]).toEqual({ source: 'DING_DWS_CLAW' });
    expect(fake.bodies[1]).toEqual({ nonce: 'nonce_abc' });
  });

  it('throws QR_NOT_READY when init returns no nonce', async () => {
    const store = new DingTalkAppScanStore({ fetchImpl: makeFetch({ init: { errcode: 0 } }).fn });
    await expect(store.start()).rejects.toMatchObject({ code: 'QR_NOT_READY' });
  });

  it('throws DINGTALK_API_ERROR when init returns a non-zero errcode', async () => {
    const store = new DingTalkAppScanStore({
      fetchImpl: makeFetch({ init: { errcode: 1, errmsg: 'boom' }, initStatus: 502 }).fn,
    });
    await expect(store.start()).rejects.toMatchObject({ code: 'DINGTALK_API_ERROR' });
  });

  it('throws QR_NOT_READY when begin omits device_code / verification_uri_complete', async () => {
    const store = new DingTalkAppScanStore({
      fetchImpl: makeFetch({ begin: { errcode: 0, verification_uri_complete: 'https://x' } }).fn,
    });
    await expect(store.start()).rejects.toMatchObject({ code: 'QR_NOT_READY' });
  });

  it('throws DINGTALK_UNREACHABLE when the registration host is unreachable', async () => {
    const store = new DingTalkAppScanStore({ fetchImpl: makeFetch({ failInit: true }).fn });
    await expect(store.start()).rejects.toMatchObject({ code: 'DINGTALK_UNREACHABLE' });
  });

  it('poll() settles completed with clientId/clientSecret on SUCCESS', async () => {
    const store = new DingTalkAppScanStore({ fetchImpl: makeFetch({ pollResults: [SUCCESS_BODY] }).fn });
    const session = await store.start();

    const done = await store.poll(session.deviceCode);
    expect(done.status).toBe('completed');
    expect(done.clientId).toBe('cli_ding123');
    expect(done.clientSecret).toBe('sec_ding456');
    expect(store.get(session.deviceCode)?.status).toBe('completed');
  });

  it('poll() marks failed when SUCCESS has no credentials', async () => {
    const store = new DingTalkAppScanStore({
      fetchImpl: makeFetch({ pollResults: [{ errcode: 0, status: 'SUCCESS' }] }).fn,
    });
    const session = await store.start();
    const done = await store.poll(session.deviceCode);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('未获取到机器人凭据');
  });

  it('poll() stays pending on WAITING', async () => {
    const store = new DingTalkAppScanStore({
      fetchImpl: makeFetch({ pollResults: [{ errcode: 0, status: 'WAITING' }] }).fn,
    });
    const session = await store.start();
    const done = await store.poll(session.deviceCode);
    expect(done.status).toBe('pending');
    expect(done.clientId).toBeUndefined();
  });

  it('poll() marks failed on EXPIRED with a retry hint', async () => {
    const store = new DingTalkAppScanStore({
      fetchImpl: makeFetch({ pollResults: [{ errcode: 0, status: 'EXPIRED' }] }).fn,
    });
    const session = await store.start();
    const done = await store.poll(session.deviceCode);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('过期');
  });

  it('poll() marks failed on FAIL and surfaces fail_reason', async () => {
    const store = new DingTalkAppScanStore({
      fetchImpl: makeFetch({ pollResults: [{ errcode: 0, status: 'FAIL', fail_reason: 'org limit reached' }] }).fn,
    });
    const session = await store.start();
    const done = await store.poll(session.deviceCode);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('org limit reached');
  });

  it('poll() keeps pending on a transient egress failure, then recovers', async () => {
    const store = new DingTalkAppScanStore({
      fetchImpl: makeFetch({ pollResults: [SUCCESS_BODY], failPollOnce: true }).fn,
    });
    const session = await store.start();

    const first = await store.poll(session.deviceCode);
    expect(first.status).toBe('pending'); // transient failure → retry later

    const second = await store.poll(session.deviceCode);
    expect(second.status).toBe('completed');
    expect(second.clientId).toBe('cli_ding123');
  });

  it('poll() keeps pending on a non-zero poll errcode (treated as transient)', async () => {
    const store = new DingTalkAppScanStore({
      fetchImpl: makeFetch({ pollResults: [{ errcode: 500, errmsg: 'server busy' }, SUCCESS_BODY] }).fn,
    });
    const session = await store.start();

    const first = await store.poll(session.deviceCode);
    expect(first.status).toBe('pending');

    const second = await store.poll(session.deviceCode);
    expect(second.status).toBe('completed');
  });

  it('poll() throws NOT_FOUND for an unknown deviceCode', async () => {
    const store = new DingTalkAppScanStore({ fetchImpl: makeFetch().fn });
    await expect(store.poll('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cancel() marks a pending scan cancelled; unknown returns false', async () => {
    const store = new DingTalkAppScanStore({ fetchImpl: makeFetch().fn });
    const session = await store.start();
    expect(store.cancel(session.deviceCode)).toBe(true);
    expect(store.get(session.deviceCode)?.status).toBe('cancelled');
    expect(store.cancel('nope')).toBe(false);
  });

  it('get() returns undefined for TTL-expired sessions', async () => {
    const store = new DingTalkAppScanStore({ fetchImpl: makeFetch().fn });
    const session = await store.start();
    (store as any).sessions.get(session.deviceCode).startedAt = new Date(Date.now() - SCAN_SESSION_TTL_MS - 60_000);
    expect(store.get(session.deviceCode)).toBeUndefined();
  });

  it('sweep() keeps completed sessions briefly, then removes them', async () => {
    const store = new DingTalkAppScanStore({ fetchImpl: makeFetch({ pollResults: [SUCCESS_BODY] }).fn });
    const session = await store.start();
    await store.poll(session.deviceCode);
    expect(store.get(session.deviceCode)?.status).toBe('completed');

    const done = store.get(session.deviceCode)!;
    done.completedAt = new Date(Date.now() - COMPLETED_RETENTION_MS - 60_000);
    expect(store.get(session.deviceCode)).toBeUndefined();
  });

  it('caps concurrent pending sessions', async () => {
    const store = new DingTalkAppScanStore({ fetchImpl: makeFetch().fn });
    for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) {
      await store.start();
    }
    await expect(store.start()).rejects.toBeInstanceOf(DingTalkAppScanError);
  });

  it('scanStatusMessage maps each status to a Chinese hint', () => {
    expect(scanStatusMessage({ status: 'pending' } as any)).toContain('二维码');
    expect(scanStatusMessage({ status: 'completed' } as any)).toContain('成功');
    expect(scanStatusMessage({ status: 'failed', error: 'x' } as any)).toContain('x');
    expect(scanStatusMessage({ status: 'cancelled' } as any)).toContain('取消');
  });
});

// ── Route surface ──────────────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';

function makeApp(store: DingTalkAppScanStore) {
  const app = express();
  app.use(express.json());
  app.use(createDingTalkAppScanRoutes(DUMMY_CONFIG, undefined, store));
  return app;
}

describe('dingtalk-app-scan routes', () => {
  it('start → status(pending) → status(completed with credentials)', async () => {
    const fake = makeFetch({ pollResults: [{ errcode: 0, status: 'WAITING' }, SUCCESS_BODY] });
    const store = new DingTalkAppScanStore({ fetchImpl: fake.fn });
    const app = makeApp(store);

    const start = await request(app).post('/v1/admin/dingtalk-app/scan/start').expect(200);
    expect(start.body.ok).toBe(true);
    const deviceCode: string = start.body.deviceCode;
    expect(deviceCode).toMatch(/^DC\d+$/);
    expect(start.body.qrDataUri).toMatch(/^data:image\/png;base64,/);
    expect(start.body.expireIn).toBeGreaterThan(0);

    const pending = await request(app).get(`/v1/admin/dingtalk-app/scan/status/${deviceCode}`).expect(200);
    expect(pending.body.status).toBe('pending');
    expect(pending.body.result).toBeUndefined();

    const done = await request(app).get(`/v1/admin/dingtalk-app/scan/status/${deviceCode}`).expect(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.result).toEqual({ clientId: 'cli_ding123', clientSecret: 'sec_ding456' });
  });

  it('status 404 for unknown deviceCode', async () => {
    const app = makeApp(new DingTalkAppScanStore({ fetchImpl: makeFetch().fn }));
    await request(app).get('/v1/admin/dingtalk-app/scan/status/nope').expect(404);
  });

  it('cancel requires deviceCode and reports unknown sessions', async () => {
    const app = makeApp(new DingTalkAppScanStore({ fetchImpl: makeFetch().fn }));
    await request(app).post('/v1/admin/dingtalk-app/scan/cancel').send({}).expect(400);
    await request(app).post('/v1/admin/dingtalk-app/scan/cancel').send({ deviceCode: 'x' }).expect(404);
  });
});
