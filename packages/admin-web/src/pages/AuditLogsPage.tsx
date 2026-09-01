// 审计日志 — 所有管理端更改操作的记录（全局中间件自动捕获 + 高危操作
// 显式 old→new 快照）。Data: provisioning-service /v1/admin/audit-logs.
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { fmtTime, shortId } from '../components/badges';
import { IconBox, IconRefresh } from '../components/icons';

interface AuditLog {
  id: number;
  created_at: string;
  actor: string;
  actor_type: 'admin' | 'service' | 'external';
  action: string;
  method?: string | null;
  path?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  tenant_id?: string | null;
  old_value?: unknown;
  new_value?: unknown;
  status_code?: number | null;
  duration_ms?: number | null;
  ip?: string | null;
}

const PAGE_SIZE = 50;

/** Compact JSON preview for old/new value cells. */
function ValueCell({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') {
    return <span style={{ color: '#8494ad' }}>—</span>;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const isLong = text.length > 80 || text.includes('\n');
  if (!isLong) {
    return <code style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{text}</code>;
  }
  return (
    <details>
      <summary style={{ cursor: 'pointer', fontSize: 11, color: '#1677ff' }}>
        展开（{text.length} 字符）
      </summary>
      <pre
        style={{
          fontSize: 11,
          background: '#f6f9fd',
          padding: '6px 8px',
          borderRadius: 6,
          overflowX: 'auto',
          margin: '4px 0 0',
          maxHeight: 260,
          whiteSpace: 'pre-wrap',
        }}
      >
        {text}
      </pre>
    </details>
  );
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Filters
  const [fActor, setFActor] = useState('');
  const [fAction, setFAction] = useState('');
  const [fTenant, setFTenant] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');

  const load = useCallback(
    async (pageOffset: number) => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(pageOffset) });
        if (fActor.trim()) q.set('actor', fActor.trim());
        if (fAction.trim()) q.set('action', fAction.trim());
        if (fTenant.trim()) q.set('tenantId', fTenant.trim());
        if (fFrom) q.set('from', fFrom);
        if (fTo) q.set('to', fTo);
        const r = await api<{ logs: AuditLog[]; total: number }>(`/v1/admin/audit-logs?${q.toString()}`);
        setLogs(r.logs || []);
        setTotal(r.total || 0);
        setOffset(pageOffset);
        setError('');
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [fActor, fAction, fTenant, fFrom, fTo],
  );

  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actorBadge = (log: AuditLog) => {
    if (log.actor_type === 'admin') return <span className="badge badge-active">{log.actor}</span>;
    if (log.actor_type === 'external') return <span className="badge badge-warn">{log.actor}</span>;
    return <span className="badge">{log.actor}</span>;
  };

  const hasFilter = fActor || fAction || fTenant || fFrom || fTo;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">审计日志</div>
          <div className="page-sub">
            所有管理端更改操作的全量记录：操作人、动作、改前值 → 改后值；保留 180 天
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => void load(offset)} disabled={loading}>
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>
      {error && <div className="msg msg-err">{error}</div>}

      {/* ── 过滤器 ── */}
      <div className="panel" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: 12 }}>
        <input
          placeholder="操作人（如 wangjian）"
          value={fActor}
          onChange={(e) => setFActor(e.target.value)}
          style={{ width: 160 }}
          onKeyDown={(e) => e.key === 'Enter' && void load(0)}
        />
        <input
          placeholder="动作（如 image-release.promote）"
          value={fAction}
          onChange={(e) => setFAction(e.target.value)}
          style={{ width: 220 }}
          onKeyDown={(e) => e.key === 'Enter' && void load(0)}
        />
        <input
          placeholder="租户 ID"
          value={fTenant}
          onChange={(e) => setFTenant(e.target.value)}
          style={{ width: 220 }}
        />
        <label style={{ fontSize: 12, color: '#666' }}>
          从 <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: 12, color: '#666' }}>
          至 <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} />
        </label>
        <button className="btn-primary" onClick={() => void load(0)} disabled={loading}>
          查询
        </button>
        {hasFilter && (
          <button
            className="btn-secondary"
            onClick={() => {
              setFActor('');
              setFAction('');
              setFTenant('');
              setFFrom('');
              setFTo('');
              setTimeout(() => void load(0), 0);
            }}
          >
            清空条件
          </button>
        )}
      </div>

      {/* ── 列表 ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        记录（共 {total.toLocaleString()} 条 · 第 {page}/{pageCount} 页）
      </div>
      {loading && <div className="page-loading">加载中…</div>}
      {!loading && logs.length === 0 ? (
        <div className="panel">
          <div className="empty">
            <IconBox size={18} /> 暂无审计记录
          </div>
        </div>
      ) : (
        !loading && (
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 150 }}>时间</th>
                  <th style={{ width: 130 }}>操作人</th>
                  <th style={{ width: 170 }}>动作</th>
                  <th style={{ width: 240 }}>资源 / 租户</th>
                  <th>改前值 → 改后值</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td style={{ fontSize: 11, color: '#555' }} title={log.path ?? ''}>
                      {fmtTime(log.created_at)}
                      {log.method && (
                        <div style={{ color: '#8494ad', fontSize: 10 }}>
                          {log.method} {log.status_code ? `· ${log.status_code}` : ''}
                        </div>
                      )}
                    </td>
                    <td>{actorBadge(log)}</td>
                    <td>
                      <code style={{ fontSize: 11 }}>{log.action}</code>
                    </td>
                    <td style={{ fontSize: 11 }}>
                      {log.resource_type && <div>{log.resource_type}</div>}
                      {log.tenant_id && (
                        <div style={{ color: '#8494ad' }} title={log.tenant_id}>
                          租户 {shortId(log.tenant_id)}
                        </div>
                      )}
                      {!log.resource_type && !log.tenant_id && <span style={{ color: '#8494ad' }}>—</span>}
                    </td>
                    <td style={{ maxWidth: 480 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 10, color: '#8494ad', marginBottom: 2 }}>改前</div>
                          <ValueCell value={log.old_value} />
                        </div>
                        <span style={{ color: '#1677ff', paddingTop: 12 }}>→</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 10, color: '#8494ad', marginBottom: 2 }}>改后</div>
                          <ValueCell value={log.new_value} />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
        </div>
        )
      )}

      {/* ── 分页 ── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
        <button className="btn-secondary" disabled={offset === 0} onClick={() => void load(Math.max(offset - PAGE_SIZE, 0))}>
          上一页
        </button>
        <button
          className="btn-secondary"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => void load(offset + PAGE_SIZE)}
        >
          下一页
        </button>
      </div>

      <div className="hint">
        审计范围：所有非 GET 管理请求自动记录（含 API 直调）；镜像发布、模型供应商、租户状态/凭据/飞书绑定等高危操作额外记录改前→改后快照。Agent 对话上报等机器流量不入审计。
      </div>
    </>
  );
}
