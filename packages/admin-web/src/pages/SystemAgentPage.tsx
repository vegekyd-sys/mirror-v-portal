import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import PodTerminalModal from '../components/PodTerminalModal';

type Status = {
  name: string; namespace: string; uiUrl: string; version: string;
  state: 'ready' | 'stopped' | 'starting'; image: string;
  pods: { name: string; phase: string; containers: { name: string; ready: boolean; restartCount: number }[] }[];
};
const ROOT = '/v1/admin/system-agent';

export default function SystemAgentPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState('');
  const [pod, setPod] = useState('');
  const [previous, setPrevious] = useState(false);
  const [frame, setFrame] = useState(0);
  const [terminal, setTerminal] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const next = await api<Status>(ROOT);
      setStatus(next); setError('');
      setPod(p => next.pods.some(v => v.name === p) ? p : next.pods[0]?.name || '');
    } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 10_000); return () => clearInterval(timer); }, [refresh]);
  const act = async (action: string) => {
    if (!status || busy) return;
    setBusy(true); setMessage('');
    try { const result = await api<{ message: string }>(`${ROOT}/${action}`, { method: 'POST', body: { version: status.version } }); setMessage(result.message); await refresh(); }
    catch (e) { setMessage(errMsg(e)); await refresh(); }
    finally { setBusy(false); }
  };
  const readLogs = async () => {
    setShowLogs(true);
    try { const r = await api<{ logs: string }>(`${ROOT}/logs?pod=${encodeURIComponent(pod)}&previous=${previous}`); setLogs(r.logs || '暂无日志'); }
    catch (e) { setLogs(errMsg(e)); }
  };
  const uiUrl = (() => {
    try {
      const u = new URL(status?.uiUrl || '');
      const expectedPath = '/nexus-manager/openclaw';
      return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
        && u.origin === window.location.origin
        && (u.pathname === expectedPath || u.pathname.startsWith(`${expectedPath}/`)) ? u.href : null;
    }
    catch { return null; }
  })();
  return <div>
    <div className="page-header"><h1>Nexus Manager</h1><p>DealClaw 项目管家 · 开发、部署、运维与报表</p></div>
    {error && <p role="alert">{error} <button className="btn" onClick={() => void refresh()}>重试</button></p>}
    {message && <p role="status">{message}</p>}
    <section className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong>{status ? ({ ready: 'Pod 已就绪', starting: '启动 / 更新中', stopped: '已停止' }[status.state]) : '等待实例信息'}</strong>
        <button className="btn" disabled={busy || !status || Boolean(error)} onClick={() => void act(status?.state === 'stopped' ? 'start' : 'stop')}>{status?.state === 'stopped' ? '启动' : '停止'}</button>
        <button className="btn" disabled={busy || !status || Boolean(error) || status.state === 'stopped'} onClick={() => void act('restart')}>重启</button>
        <button className="btn" disabled={!pod} onClick={() => void readLogs()}>Pod 日志</button>
        <button className="btn" disabled={!pod || status?.state !== 'ready'} onClick={() => setTerminal(true)}>Terminal</button>
        <button className="btn" onClick={() => setFrame(v => v + 1)}>刷新原生界面</button>
      </div>
      {status && <p style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{status.namespace} · {status.image}</p>}
      {showLogs && <div>
        <select aria-label="日志 Pod" value={pod} onChange={e => setPod(e.target.value)}>{status?.pods.map(p => <option key={p.name} value={p.name}>{p.name} ({p.phase})</option>)}</select>{' '}
        <label><input type="checkbox" checked={previous} onChange={e => setPrevious(e.target.checked)} />上一容器日志</label>{' '}
        <button className="btn" disabled={!pod} onClick={() => void readLogs()}>刷新日志</button>{' '}
        <button className="btn" onClick={() => setShowLogs(false)}>收起</button>
        <pre style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', background: '#111827', color: '#e5e7eb', padding: 16 }}>{logs}</pre>
        <small>最近 300 行；跨 Pod 历史请使用日志平台。</small>
      </div>}
    </section>
    {terminal && pod && <PodTerminalModal pod={pod} containers={['nexus-manager']} initialContainer="nexus-manager" execPath="/v1/admin/system-agent/exec" onClose={() => setTerminal(false)} />}
    <p>模型、渠道、Skills 与 OpenClaw 配置全部在下方原生界面管理，并持久化到 NAS；控制台不会在重启时修改它们。</p>
    {uiUrl ? <iframe key={frame} src={uiUrl} title="Nexus Manager 原生 OpenClaw 控制台"
      referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
      style={{ width: '100%', height: 'calc(100vh - 300px)', minHeight: 560, border: '1px solid #dbe2ea', borderRadius: 12, background: '#fff' }} />
      : <section className="card" style={{ padding: 32 }}>配置管理控制台同源的 OpenClaw UI 路径后，这里将显示原生界面。</section>}
  </div>;
}
