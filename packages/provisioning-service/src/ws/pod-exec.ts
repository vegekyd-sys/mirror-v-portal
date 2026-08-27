/**
 * Pod exec — interactive Web Terminal (admin console feature).
 *
 * Browser WS  →  provisioning-service  →  K8s apiserver exec WS
 * (custom JSON + raw stdin)      (v4.channel.k8s.io remotecommand framing)
 *
 * Why not an Express route: Express 4 has no WS upgrade support, so this
 * module attaches a `ws` WebSocketServer({ noServer: true }) to the HTTP
 * server and handles the `upgrade` event itself. Path:
 *   /v1/tenants/:tenantId/exec?pod=&container=&cmd=
 *
 * Auth: browsers cannot set custom WS headers, so the client must send
 * `{"type":"auth","token":"<service-token-or-admin-jwt>"}` as the FIRST
 * message within 5s. The token is validated with the exact same rules as
 * the Express auth middleware (see isValidServiceOrAdminToken).
 *
 * Channel framing (k8s remotecommand v4): every message is
 *   [1-byte stream type][payload]
 *   0=stdin  1=stdout  2=stderr  3=error  255=resize(JSON {Width,Height})
 */
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import {
  getTenantPod,
  isSafeK8sName,
  isSafeTenantId,
  openPodExecWs,
} from '../services/k8s-client.js';
import { tenantNamespace } from '../services/provisioning.js';
import { isValidServiceOrAdminToken } from '../middleware/auth.js';

const AUTH_TIMEOUT_MS = 5_000;
const MAX_CMD_PARTS = 8;

// Command segments are executable paths/args like `/bin/sh`, `-c`, `ls`.
// NOTE: isSafeK8sName() (RFC 1123 label) does NOT allow `/` or `.`, so it
// would reject the default `/bin/sh` — commands need their own charset.
const CMD_PART_RE = /^[a-zA-Z0-9._/-]{1,128}$/;

// remotecommand stream types
const STREAM_STDIN = 0;
const STREAM_STDOUT = 1;
const STREAM_STDERR = 2;
const STREAM_ERROR = 3;
const STREAM_RESIZE = 255;

/** Tokenize a shell command safely: split on whitespace, allow quoting. */
function parseCommand(raw: string): string[] | null {
  if (!raw || raw.trim().length === 0) return null;
  // Minimal tokenizer supporting single/double quotes (no shell evaluation).
  const parts: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const part = m[1] ?? m[2] ?? m[3];
    if (part) parts.push(part);
  }
  if (parts.length === 0 || parts.length > MAX_CMD_PARTS) return null;
  if (parts.some((p) => !CMD_PART_RE.test(p))) return null;
  return parts;
}

interface ExecTarget {
  tenantId: string;
  namespace: string;
  pod: string;
  container?: string;
  command: string[];
  tty: boolean;
}

function parseExecTarget(rawUrl: string | undefined): ExecTarget | { error: string } | null {
  if (!rawUrl) return null;
  const url = new URL(rawUrl, 'http://local');
  const m = url.pathname.match(/^\/v1\/tenants\/([0-9a-f]{32})\/exec$/);
  if (!m) return null; // not our path — leave for other handlers / 404
  const tenantId = m[1];
  if (!isSafeTenantId(tenantId)) return { error: 'tenantId 必须是 32 位十六进制 UUID' };

  const pod = url.searchParams.get('pod') ?? '';
  const container = url.searchParams.get('container') ?? undefined;
  const cmdRaw = url.searchParams.get('cmd') ?? '/bin/sh';
  const command = parseCommand(cmdRaw);

  if (!isSafeK8sName(pod)) return { error: 'pod 名称不合法（RFC 1123）' };
  if (container !== undefined && !isSafeK8sName(container)) return { error: 'container 名称不合法（RFC 1123）' };
  if (!command) return { error: 'cmd 参数不合法（最多 8 段，仅字母数字 ._- 和 /）' };

  return {
    tenantId,
    namespace: tenantNamespace(tenantId),
    pod,
    container,
    command,
    tty: url.searchParams.get('tty') !== 'false',
  };
}

/** Broadcast the k8s exec connection state to the browser channel. */
function sendJson(ws: WebSocket, obj: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

export function attachPodExecWebSocket(server: Server, authEnvVar = 'PROVISIONING_API_TOKEN') {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket: Duplex, head) => {
    // Only claim our own path; everything else is destroyed (no other
    // WS consumers exist on this service today).
    const target = parseExecTarget(req.url);
    if (target === null) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if ('error' in target) {
      socket.write(`HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n${target.error}`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleExecSession(ws, target, authEnvVar);
    });
  });

  return wss;
}

async function handleExecSession(browser: WebSocket, target: ExecTarget, authEnvVar: string) {
  let authed = false;
  const authTimer = setTimeout(() => {
    if (!authed) {
      sendJson(browser, { type: 'error', message: '认证超时：请在 5 秒内发送 {"type":"auth","token":"..."}' });
      browser.close(4001, 'auth timeout');
    }
  }, AUTH_TIMEOUT_MS);

  // ── k8s side ──
  let k8s: WebSocket | null = null;
  let closed = false;

  const cleanup = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    try { k8s?.close(); } catch { /* noop */ }
    if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) {
      browser.close(code ?? 1000, reason);
    }
  };

  const openK8sExec = async () => {
    try {
      // Defense in depth: pod must exist and carry the tenant label.
      const podObj = await getTenantPod(target.namespace, target.tenantId, target.pod);
      if (!podObj) {
        sendJson(browser, { type: 'error', message: 'Pod 不存在或不属于该租户' });
        browser.close(1008, 'pod not found');
        return;
      }
      k8s = await openPodExecWs(target.namespace, target.pod, {
        container: target.container,
        command: target.command,
        tty: target.tty,
      });

      // k8s → browser: unwrap the channel byte, forward payload.
      k8s.on('message', (data, isBinary) => {
        if (closed || browser.readyState !== WebSocket.OPEN) return;
        if (!isBinary) return; // exec channel is always binary-framed
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (buf.length === 0) return;
        const streamType = buf[0];
        const payload = buf.subarray(1);
        if (streamType === STREAM_STDOUT || streamType === STREAM_STDERR) {
          browser.send(payload, { binary: true });
        } else if (streamType === STREAM_ERROR) {
          sendJson(browser, { type: 'error', message: payload.toString('utf8') || 'exec error' });
        }
        // stdin echo (0) / resize ack (255) ignored
      });
      k8s.on('close', (code) => {
        sendJson(browser, { type: 'exit', code });
        cleanup(1000, 'session ended');
      });
      k8s.on('error', (err) => {
        sendJson(browser, { type: 'error', message: `k8s exec error: ${err.message}` });
        cleanup(1011, 'k8s exec error');
      });

      sendJson(browser, {
        type: 'ready',
        pod: target.pod,
        container: target.container ?? null,
        command: target.command.join(' '),
        tty: target.tty,
      });
    } catch (err: any) {
      sendJson(browser, { type: 'error', message: `exec 连接失败: ${err?.message || err}` });
      cleanup(1011, 'exec connect failed');
    }
  };

  // ── browser side ──
  browser.on('message', (data, isBinary) => {
    if (!authed) {
      // First message must be auth.
      if (isBinary) {
        browser.close(1008, 'auth required');
        return;
      }
      try {
        const msg = JSON.parse(String(data));
        if (msg?.type === 'auth' && isValidServiceOrAdminToken(msg.token, authEnvVar)) {
          authed = true;
          clearTimeout(authTimer);
          void openK8sExec();
        } else {
          sendJson(browser, { type: 'error', message: '认证失败：token 无效' });
          browser.close(4001, 'invalid token');
        }
      } catch {
        browser.close(1008, 'auth required');
      }
      return;
    }

    if (closed || !k8s || k8s.readyState !== WebSocket.OPEN) return;

    if (!isBinary) {
      // JSON control message (resize)
      try {
        const msg = JSON.parse(String(data));
        if (msg?.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          const width = Math.max(1, Math.min(500, Math.round(msg.cols)));
          const height = Math.max(1, Math.min(200, Math.round(msg.rows)));
          const payload = Buffer.from(JSON.stringify({ Width: width, Height: height }), 'utf8');
          k8s.send(Buffer.concat([Buffer.from([STREAM_RESIZE]), payload]), { binary: true });
        }
        return;
      } catch {
        // fall through — treat as stdin text
      }
    }

    // Raw terminal input → k8s stdin channel.
    const input = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    k8s.send(Buffer.concat([Buffer.from([STREAM_STDIN]), input]), { binary: true });
  });

  browser.on('close', () => cleanup(1000, 'browser closed'));
  browser.on('error', () => cleanup(1011, 'browser error'));
}
