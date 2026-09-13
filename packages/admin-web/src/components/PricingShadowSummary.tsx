import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errMsg } from '../lib/api';
import type { PricingShadowSummary as PricingShadowSummaryData } from '../lib/modelCatalogTypes';
import { IconRefresh } from './icons';

/** Pricing shadow rollout health and a bounded list of delta samples. */
export default function PricingShadowSummary() {
  const [summary, setSummary] = useState<PricingShadowSummaryData | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api<PricingShadowSummaryData>('/v1/admin/llm-pricing/summary?limit=10');
      setSummary(result);
      setDisabled(false);
      setError('');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 503 && caught.code === 'DISABLED') {
        setDisabled(true);
        setSummary(null);
        setError('');
      } else {
        setError(errMsg(caught));
      }
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="form-card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>Pricing shadow summary</span>
        <span className="badge">只读比对</span>
        <button className="btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => void load()}>
          <IconRefresh /> 刷新
        </button>
      </div>
      {disabled ? (
        <div className="msg msg-warn">LLM pricing shadow disabled（功能开关未启用），不影响现有计费流程。</div>
      ) : error ? (
        <div className="msg msg-err">Pricing summary 请求失败：{error}</div>
      ) : summary === null ? (
        <div className="hint">加载中…</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            <span className="badge badge-active">Plans {summary.planCount}</span>
            {Object.entries(summary.shadowStatuses).map(([status, count]) => <span className="badge" key={status}>{status} {count}</span>)}
            <span className="badge">Legacy comparisons {summary.legacyComparisonCount}</span>
            <span className="badge badge-active">Zero delta {summary.deltaCounts.zero}</span>
            <span className="badge badge-warn">Nonzero delta {summary.deltaCounts.nonzero}</span>
          </div>
          {summary.deltaSamples.length === 0 ? <div className="hint">暂无 delta 样本。</div> : (
            <table>
              <thead><tr><th>时间</th><th>租户</th><th>Provider / Model</th><th>状态</th><th>新金额</th><th>Legacy</th><th>Delta</th></tr></thead>
              <tbody>{summary.deltaSamples.map((sample) => (
                <tr key={sample.usageEventId}>
                  <td style={{ fontSize: 11 }}>{new Date(sample.createdAt).toLocaleString()}</td>
                  <td className="mono">{sample.tenantId}</td><td className="mono">{sample.provider}/{sample.model}</td>
                  <td><span className="badge">{sample.status}</span></td>
                  <td>{sample.amount ?? '—'} {sample.currency ?? ''}</td><td>{sample.legacyAmount ?? '—'}</td>
                  <td className="mono">{sample.deltaAmount ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
