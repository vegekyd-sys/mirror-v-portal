import { describe, it, expect, beforeEach } from 'vitest';
import type pg from 'pg';
import { deliverNotification } from '../services/notifier.js';
import type { OpsConfig } from '../config.js';
import type { TransitionAction } from '../services/state-machine.js';

type NotifyAction = Extract<TransitionAction, { type: 'notify' }>;

const ACTION: NotifyAction = {
  type: 'notify',
  name: 'low-credits',
  channel: 'bot',
  message: '测试通知',
  dedupKey: 'low-credits:t-1:2026-08',
};

/** Minimal in-memory stand-in for pg.Pool — routes by SQL shape. */
function makeFakePool(opts: { failInsert?: boolean } = {}) {
  const state = {
    dedupKeys: new Set<string>(),
    rows: new Map<number, { delivered: boolean; deliveryError: string | null }>(),
    nextId: 1,
    updateCalls: 0,
  };

  const pool = {
    query: async (sql: string, params?: any[]) => {
      if (sql.includes('INSERT INTO tenant_notifications')) {
        if (opts.failInsert) throw new Error('db down');
        const dedupKey = params![3];
        if (state.dedupKeys.has(dedupKey)) {
          return { rowCount: 0, rows: [] };
        }
        state.dedupKeys.add(dedupKey);
        const id = state.nextId++;
        state.rows.set(id, { delivered: false, deliveryError: null });
        return { rowCount: 1, rows: [{ id }] };
      }
      if (sql.includes('UPDATE tenant_notifications SET delivered = TRUE')) {
        state.updateCalls++;
        const row = state.rows.get(params![0]);
        if (row) row.delivered = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE tenant_notifications SET delivery_error')) {
        state.updateCalls++;
        const row = state.rows.get(params![0]);
        if (row) row.deliveryError = params![1];
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL in fake pool: ${sql.slice(0, 60)}`);
    },
  } as unknown as pg.Pool;

  return { pool, state };
}

function makeConfig(overrides: Partial<OpsConfig> = {}): OpsConfig {
  return {
    port: 0,
    databaseUrl: 'postgresql://unused',
    creditsLedgerUrl: 'http://credits-ledger:8081',
    cronIntervalMinutes: 60,
    provisioningServiceUrl: 'http://provisioning-service:8082',
    provisioningApiToken: 'test-token',
    rolloutIntervalMinutes: 30,
    ...overrides,
  };
}

describe('Notifier — dedup gate', () => {
  let fake: ReturnType<typeof makeFakePool>;

  beforeEach(() => {
    fake = makeFakePool();
  });

  it('first delivery attempt passes the dedup gate, second is suppressed', async () => {
    // Relay unconfigured → first attempt records the gate row then stops.
    const first = await deliverNotification(fake.pool, 't-1', ACTION, makeConfig());
    expect(first).toBe('notify:relay-not-configured');

    // Same dedupKey again → suppressed before touching the relay at all.
    const second = await deliverNotification(fake.pool, 't-1', ACTION, makeConfig());
    expect(second).toBe('notify:duplicate');
    expect(fake.state.rows.size).toBe(1);
  });

  it('different cycles are not suppressed', async () => {
    await deliverNotification(fake.pool, 't-1', ACTION, makeConfig());
    const nextCycle = { ...ACTION, dedupKey: 'low-credits:t-1:2026-09' };
    const result = await deliverNotification(fake.pool, 't-1', nextCycle, makeConfig());
    expect(result).toBe('notify:relay-not-configured'); // passed the gate
    expect(fake.state.rows.size).toBe(2);
  });

  it('broken dedup store refuses to send rather than risk duplicates', async () => {
    const broken = makeFakePool({ failInsert: true });
    const result = await deliverNotification(broken.pool, 't-1', ACTION, makeConfig({
      centralGatewayUrl: 'http://127.0.0.1:1',
      internalApiToken: 'token',
    }));
    expect(result).toBe('notify:error');
  });
});

describe('Notifier — relay integration', () => {
  it('without relay config the outcome is relay-not-configured (even without pool)', async () => {
    const result = await deliverNotification(undefined, 't-1', ACTION, makeConfig());
    expect(result).toBe('notify:relay-not-configured');
  });

  it('unreachable relay → relay-failed and delivery_error recorded', async () => {
    const fake = makeFakePool();
    const result = await deliverNotification(fake.pool, 't-1', ACTION, makeConfig({
      centralGatewayUrl: 'http://127.0.0.1:1', // nothing listens here
      internalApiToken: 'token',
    }));
    expect(result).toBe('notify:relay-failed');
    const row = fake.state.rows.get(1);
    expect(row?.delivered).toBe(false);
    expect(row?.deliveryError).toBeTruthy();
  });

  it('relay answering ok:false records the reason', async () => {
    const fake = makeFakePool();

    // Tiny in-process HTTP server simulating central-gateway's relay response.
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, delivered: [], skipped: [], reason: 'no-im-open-id' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    try {
      const result = await deliverNotification(fake.pool, 't-1', ACTION, makeConfig({
        centralGatewayUrl: `http://127.0.0.1:${port}`,
        internalApiToken: 'token',
      }));
      expect(result).toBe('notify:not-delivered');
      expect(fake.state.rows.get(1)?.deliveryError).toBe('no-im-open-id');
    } finally {
      server.close();
    }
  });

  it('relay answering ok:true marks the notification delivered', async () => {
    const fake = makeFakePool();

    const http = await import('node:http');
    let receivedAuth = '';
    let receivedBody = '';
    const server = http.createServer((req, res) => {
      receivedAuth = req.headers.authorization || '';
      req.on('data', chunk => { receivedBody += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, delivered: ['bot:feishu'], skipped: [] }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    try {
      const result = await deliverNotification(fake.pool, 't-1', ACTION, makeConfig({
        centralGatewayUrl: `http://127.0.0.1:${port}`,
        internalApiToken: 'secret-token',
      }));
      expect(result).toBe('notify:sent');
      expect(fake.state.rows.get(1)?.delivered).toBe(true);
      expect(receivedAuth).toBe('Bearer secret-token');
      expect(JSON.parse(receivedBody).tenantId).toBe('t-1');
    } finally {
      server.close();
    }
  });
});
