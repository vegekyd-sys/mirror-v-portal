// Pod 终端（管理控制台）— 浏览器 xterm.js ⇋ provisioning-service WS ⇋ K8s exec。
//
// 认证：浏览器 WS 无法携带自定义 Authorization 头，连接建立后第一条消息
// 发送 {"type":"auth","token":"<admin-jwt>"}（5 秒内），由后端校验后才打通
// K8s exec 通道（见 provisioning-service src/ws/pod-exec.ts）。
//
// 帧协议（与后端约定）：
//   浏览器 → 服务端：二进制帧 = 终端输入（stdin）；文本 JSON = 控制（resize）
//   服务端 → 浏览器：二进制帧 = 终端输出；文本 JSON = 状态（ready/error/exit）
// 终端输入必须以二进制发送——后端把「可 JSON.parse 的文本」当作控制消息。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import Modal from './Modal';
import { getToken } from '../lib/api';

type TermPhase = 'connecting' | 'connected' | 'closed' | 'error';

interface PodTerminalModalProps {
  pod: string;
  containers: string[];
  initialContainer?: string;
  onClose: () => void;
  /** Tenant terminal endpoint, or the fixed Nexus Manager endpoint. */
  tenantId?: string;
  execPath?: string;
}

export default function PodTerminalModal({
  pod,
  containers,
  initialContainer,
  onClose,
  tenantId,
  execPath,
}: PodTerminalModalProps) {
  const [container, setContainer] = useState(initialContainer || containers[0] || '');
  const [phase, setPhase] = useState<TermPhase>('connecting');
  const [errText, setErrText] = useState('');

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const encoderRef = useRef(new TextEncoder());

  // 终端生命周期 = 弹窗生命周期：打开时创建 xterm，关闭时销毁并断开 WS。
  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      fontSize: 12,
      cursorBlink: true,
      fontFamily: "'SF Mono', Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#c9d1d9',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try { fit.fit(); } catch { /* 容器尚未可见时忽略 */ }

    // 输入/resize handler 只注册一次，通过 wsRef 引用当前连接。
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encoderRef.current.encode(data)); // 二进制 → stdin 通道
      }
    });
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });
    const onWinResize = () => {
      try { fit.fit(); } catch { /* noop */ }
    };
    window.addEventListener('resize', onWinResize);

    termRef.current = term;
    fitRef.current = fit;

    return () => {
      window.removeEventListener('resize', onWinResize);
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  const connect = useCallback(() => {
    const term = termRef.current;
    if (!term || !container) return;
    disconnect();
    term.reset();
    setPhase('connecting');
    setErrText('');

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ pod, container, cmd: '/bin/sh' });
    const path = execPath ?? `/v1/tenants/${encodeURIComponent(tenantId || '')}/exec`;
    const url = `${proto}://${window.location.host}${path}?${q}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setPhase('error');
      setErrText(`无法创建 WebSocket：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      // 首消息认证（浏览器 WS 无法带 Authorization 头）。
      ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data) as {
            type?: string;
            pod?: string;
            command?: string;
            code?: number;
            message?: string;
          };
          if (msg.type === 'ready') {
            setPhase('connected');
            term.write(`\x1b[32m[已连接 ${msg.pod} · ${msg.command}]\x1b[0m\r\n`);
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          } else if (msg.type === 'error') {
            setErrText(msg.message || 'exec 错误');
            term.write(`\x1b[31m[错误] ${msg.message}\x1b[0m\r\n`);
          } else if (msg.type === 'exit') {
            setPhase('closed');
            term.write(`\x1b[33m[会话已结束 exit=${msg.code}]\x1b[0m\r\n`);
          }
        } catch {
          term.write(ev.data);
        }
      } else {
        term.write(new Uint8Array(ev.data));
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return; // 已被新连接替换
      setPhase((p) => {
        if (p === 'connected') {
          term.write('\x1b[33m[连接已断开]\x1b[0m\r\n');
          return 'closed';
        }
        if (p === 'connecting') {
          setErrText('连接失败或认证被拒（检查登录状态与网络/网关 WS 支持）');
          return 'error';
        }
        return p;
      });
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setErrText('WebSocket 错误（网关可能不支持该路径的 WS 升级）');
    };

    term.focus();
  }, [tenantId, execPath, pod, container, disconnect]);

  // 弹窗打开且终端就绪后自动连接；切换容器自动重连。
  useEffect(() => {
    const t = window.setTimeout(() => connect(), 50); // 等 xterm 挂载完成
    return () => window.clearTimeout(t);
  }, [connect]);

  const phaseBadge =
    phase === 'connected' ? (
      <span className="badge badge-active">已连接</span>
    ) : phase === 'connecting' ? (
      <span className="badge badge-pending">连接中…</span>
    ) : phase === 'error' ? (
      <span className="badge badge-failed">连接失败</span>
    ) : (
      <span className="badge badge-warn">已断开</span>
    );

  return (
    <Modal title={`Pod 终端 · ${pod}`} open onClose={onClose} width={880}>
      <div className="pod-console-bar">
        <label className="field-label">容器</label>
        <select value={container} onChange={(e) => setContainer(e.target.value)}>
          {containers.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        {phaseBadge}
        {phase === 'connected' ? (
          <button className="btn-secondary btn-sm" onClick={disconnect}>断开</button>
        ) : (
          <button className="btn-secondary btn-sm" onClick={connect}>重连</button>
        )}
        <span className="hint" style={{ margin: 0, flex: 1 }}>
          进入容器 <span className="mono">/bin/sh</span>，可执行 ls / cat / tail 等查看文件。退出输入 exit。
        </span>
      </div>

      <div ref={hostRef} className="pod-term-host" />

      <div className="pod-console-status">
        {errText && <span style={{ color: '#c0392b' }}>{errText}</span>}
        <span className="hint" style={{ margin: 0 }}>
          终端会话以该 Agent 容器身份运行，操作等同 kubectl exec，请谨慎执行写操作。
        </span>
      </div>
    </Modal>
  );
}
