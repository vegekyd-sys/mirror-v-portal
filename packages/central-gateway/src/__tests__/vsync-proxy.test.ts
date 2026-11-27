import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

// A stand-in runtime manager: the gateway forwards VSync calls with the caller's agent headers.
let manager: http.Server;
const seen: { method?: string; url?: string; agent?: string; token?: string; body: string }[] = [];
beforeAll(async () => {
  manager = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, agent: req.headers['x-vsync-agent'] as string, token: req.headers['x-vsync-token'] as string, body });
      if (req.url?.startsWith('/v1/vsync/file')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from([0, 1, 2])); return; }
      res.writeHead(req.headers['x-vsync-token'] === 'good' ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers['x-vsync-token'] === 'good' ? { ok: true } : { error: 'VSYNC_UNAUTHORIZED' }));
    });
  });
  await new Promise<void>((resolve) => manager.listen(0, '127.0.0.1', resolve));
  process.env.PROVISIONING_SERVICE_URL = `http://127.0.0.1:${(manager.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => manager.close(() => resolve())));

describe('vsync proxy', () => {
  it('forwards reads, files and writes with the agent headers, and passes refusals through', async () => {
    const { createApp } = await import('../app.js');
    const app = createApp();
    const inbox = await request(app).get('/onboard/vsync/v1/inbox').set('x-vsync-agent', 'mirror-a').set('x-vsync-token', 'good');
    expect(inbox.status).toBe(200);
    expect(inbox.headers['cache-control']).toContain('no-store');
    expect(seen.at(-1)).toMatchObject({ method: 'GET', url: '/v1/vsync/inbox', agent: 'mirror-a', token: 'good' });
    const file = await request(app).get('/onboard/vsync/v1/file?path=agents/private-v/returns/mirror-a/p/SKILL.md&x=1').set('x-vsync-agent', 'mirror-a').set('x-vsync-token', 'good').buffer(true);
    expect(seen.at(-1)?.url).toBe(`/v1/vsync/file?path=${encodeURIComponent('agents/private-v/returns/mirror-a/p/SKILL.md')}`);
    expect(file.headers['content-type']).toContain('octet-stream');
    const ack = await request(app).post('/onboard/vsync/v1/ack').set('x-vsync-agent', 'mirror-a').set('x-vsync-token', 'bad').send({ row: { in_reply_to: 'm1' } });
    expect(ack.status).toBe(401);
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ row: { in_reply_to: 'm1' } });
  });
  it('rejects unknown operations and wrong methods without asking the manager', async () => {
    const { createApp } = await import('../app.js');
    const app = createApp();
    const before = seen.length;
    expect((await request(app).get('/onboard/vsync/v1/send')).status).toBe(405);
    expect((await request(app).get('/onboard/vsync/v1/admin')).status).toBe(404);
    expect(seen.length).toBe(before);
  });
});
