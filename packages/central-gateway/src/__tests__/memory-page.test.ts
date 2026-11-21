import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

// A stand-in runtime manager: the gateway only checks the link's shape and forwards it.
let manager: http.Server;
const seen: string[] = [];
beforeAll(async () => {
  manager = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    if (!req.url?.includes('notready') && (req.url?.endsWith('/index.html') || req.url?.endsWith('/'))) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<title>记忆</title>'); return; }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: req.url?.includes('notready') ? 'MEMORY_PAGE_NOT_READY' : 'MEMORY_LINK_INVALID' }));
  });
  await new Promise<void>((resolve) => manager.listen(0, '127.0.0.1', resolve));
  process.env.PROVISIONING_SERVICE_URL = `http://127.0.0.1:${(manager.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => manager.close(() => resolve())));

describe('memory page', () => {
  const sig = 'a'.repeat(32);
  it('forwards the signed link to the manager and keeps the page private', async () => {
    const { createApp } = await import('../app.js');
    const app = createApp();
    const page = await request(app).get(`/onboard/memory/t1/${sig}/`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('记忆');
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(page.headers['cache-control']).toContain('no-store');
    expect(seen.at(-1)).toBe(`/v1/tenants/t1/memory/${sig}/`);
    expect((await request(app).get(`/onboard/memory/t1/${sig}`)).headers.location).toBe(`/onboard/memory/t1/${sig}/`);
  });
  it('says plainly when the page is not built yet, and rejects malformed links without asking the manager', async () => {
    const { createApp } = await import('../app.js');
    const app = createApp();
    const before = seen.length;
    const malformed = await request(app).get(`/onboard/memory/t1/${'b'.repeat(31)}/`);
    expect(malformed.text).not.toContain('<title>记忆</title>');
    expect(seen.length).toBe(before);
    const notReady = await request(app).get(`/onboard/memory/notready/${sig}/`);
    expect(notReady.status).toBe(404);
    expect(notReady.text).toContain('今晚 9 点');
  });
});
