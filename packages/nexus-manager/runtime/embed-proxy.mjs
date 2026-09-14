import http from 'node:http';
import { httpsOrigin, normalizeUiBasePath } from './bootstrap.mjs';

// Preserve every CSP directive except framing. This adapter never supplies Gateway auth.
export function embedHeaders(headers, adminOrigin, pathname) {
  const out = { ...headers };
  const uiDocument = String(out['content-type'] || '').includes('text/html')
    && !pathname.startsWith('/__openclaw__') && !pathname.startsWith('/api/') && !pathname.startsWith('/plugins/');
  if (uiDocument) {
    delete out['x-frame-options'];
    const policies = out['content-security-policy'] ? [out['content-security-policy']].flat() : ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' data:; object-src 'none'"];
    out['content-security-policy'] = policies.map(p => String(p).split(';')
      .filter(d => !/^\s*frame-ancestors\b/i.test(d)).concat(` frame-ancestors ${httpsOrigin(adminOrigin)}`).join(';'));
    out['cache-control'] = 'no-store';
  }
  return out;
}

export function createEmbedProxy({ adminOrigin, uiOrigin, uiBasePath = '', port = 18790 }) {
  const origin = httpsOrigin(adminOrigin);
  const gatewayOrigin = httpsOrigin(uiOrigin);
  const basePath = normalizeUiBasePath(uiBasePath);
  function relativePath(raw) {
    const pathname = new URL(raw || '/', gatewayOrigin).pathname;
    if (/%2f|%5c/i.test(pathname)) return null;
    if (!basePath) return pathname;
    if (pathname === basePath) return '/';
    return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
  }
  function headers(req, includeForwarding = true) {
    const h = { ...req.headers };
    // Do not let an external caller impersonate an identity-aware proxy.
    for (const key of Object.keys(h)) {
      if (key.startsWith('x-forwarded-') || key.startsWith('x-openclaw-') || key.startsWith('tailscale-') || ['forwarded', 'x-real-ip', 'remote-user', 'x-auth-request-user', 'x-auth-request-email'].includes(key)) delete h[key];
    }
    h.host = new URL(gatewayOrigin).host;
    // OpenClaw 2026.9.4 requires a non-loopback client attribution for trusted
    // proxy traffic. Kubelet probes are local control traffic, so present those
    // directly and attach the immediate peer only to external UI requests.
    if (includeForwarding) {
      h['x-forwarded-for'] = req.socket.remoteAddress || 'unknown';
      h['x-forwarded-proto'] = 'https';
    }
    return h;
  }
  const server = http.createServer((req, res) => {
    const relative = relativePath(req.url);
    // Root probes are for kubelet; only the configured UI prefix goes to ALB.
    if (relative === null && !['/healthz', '/readyz'].includes(req.url || '')) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const probe = ['/healthz', '/readyz'].includes(req.url || '');
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: headers(req, !probe) }, r => {
      res.writeHead(r.statusCode || 502, embedHeaders(r.headers, origin, relative || req.url || '/'));
      r.pipe(res);
      r.on('error', () => res.destroy());
    });
    upstream.setTimeout(60_000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Gateway unavailable'); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (relativePath(req.url) === null) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    // Browser WS origins must be the embedded document's origin, not the parent's.
    if (req.headers.origin && req.headers.origin !== gatewayOrigin) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = http.request({ host: '127.0.0.1', port, path: req.url, headers: headers(req) });
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.on('upgrade', (r, peer, upstreamHead) => {
      peer.setTimeout(0);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${r.rawHeaders.reduce((s, v, i, a) => i % 2 === 0 ? s + `${v}: ${a[i + 1]}\r\n` : s, '')}\r\n`);
      if (head.length) peer.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(peer).pipe(socket);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
    });
    upstream.on('response', r => { r.resume(); socket.end(`HTTP/1.1 ${r.statusCode || 502} Gateway rejected\r\nConnection: close\r\n\r\n`); });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.end();
  });
  return server;
}
