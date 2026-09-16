import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { bootstrap, normalizeUiBasePath } from './bootstrap.mjs';
import { createEmbedProxy, embedHeaders } from './embed-proxy.mjs';

test('startup creates only persistent directories and never initializes OpenClaw configuration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-manager-'));
  try {
    const env = { NEXUS_ADMIN_ORIGIN: 'https://admin.example.com', NEXUS_UI_ORIGIN: 'https://admin.example.com',
      OPENCLAW_HOME: `${root}/home`, OPENCLAW_STATE_DIR: `${root}/state`, OPENCLAW_CONFIG_PATH: `${root}/state/openclaw.json`,
      OPENCLAW_WORKSPACE_DIR: `${root}/workspace`, NEXUS_UI_BASE_PATH: '/nexus-manager/openclaw/' };
    const result = bootstrap(env);
    assert.equal(fs.existsSync(env.OPENCLAW_CONFIG_PATH), false);
    assert.equal(fs.existsSync(env.OPENCLAW_HOME), true);
    assert.equal(fs.existsSync(env.OPENCLAW_STATE_DIR), true);
    assert.equal(fs.existsSync(env.OPENCLAW_WORKSPACE_DIR), true);
    assert.equal(result.uiBasePath, '/nexus-manager/openclaw');

    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, '{"native":"edited"}');
    fs.writeFileSync(`${root}/workspace/progress.txt`, 'work');
    bootstrap(env);
    assert.equal(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, 'utf8'), '{"native":"edited"}');
    assert.equal(fs.readFileSync(`${root}/workspace/progress.txt`, 'utf8'), 'work');
    assert.doesNotThrow(() => bootstrap(env));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('restart leaves every native OpenClaw setting byte-for-byte unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-manager-routing-'));
  try {
    const state = `${root}/state`;
    fs.mkdirSync(state, { recursive: true });
    const configPath = `${state}/openclaw.json`;
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { controlUi: { allowedOrigins: ['https://manager.example.com'], basePath: '/old', theme: 'dark' } },
      plugins: { allow: ['feishu'], load: { paths: ['/custom/plugin', '/opt/nexus-manager/plugins/feishu/node_modules/@openclaw/feishu'] } },
      channels: { feishu: { enabled: true } },
    }));
    const env = { NEXUS_ADMIN_ORIGIN: 'https://admin.example.com', NEXUS_UI_ORIGIN: 'https://admin.example.com',
      OPENCLAW_HOME: `${root}/home`, OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_WORKSPACE_DIR: `${root}/workspace`,
      NEXUS_UI_BASE_PATH: '/nexus-manager/openclaw' };
    const before = fs.readFileSync(configPath, 'utf8');
    bootstrap(env);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('base paths reject traversal, encoded separators and URL injection', () => {
  assert.equal(normalizeUiBasePath('/nexus-manager/openclaw/'), '/nexus-manager/openclaw');
  assert.equal(normalizeUiBasePath('/'), '');
  for (const p of ['/a/../b', '/a%2fb', '//example.com', '/a?b=c', '/a#b', '/a\\b']) assert.throws(() => normalizeUiBasePath(p));
});

test('embedding only relaxes frame ancestors for UI documents, preserves widget sandbox and CSP', () => {
  const h = { 'content-type': 'text/html', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none'; object-src 'none'" };
  const result = embedHeaders(h, 'https://admin.example.com', '/chat');
  assert.equal(result['x-frame-options'], undefined);
  assert.ok(result['content-security-policy'][0].includes("script-src 'self'"));
  assert.ok(result['content-security-policy'][0].includes('frame-ancestors https://admin.example.com'));
  assert.deepEqual(embedHeaders(h, 'https://admin.example.com', '/__openclaw__/canvas'), h);
  assert.throws(() => embedHeaders(h, 'https://admin.example.com/path', '/'));
});

test('proxy forwards HTTP and WebSocket without supplying auth, rejects foreign WS origins', { timeout: 10_000 }, async () => {
  let seen;
  const upstream = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "script-src 'self'; frame-ancestors 'none'" });
    res.end('native ui');
  });
  upstream.on('upgrade', (req, socket) => {
    seen = req.headers;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', data => socket.write(data));
    socket.on('end', () => socket.destroy());
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const proxy = createEmbedProxy({ adminOrigin: 'https://admin.example.com', uiOrigin: 'https://manager.example.com', uiBasePath: '/nexus-manager/openclaw', port: upstream.address().port });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/nexus-manager/openclaw/`, { headers: { 'x-openclaw-user': 'spoof', 'x-forwarded-user': 'spoof' } });
    assert.equal(await r.text(), 'native ui');
    assert.equal(seen['x-openclaw-user'], undefined); assert.equal(seen['x-forwarded-user'], undefined); assert.equal(seen.authorization, undefined);
    assert.equal(seen['x-forwarded-for'], '127.0.0.1');
    assert.ok(r.headers.get('content-security-policy').includes('https://admin.example.com'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200);
    assert.equal(seen['x-forwarded-for'], undefined);
    assert.equal((await fetch(`http://127.0.0.1:${port}/tenant/other/`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/nexus-manager/openclaw-other/`)).status, 404);
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/nexus-manager/openclaw/', headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: 'https://manager.example.com' } });
      req.on('upgrade', (_res, socket) => { socket.on('data', data => { assert.equal(data.toString(), 'ping'); socket.destroy(); resolve(); }); socket.write('ping'); });
      req.on('error', reject); req.end();
    });
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/nexus-manager/openclaw/', headers: { Upgrade: 'websocket', Connection: 'Upgrade', Origin: 'https://evil.example.com' } }, r => { assert.equal(r.statusCode, 403); r.resume(); r.on('end', resolve); });
      req.on('error', reject); req.end();
    });
  } finally { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]); }
});
