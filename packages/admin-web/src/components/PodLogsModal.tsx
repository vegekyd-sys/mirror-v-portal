// Pod 日志查看器（管理控制台）— 历史拉取 + 实时跟随。
//
// - 历史模式：GET /v1/tenants/:id/logs（一次性 JSON）
// - 跟随模式：GET /v1/tenants/:id/logs/stream?follow=true（chunked 流式，
//   fetch + ReadableStream：同源请求可携带 Authorization 头，关闭窗口即
//   abort 上游 apiserver 请求）
// 过滤为纯前端「包含匹配」；自动滚动到底部（用户上翻时暂停自动跟随）。
import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { api, errMsg, getToken } from '../lib/api';
import { IconRefresh } from './icons';

const MAX_LOG_CHARS = 800_000;

interface PodLogsModalProps {
  tenantId: string;
  pod: string;
  containers: string[];
  initialContainer?: string;
  onClose: () => void;
}

export default function PodLogsModal({
  tenantId,
  pod,
  containers,
  initialContainer,
  onClose,
}: PodLogsModalProps) {
  const [container, setContainer] = useState(initialContainer || containers[0] || '');
  const [tailLines, setTailLines] = useState(500);
  const [timestamps, setTimestamps] = useState(false);
  const [follow, setFollow] = useState(true);
  const [filterText, setFilterText] = useState('');
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState('');
  // 日志本体存 ref（避免大字符串反复进 React state），tick 触发重渲染。
  const [, setTick] = useState(0);

  const logRef = useRef('');
  const preRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const appendLog = useCallback((chunk: string) => {
    logRef.current += chunk;
    if (logRef.current.length > MAX_LOG_CHARS) {
      logRef.current = logRef.current.slice(-Math.floor(MAX_LOG_CHARS / 2));
    }
    setTick((t) => t + 1);
    requestAnimationFrame(() => {
      if (stickRef.current && preRef.current) {
        preRef.current.scrollTop = preRef.current.scrollHeight;
      }
    });
  }, []);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    setErr('');
    logRef.current = '';
    stickRef.current = true;
    setTick((t) => t + 1);

    const q = new URLSearchParams({
      pod,
      tailLines: String(tailLines),
      timestamps: String(timestamps),
    });
    if (container) q.set('container', container);

    if (follow) {
      try {
        const res = await fetch(
          `/v1/tenants/${encodeURIComponent(tenantId)}/logs/stream?${q}&follow=true`,
          {
            headers: { Authorization: `Bearer ${getToken()}` },
            signal: ac.signal,
          },
        );
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({} as { message?: string }));
          throw new Error(body.message || `HTTP ${res.status}`);
        }
        setStreaming(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done || ac.signal.aborted) break;
          appendLog(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        if (!ac.signal.aborted) setErr(`实时流失败：${errMsg(e)}`);
      } finally {
        setStreaming(false);
        setLoading(false);
      }
    } else {
      try {
        const r = await api<{ logs: string }>(
          `/v1/tenants/${encodeURIComponent(tenantId)}/logs?${q}`,
        );
        logRef.current = r.logs || '';
        setTick((t) => t + 1);
        requestAnimationFrame(() => {
          if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
        });
      } catch (e) {
        setErr(`日志拉取失败：${errMsg(e)}`);
      } finally {
        setLoading(false);
      }
    }
  }, [tenantId, pod, container, tailLines, timestamps, follow, appendLog]);

  // 打开即加载；任何拉取参数变化自动重载（过滤除外——纯客户端）。
  useEffect(() => {
    void load();
  }, [load]);

  // 关闭/卸载时中断流。
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const clear = () => {
    logRef.current = '';
    setTick((t) => t + 1);
  };

  const text = logRef.current;
  const needle = filterText.trim();
  const visible = needle ? text.split('\n').filter((l) => l.includes(needle)).join('\n') : text;
  const lineCount = text ? text.replace(/\n$/, '').split('\n').length : 0;

  return (
    <Modal title={`Pod 日志 · ${pod}`} open onClose={onClose} width={920}>
      <div className="pod-console-bar">
        <label className="field-label">容器</label>
        <select value={container} onChange={(e) => setContainer(e.target.value)}>
          {containers.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <label className="field-label">行数</label>
        <select value={tailLines} onChange={(e) => setTailLines(Number(e.target.value))}>
          {[100, 500, 1000, 5000, 10000].map((n) => (
            <option key={n} value={n}>最近 {n}</option>
          ))}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} />
          时间戳
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          实时跟随
        </label>
        <button className="btn-secondary btn-sm" disabled={loading} onClick={() => void load()}>
          <IconRefresh /> {loading ? '加载中…' : '刷新'}
        </button>
        <button className="btn-secondary btn-sm" onClick={clear}>清空</button>
        <input
          type="text"
          className="mono"
          style={{ flex: '1 1 180px', minWidth: 140 }}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="过滤（包含匹配，仅本地过滤）"
        />
      </div>

      <pre ref={preRef} className="pod-log-view" onScroll={onScroll}>
        {visible || (loading ? '加载中…' : '(暂无日志输出)')}
      </pre>

      <div className="pod-console-status">
        <span>{lineCount.toLocaleString()} 行 · {(text.length / 1024).toFixed(1)} KB{needle ? ` · 过滤后 ${visible ? visible.split('\n').length : 0} 行` : ''}</span>
        {streaming && <span className="badge badge-active">跟随中</span>}
        {follow && !streaming && !loading && <span className="badge badge-pending">流已停止</span>}
        {err && <span style={{ color: '#c0392b' }}>{err}</span>}
        <span className="hint" style={{ margin: 0 }}>上翻日志时暂停自动滚动，回到底部后恢复。</span>
      </div>
    </Modal>
  );
}
