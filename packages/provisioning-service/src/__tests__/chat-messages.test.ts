/**
 * Chat message log API contract (dealclaw-chatlog feature).
 *
 *   - POST ingest validates direction/content, truncates oversized content,
 *     and is idempotent on message_id (ON CONFLICT DO NOTHING → stored:false)
 *   - GET sessions groups by session_key, newest activity first
 *   - GET messages paginates newest-first with sessionKey/direction filters
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import type { ProvisioningConfig } from '../config.js';

process.env.PROVISIONING_API_TOKEN = 'test-token';

const config: ProvisioningConfig = {
  port: 0,
  databaseUrl: 'postgresql://test:test@localhost:5432/test',
  k8sDryRun: true,
  runtimeNamespace: 'dealclaw-test',
  imageRegistry: 'test-registry/dealclaw',
  nexusGatewayImageTag: 'test',
  dealclawAgentImageTag: 'test',
  agentPvcSize: '10Gi',
  agentPvcStorageClass: 'alibabacloud-cnfs-nas',
  agentPvcAccessMode: 'ReadWriteOnce',
  ossEndpoint: 'oss-cn-shanghai.aliyuncs.com',
  ossBucket: 'dealclaw-backup',
  ossSecretName: 'dealclaw-oss',
  backupImage: 'test/ossutil',
  creditsLedgerUrl: 'http://credits-ledger:8081',
  creditsLedgerToken: '',
};

interface Row {
  tenant_id: string;
  direction: string;
  channel: string | null;
  sender_open_id: string | null;
  sender_name: string | null;
  sender_username: string | null;
  content: string;
  session_key: string | null;
  message_id: string | null;
  run_id: string | null;
  success: boolean | null;
}

/** Fake pool: chat_messages insert/select semantics only. */
function makePool() {
  const rows: Row[] = [];
  const pool = {
    rows,
    query: async (sql: string, params?: unknown[]) => {
      const s = sql.toUpperCase();
      if (s.includes('INSERT INTO CHAT_MESSAGES')) {
        const existing = params?.[8]
          ? rows.some((r) => r.message_id === params[8] && r.tenant_id === params[0])
          : false;
        if (existing) return { rows: [], rowCount: 0 };
        rows.push({
          tenant_id: String(params?.[0]),
          direction: String(params?.[1]),
          channel: (params?.[2] as string) ?? null,
          sender_open_id: (params?.[3] as string) ?? null,
          sender_name: (params?.[4] as string) ?? null,
          sender_username: (params?.[5] as string) ?? null,
          content: String(params?.[6] ?? ''),
          session_key: (params?.[7] as string) ?? null,
          message_id: (params?.[8] as string) ?? null,
          run_id: (params?.[9] as string) ?? null,
          success: (params?.[10] as boolean) ?? null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('GROUP BY SESSION_KEY')) {
        // sessions aggregation — emulate GROUP BY on in-memory rows
        const bySession = new Map<string, Row[]>();
        for (const r of rows) {
          if (r.tenant_id !== String(params?.[0]) || !r.session_key) continue;
          const list = bySession.get(r.session_key) ?? [];
          list.push(r);
          bySession.set(r.session_key, list);
        }
        const limit = Number(params?.[1] ?? 20);
        const offset = Number(params?.[2] ?? 0);
        const sessions = [...bySession.entries()]
          .map(([session_key, list]) => {
            const sorted = [...list].sort((a, b) => (a.content < b.content ? -1 : 1));
            return {
              session_key,
              message_count: list.length,
              last_sender_name: sorted[sorted.length - 1].sender_name,
              last_sender_open_id: sorted[sorted.length - 1].sender_open_id,
            };
          })
          .slice(offset, offset + limit);
        return { rows: sessions, rowCount: sessions.length };
      }
      if (s.includes('COUNT(DISTINCT SESSION_KEY')) {
        const set = new Set(rows.filter((r) => r.tenant_id === String(params?.[0]) && r.session_key).map((r) => r.session_key));
        return { rows: [{ total: set.size }], rowCount: 1 };
      }
      if (s.includes('SELECT ID, DIRECTION, CHANNEL')) {
        // messages list with filters: params[0]=tenant, optional direction/sessionKey, then limit/offset
        let list = rows.filter((r) => r.tenant_id === String(params?.[0]));
        for (let i = 1; i < (params?.length ?? 0) - 2; i++) {
          const v = String(params?.[i]);
          if (v === 'in' || v === 'out') list = list.filter((r) => r.direction === v);
          else list = list.filter((r) => r.session_key === v);
        }
        const limit = Number(params?.[params!.length - 2] ?? 50);
        const offset = Number(params?.[params!.length - 1] ?? 0);
        // real SQL orders by created_at DESC — same-timestamp rows come back
        // in reverse insertion order in this fake
        const page = [...list].reverse().slice(offset, offset + limit).map((r, i) => ({ ...r, id: offset + i + 1 }));
        return { rows: page, rowCount: page.length };
      }
      if (s.includes('COUNT(*)') && s.includes('CHAT_MESSAGES')) {
        let list = rows.filter((r) => r.tenant_id === String(params?.[0]));
        for (let i = 1; i < (params?.length ?? 0); i++) {
          const v = String(params?.[i]);
          if (v === 'in' || v === 'out') list = list.filter((r) => r.direction === v);
          else list = list.filter((r) => r.session_key === v);
        }
        return { rows: [{ total: list.length }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as any;
}

const auth = { Authorization: 'Bearer test-token' };

describe('POST /v1/tenants/:id/chat-messages — ingest', () => {
  let app: ReturnType<typeof createApp>;
  let pool: any;
  beforeAll(() => { pool = makePool(); app = createApp(pool, config); });

  it('stores an inbound message with sender name', async () => {
    const r = await request(app)
      .post('/v1/tenants/tid1/chat-messages')
      .set(auth)
      .send({
        direction: 'in', channel: 'feishu', senderOpenId: 'ou_abc', senderName: '王建',
        content: '你能做什么', sessionKey: 'feishu:dm:ou_abc', messageId: 'om_1', runId: 'run_1',
      });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, stored: true });
    expect(pool.rows[0].sender_name).toBe('王建');
  });

  it('is idempotent on message_id (retry after timeout)', async () => {
    const r = await request(app)
      .post('/v1/tenants/tid1/chat-messages')
      .set(auth)
      .send({
        direction: 'in', content: '你能做什么', sessionKey: 'feishu:dm:ou_abc', messageId: 'om_1',
      });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, stored: false });
    expect(pool.rows.length).toBe(1);
  });

  it('rejects bad direction / empty content', async () => {
    expect((await request(app).post('/v1/tenants/tid1/chat-messages').set(auth)
      .send({ direction: 'sideways', content: 'x' })).status).toBe(400);
    expect((await request(app).post('/v1/tenants/tid1/chat-messages').set(auth)
      .send({ direction: 'in', content: '   ' })).status).toBe(400);
  });

  it('truncates oversized content', async () => {
    const r = await request(app)
      .post('/v1/tenants/tid1/chat-messages')
      .set(auth)
      .send({ direction: 'out', content: 'x'.repeat(30_000), messageId: 'om_2' });
    expect(r.status).toBe(200);
    expect(pool.rows[pool.rows.length - 1].content.length).toBe(20_000);
  });
});

describe('GET /v1/tenants/:id/chat-messages — queries', () => {
  let app: ReturnType<typeof createApp>;
  let pool: any;
  beforeAll(() => {
    pool = makePool();
    const seed = [
      { direction: 'in', content: 'a', sessionKey: 's1', messageId: 'm1', senderName: '张三' },
      { direction: 'out', content: 'b', sessionKey: 's1', messageId: 'm2' },
      { direction: 'in', content: 'c', sessionKey: 's2', messageId: 'm3', senderName: '李四' },
    ];
    for (const s of seed) {
      pool.query(
        'INSERT INTO chat_messages (tenant_id, direction, channel, sender_open_id, sender_name, sender_username, content, session_key, message_id, run_id, success) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        ['tid1', s.direction, null, null, s.senderName ?? null, null, s.content, s.sessionKey, s.messageId, null, null],
      );
    }
    app = createApp(pool, config);
  });

  it('lists sessions grouped by session_key with counts', async () => {
    const r = await request(app).get('/v1/tenants/tid1/chat-messages/sessions').set(auth);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    const s1 = r.body.sessions.find((s: any) => s.session_key === 's1');
    expect(s1.message_count).toBe(2);
  });

  it('paginates messages newest-first with sessionKey filter', async () => {
    const r = await request(app)
      .get('/v1/tenants/tid1/chat-messages?sessionKey=s1&limit=10')
      .set(auth);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.messages.length).toBe(2);
    expect(r.body.messages.map((m: any) => m.content)).toEqual(['b', 'a']);
  });

  it('filters by direction', async () => {
    const r = await request(app)
      .get('/v1/tenants/tid1/chat-messages?direction=out')
      .set(auth);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.messages[0].direction).toBe('out');
  });

  it('requires auth', async () => {
    expect((await request(app).get('/v1/tenants/tid1/chat-messages')).status).toBe(401);
  });
});
