import { describe, it, expect } from 'vitest';

import {
  WeComAppScanStore,
  WeComAppScanError,
  SCAN_SESSION_TTL_MS,
  MAX_ACTIVE_SESSIONS,
  type WeComAppScanSession,
} from '../services/wecom-app-scan.js';
import { createWeComAppScanRoutes } from '../routes/wecom-app-scan.js';
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
}

/**
 * Fake fetch that serves the WeCom generate / query_result endpoints.
 * queryResults is a sequence consumed per query_result call (last one repeats).
 */
function makeFetch(opts: {
  generate?: unknown;
  queryResults?: unknown[];
  generateStatus?: number;
} = {}): FakeFetch {
  const calls: string[] = [];
  let queryIdx = 0;
  let genIdx = 0;
  const fn: FetchLike = async (url: string) => {
    calls.push(url);
    if (url.includes('/ai/qc/generate')) {
      genIdx++;
      const body =
        opts.generate ??
        { data: { scode: `SCODE${genIdx}`, auth_url: `https://work.weixin.qq.com/ai/qc/authorize?x=${genIdx}` } };
      return makeResponse(body, opts.generateStatus ?? 200);
    }
    if (url.includes('/ai/qc/query_result')) {
      const list = opts.queryResults?.length ? opts.queryResults : [{ data: { status: 'pending' } }];
      const body = list[Math.min(queryIdx, list.length - 1)];
      queryIdx++;
      return makeResponse(body);
    }
    return makeResponse({ data: {} }, 404);
  };
  return { fn, calls };
}

const SUCCESS_BODY = {
  data: {
    status: 'success',
    bot_info: { botid: 'bot_12345', secret: 'sec_abcdef' },
  },
};

const DUMMY_CONFIG = { wecomScanSource: 'wecom-cli' } as ProvisioningConfig;

describe('WeComAppScanStore', () => {
  it('start() exposes the QR while the scan is still pending', async () => {
    const fake = makeFetch();
    const store = new WeComAppScanStore({ fetchImpl: fake.fn });
    const session = await store.start();

    expect(session.scode).toMatch(/^SCODE\d+$/);
    expect(session.authUrl).toContain('work.weixin.qq.com');
    expect(session.scanPageUrl).toContain(`scode=${session.scode}`);
    expect(session.qrDataUri).toMatch(/^data:image\/png;base64,/);
    expect(session.status).toBe('pending');
    // generate carries the configured source + a numeric plat code.
    expect(fake.calls[0]).toContain('source=wecom-cli');
    expect(fake.calls[0]).toMatch(/plat=\d/);
  });

  it('throws QR_NOT_READY when generate returns no scode/auth_url', async () => {
    const fake = makeFetch({ generate: { data: { msg: 'nope' } } });
    const store = new WeComAppScanStore({ fetchImpl: fake.fn });
    await expect(store.start()).rejects.toMatchObject({ code: 'QR_NOT_READY' });
  });

  it('throws QR_NOT_READY when generate returns an error status', async () => {
    const fake = makeFetch({ generate: { data: {} }, generateStatus: 502 });
    const store = new WeComAppScanStore({ fetchImpl: fake.fn });
    await expect(store.start()).rejects.toMatchObject({ code: 'QR_NOT_READY' });
  });

  it('poll() settles completed with botId/secret on success', async () => {
    const fake = makeFetch({ queryResults: [SUCCESS_BODY] });
    const store = new WeComAppScanStore({ fetchImpl: fake.fn });
    const session = await store.start();

    const done = await store.poll(session.scode);
    expect(done.status).toBe('completed');
    expect(done.botId).toBe('bot_12345');
    expect(done.secret).toBe('sec_abcdef');
    expect(store.get(session.scode)?.status).toBe('completed');
  });

  it('poll() marks failed when success has no bot_info', async () => {
    const fake = makeFetch({ queryResults: [{ data: { status: 'success', bot_info: {} } }] });
    const store = new WeComAppScanStore({ fetchImpl: fake.fn });
    const session = await store.start();
    const done = await store.poll(session.scode);
    expect(done.status).toBe('failed');
  });

  it('poll() stays pending on a non-terminal status', async () => {
    const fake = makeFetch({ queryResults: [{ data: { status: 'pending' } }] });
    const store = new WeComAppScanStore({ fetchImpl: fake.fn });
    const session = await store.start();
    const done = await store.poll(session.scode);
    expect(done.status).toBe('pending');
    expect(done.botId).toBeUndefined();
  });

  it('poll() marks failed on an explicit failed status', async () => {
    const fake = makeFetch({ queryResults: [{ data: { status: 'expired', message: '二维码已失效' } }] });
    const store = new WeComAppScanStore({ fetchImpl: fake.fn });
    const session = await store.start();
    const done = await store.poll(session.scode);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('二维码已失效');
  });

  it('poll() keeps pending on a transient egress failure', async () => {
    let fail = true;
    const fn: FetchLike = async (url: string) => {
      if (url.includes('/ai/qc/query_result') && fail) {
        fail = false;
        throw new Error('network down');
      }
      if (url.includes('/ai/qc/query_result')) return makeResponse(SUCCESS_BODY);
      return makeResponse({ data: { scode: 'SCODE1', auth_url: 'https://x' } });
    };
    const store = new WeComAppScanStore({ fetchImpl: fn });
    const session = await store.start();
    const first = await store.poll(session.scode);
    expect(first.status).toBe('pending'); // transient failure → retry later
    const second = await store.poll(session.scode);
    expect(second.status).toBe('completed');
  });

  it('poll() throws NOT_FOUND for unknown scode', async () => {
    const store = new WeComAppScanStore({ fetchImpl: makeFetch().fn });
    await expect(store.poll('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cancel() marks a pending scan cancelled; unknown returns false', async () => {
    const store = new WeComAppScanStore({ fetchImpl: makeFetch().fn });
    const session = await store.start();
    expect(store.cancel(session.scode)).toBe(true);
    expect(store.get(session.scode)?.status).toBe('cancelled');
    expect(store.cancel('nope')).toBe(false);
  });

  it('get() returns undefined for swept sessions', async () => {
    const store = new WeComAppScanStore({ fetchImpl: makeFetch().fn });
    const session = await store.start();
    (store as any).sessions.get(session.scode).startedAt = new Date(Date.now() - SCAN_SESSION_TTL_MS - 60_000);
    expect(store.get(session.scode)).toBeUndefined();
  });

  it('caps concurrent pending sessions', async () => {
    const store = new WeComAppScanStore({ fetchImpl: makeFetch().fn });
    for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) {
      await store.start();
    }
    await expect(store.start()).rejects.toBeInstanceOf(WeComAppScanError);
  });
});

// ── Route surface ──────────────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';

function makeApp(store: WeComAppScanStore) {
  const app = express();
  app.use(express.json());
  app.use(createWeComAppScanRoutes(DUMMY_CONFIG, undefined, store));
  return app;
}

describe('wecom-app-scan routes', () => {
  it('start → status(pending) → status(completed with credentials)', async () => {
    const fake = makeFetch({ queryResults: [SUCCESS_BODY] });
    const store = new WeComAppScanStore({ fetchImpl: fake.fn });
    const app = makeApp(store);

    const start = await request(app).post('/v1/admin/wecom-app/scan/start').expect(200);
    expect(start.body.ok).toBe(true);
    const scode: string = start.body.scode;
    expect(scode).toMatch(/^SCODE\d+$/);
    expect(start.body.qrDataUri).toMatch(/^data:image\/png;base64,/);
    expect(start.body.expireIn).toBeGreaterThan(0);

    const done = await request(app).get(`/v1/admin/wecom-app/scan/status/${scode}`).expect(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.result).toEqual({ botId: 'bot_12345', secret: 'sec_abcdef' });
  });

  it('status 404 for unknown scode', async () => {
    const app = makeApp(new WeComAppScanStore({ fetchImpl: makeFetch().fn }));
    await request(app).get('/v1/admin/wecom-app/scan/status/nope').expect(404);
  });

  it('cancel requires scode and reports unknown sessions', async () => {
    const app = makeApp(new WeComAppScanStore({ fetchImpl: makeFetch().fn }));
    await request(app).post('/v1/admin/wecom-app/scan/cancel').send({}).expect(400);
    await request(app).post('/v1/admin/wecom-app/scan/cancel').send({ scode: 'x' }).expect(404);
  });
});
