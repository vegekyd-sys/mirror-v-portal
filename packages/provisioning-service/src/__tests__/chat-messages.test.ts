/**
 * Chat message log API contract (dealclaw-chatlog feature).
 *
 *   - POST ingest validates direction/content, truncates oversized content,
 *     and is idempotent on message_id (ON CONFLICT DO NOTHING → stored:false)
 *   - GET sessions groups by (session_key, natural day in Asia/Shanghai),
 *     newest activity first
 *   - GET messages paginates newest-first with sessionKey/day/direction filters
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
  llmPushWorkerIntervalMs: 100,
  llmPushLeaseSeconds: 600,
};

/** Asia/Shanghai (UTC+8, no DST) natural day → 'YYYY-MM-DD'. */
function shDay(d: Date): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

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
  created_at: Date;
}

/** Fake pool: chat_messages insert/select semantics only. */
function makePool() {
  const rows: Row[] = [];
  let now = new Date('2026-09-01T04:00:00Z'); // 12:00 +08:00

  // Emulate the sessions CTE: each message belongs to the sender of the most
  // recent inbound message in its session; buckets by (session_key, day, person).
  const segmentList = (tenantId: string) => {
    const bySession = new Map<string, Row[]>();
    for (const r of rows) {
      if (r.tenant_id !== tenantId || !r.session_key) continue;
      const l = bySession.get(r.session_key) ?? [];
      l.push(r);
      bySession.set(r.session_key, l);
    }
    const segs: Array<{
      session_key: string;
      day: string;
      person_open_id: string | null;
      person_name: string | null;
      messages: Row[];
    }> = [];
    for (const [session_key, list] of bySession) {
      const sorted = [...list].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      let person: { open_id: string | null; name: string | null } = { open_id: null, name: null };
      for (const r of sorted) {
        if (r.direction === 'in') person = { open_id: r.sender_open_id, name: r.sender_name };
        const day = shDay(r.created_at);
        let seg = segs.find(
          (s) => s.session_key === session_key && s.day === day && s.person_open_id === person.open_id,
        );
        if (!seg) {
          seg = {
            session_key,
            day,
            person_open_id: person.open_id,
            person_name: person.name,
            messages: [],
          };
          segs.push(seg);
        }
        seg.messages.push(r);
      }
    }
    return segs;
  };

  const pool = {
    rows,
    setNow: (iso: string) => { now = new Date(iso); },
    query: async (sql: string, params?: unknown[]) => {
      const s = sql.toUpperCase().replace(/\s+/g, ' ').trim();
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
          created_at: new Date(now),
        });
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('SELECT DISTINCT SESSION_KEY')) {
        // sessions total — count distinct (session_key, day, person) segments
        return { rows: [{ total: segmentList(String(params?.[0])).length }], rowCount: 1 };
      }
      if (s.includes('GROUP BY SESSION_KEY')) {
        // sessions aggregation — emulate (session_key, day, person) bucketing
        const segs = segmentList(String(params?.[0]));
        const limit = Number(params?.[1] ?? 20);
        const offset = Number(params?.[2] ?? 0);
        const sessions = segs
          .map((seg) => {
            const sorted = [...seg.messages].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
            return {
              session_key: seg.session_key,
              day: seg.day,
              person_open_id: seg.person_open_id,
              person_name: seg.person_name,
              message_count: seg.messages.length,
              last_sender_name: sorted[0].sender_name,
              last_sender_open_id: sorted[0].sender_open_id,
              _last: sorted[0].created_at.getTime(),
            };
          })
          .sort((a, b) => b._last - a._last)
          .map(({ _last, ...rest }) => rest)
          .slice(offset, offset + limit);
        return { rows: sessions, rowCount: sessions.length };
      }
      if (s.includes('SELECT ID, DIRECTION, CHANNEL')) {
        // messages list with filters: params[0]=tenant, optional direction/sessionKey/day, then limit/offset
        let list = rows.filter((r) => r.tenant_id === String(params?.[0]));
        for (let i = 1; i < (params?.length ?? 0) - 2; i++) {
          const v = String(params?.[i]);
          if (v === 'in' || v === 'out') list = list.filter((r) => r.direction === v);
          else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) list = list.filter((r) => shDay(r.created_at) === v);
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
          else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) list = list.filter((r) => shDay(r.created_at) === v);
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
      { day: '2026-09-01T02:00:00Z', direction: 'in', content: 'a', sessionKey: 's1', messageId: 'm1', senderName: '张三' },
      { day: '2026-09-01T03:00:00Z', direction: 'out', content: 'b', sessionKey: 's1', messageId: 'm2' },
      { day: '2026-09-01T04:00:00Z', direction: 'in', content: 'c', sessionKey: 's2', messageId: 'm3', senderName: '李四' },
      { day: '2026-09-02T02:00:00Z', direction: 'in', content: 'd', sessionKey: 's1', messageId: 'm4', senderName: '张三' },
    ];
    for (const s of seed) {
      pool.setNow(s.day);
      pool.query(
        'INSERT INTO chat_messages (tenant_id, direction, channel, sender_open_id, sender_name, sender_username, content, session_key, message_id, run_id, success) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        ['tid1', s.direction, null, null, s.senderName ?? null, null, s.content, s.sessionKey, s.messageId, null, null],
      );
    }
    app = createApp(pool, config);
  });

  it('segments sessions by natural day (Asia/Shanghai)', async () => {
    const r = await request(app).get('/v1/tenants/tid1/chat-messages/sessions').set(auth);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    const s1d1 = r.body.sessions.find((s: any) => s.session_key === 's1' && s.day === '2026-09-01');
    expect(s1d1.message_count).toBe(2);
    const s1d2 = r.body.sessions.find((s: any) => s.session_key === 's1' && s.day === '2026-09-02');
    expect(s1d2.message_count).toBe(1);
  });

  it('paginates messages newest-first with sessionKey+day filter', async () => {
    const r = await request(app)
      .get('/v1/tenants/tid1/chat-messages?sessionKey=s1&day=2026-09-01&limit=10')
      .set(auth);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.messages.length).toBe(2);
    expect(r.body.messages.map((m: any) => m.content)).toEqual(['b', 'a']);
  });

  it('day filter isolates a single calendar day', async () => {
    const r = await request(app)
      .get('/v1/tenants/tid1/chat-messages?sessionKey=s1&day=2026-09-02&limit=10')
      .set(auth);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.messages[0].content).toBe('d');
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
