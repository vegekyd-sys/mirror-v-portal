// 客户详情 — migrated from the legacy prebuilt SPA (view: detail).
// Data: credits-ledger GET /v1/admin/customers/:tenantId.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { fmtNum, fmtTime } from '../components/badges';

interface AuditEntry {
  id?: string | number;
  type: string;
  amount: number;
  balanceBefore?: number;
  balanceAfter?: number;
  reference?: string | null;
  description?: string | null;
  category?: string | null;
  time?: string;
}

interface BillingEvent {
  id?: string | number;
  skillId?: string;
  skillName?: string;
  credit?: number;
  quantity?: number;
  status?: 'settled' | 'estimated' | string;
  billingMode?: 'live' | 'shadow' | string;
  resultSummary?: string | null;
  time?: string;
}

interface DailyRow {
  day: string;
  skill?: string;
  totalCredit?: number;
  callCount?: number;
}

interface CustomerDetailData {
  tenantId: string;
  companyName?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  planTier?: string | null;
  planName?: string | null;
  balance?: number;
  frozenCredits?: number;
  availableBalance?: number;
  frozenReason?: string | null;
  lifetimeCredited?: number;
  lifetimeConsumed?: number;
  subscriptionStart?: string | null;
  subscriptionEnd?: string | null;
  status?: string | null;
  totalTasks?: number;
  consumed30d?: number;
  auditLog?: AuditEntry[];
  billingEvents?: BillingEvent[];
  skillBreakdown?: Record<string, number>;
  shadowBreakdown?: Record<string, number>;
  liveConsumed?: number;
  shadowConsumed?: number;
  dailyConsumption?: DailyRow[];
  dailyTotals?: { day: string; total: number }[];
}

const AUDIT_TYPE: Record<string, string> = {
  debit: '扣费',
  credit: '充值',
  freeze: '冻结',
  unfreeze: '解冻',
  reset: '月度重置',
};

type Tab = 'events' | 'audit' | 'daily';

export default function CustomerDetailPage() {
  const { tenantId = '' } = useParams();
  const [data, setData] = useState<CustomerDetailData | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('events');

  const load = useCallback(async () => {
    try {
      const r = await api<CustomerDetailData>(
        `/v1/admin/customers/${encodeURIComponent(tenantId)}`,
      );
      setData(r);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxDaily = useMemo(
    () => Math.max(1, ...(data?.dailyTotals || []).map((d) => d.total || 0)),
    [data],
  );

  const breakdown = (m?: Record<string, number>) =>
    Object.entries(m || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);

  if (error) {
    return (
      <>
        <div className="msg msg-err">加载失败：{error}</div>
        <Link to="/customers">← 返回客户列表</Link>
      </>
    );
  }
  if (!data) return <div className="page-loading">加载中…</div>;

  return (
    <>
      <div className="action-bar">
        <Link to="/customers">← 返回客户列表</Link>
        <button className="btn-secondary" onClick={() => void load()}>
          🔄 刷新
        </button>
      </div>

      <div className="section-title">
        {data.companyName || data.tenantId}
        <span className="mono" style={{ fontSize: 12, color: '#888', marginLeft: 12 }}>
          {data.tenantId}
        </span>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="num">{fmtNum(data.balance)}</div>
          <div className="label">账户余额</div>
        </div>
        <div className="stat-card">
          <div className="num">{fmtNum(data.frozenCredits)}</div>
          <div className="label">冻结·预留{data.frozenReason ? `（${data.frozenReason}）` : ''}</div>
        </div>
        <div className="stat-card">
          <div className="num">{fmtNum(data.availableBalance)}</div>
          <div className="label">可用余额</div>
        </div>
        <div className="stat-card">
          <div className="num">{fmtNum(data.lifetimeConsumed)}</div>
          <div className="label">累计消耗（近30天 {fmtNum(data.consumed30d)}）</div>
        </div>
        <div className="stat-card">
          <div className="num" style={{ fontSize: 18 }}>
            {data.planName || data.planTier || '-'}
          </div>
          <div className="label">当前套餐</div>
        </div>
        <div className="stat-card">
          <div className="num" style={{ fontSize: 18 }}>
            {data.status === 'active' ? '正常服务' : data.status || '-'}
          </div>
          <div className="label">账户状态（订阅至 {fmtTime(data.subscriptionEnd)}）</div>
        </div>
      </div>

      {/* ── 近 30 天消耗趋势 ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        近 30 天消耗趋势
      </div>
      {(data.dailyTotals || []).length === 0 ? (
        <div className="empty">近 30 天无消耗记录</div>
      ) : (
        <div className="bar-chart">
          {(data.dailyTotals || []).map((d) => (
            <div
              key={d.day}
              className="bar-col"
              title={`${d.day}：${fmtNum(d.total)} credits`}
            >
              <div
                className="bar"
                style={{ height: `${Math.max(2, ((d.total || 0) / maxDaily) * 100)}%` }}
              />
              <div className="bar-label">{d.day.slice(5)}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── 拆分 ── */}
      <div className="detail-grid" style={{ marginTop: 20 }}>
        <div className="form-card" style={{ marginBottom: 0 }}>
          <div style={{ fontSize: 13, color: '#171c2e', fontWeight: 600, marginBottom: 8 }}>
            已结算消耗：{fmtNum(data.liveConsumed)} credits
          </div>
          {breakdown(data.skillBreakdown).length === 0 ? (
            <div className="empty" style={{ padding: '6px 0' }}>
              暂无
            </div>
          ) : (
            breakdown(data.skillBreakdown).map(([name, v]) => (
              <div key={name} className="kv-row">
                <span>{name}</span>
                <span className="mono">{fmtNum(v)}</span>
              </div>
            ))
          )}
        </div>
        <div className="form-card" style={{ marginBottom: 0 }}>
          <div style={{ fontSize: 13, color: '#171c2e', fontWeight: 600, marginBottom: 8 }}>
            内测消耗（不扣费）：{fmtNum(data.shadowConsumed)} credits
          </div>
          {breakdown(data.shadowBreakdown).length === 0 ? (
            <div className="empty" style={{ padding: '6px 0' }}>
              暂无
            </div>
          ) : (
            breakdown(data.shadowBreakdown).map(([name, v]) => (
              <div key={name} className="kv-row">
                <span>{name}</span>
                <span className="mono">{fmtNum(v)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── 日志 tabs ── */}
      <div className="tabs" style={{ marginTop: 24 }}>
        <button className={tab === 'events' ? 'tab active' : 'tab'} onClick={() => setTab('events')}>
          Skill 调用日志
        </button>
        <button className={tab === 'audit' ? 'tab active' : 'tab'} onClick={() => setTab('audit')}>
          转账日志
        </button>
        <button className={tab === 'daily' ? 'tab active' : 'tab'} onClick={() => setTab('daily')}>
          按日明细
        </button>
      </div>

      {tab === 'events' &&
        ((data.billingEvents || []).length === 0 ? (
          <div className="empty">暂无调用记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>Skill</th>
                <th>结果摘要</th>
                <th>数量</th>
                <th>Credits</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {(data.billingEvents || []).map((e, i) => (
                <tr key={e.id ?? i}>
                  <td style={{ fontSize: 11, color: '#777' }}>{fmtTime(e.time)}</td>
                  <td>
                    {e.skillName || e.skillId}
                    <br />
                    <span className="mono" style={{ fontSize: 10, color: '#666' }}>
                      {e.skillId}
                    </span>
                  </td>
                  <td style={{ maxWidth: 320 }}>{e.resultSummary || '-'}</td>
                  <td className="mono">{e.quantity ?? 1}</td>
                  <td className="mono">{fmtNum(e.credit)}</td>
                  <td>
                    <span
                      className={`badge ${
                        e.status === 'settled'
                          ? 'badge-active'
                          : e.billingMode === 'shadow'
                            ? 'badge-pending'
                            : 'badge-warn'
                      }`}
                    >
                      {e.status === 'settled' ? '已结算' : e.billingMode === 'shadow' ? '内测' : '预估中'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      {tab === 'audit' &&
        ((data.auditLog || []).length === 0 ? (
          <div className="empty">暂无转账记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>金额</th>
                <th>余额变化</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {(data.auditLog || []).map((l, i) => (
                <tr key={l.id ?? i}>
                  <td style={{ fontSize: 11, color: '#777' }}>{fmtTime(l.time)}</td>
                  <td>
                    <span
                      className={`badge ${
                        l.type === 'credit'
                          ? 'badge-active'
                          : l.type === 'debit'
                            ? 'badge-failed'
                            : 'badge-warn'
                      }`}
                    >
                      {AUDIT_TYPE[l.type] || l.type}
                    </span>
                  </td>
                  <td className="mono">{fmtNum(l.amount)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {fmtNum(l.balanceBefore)} → {fmtNum(l.balanceAfter)}
                  </td>
                  <td>{l.description || l.reference || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      {tab === 'daily' &&
        ((data.dailyConsumption || []).length === 0 ? (
          <div className="empty">暂无按日明细</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>Skill</th>
                <th>调用次数</th>
                <th>消耗 Credits</th>
              </tr>
            </thead>
            <tbody>
              {(data.dailyConsumption || []).map((d, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 12 }}>{d.day}</td>
                  <td>{d.skill || '-'}</td>
                  <td className="mono">{fmtNum(d.callCount)}</td>
                  <td className="mono">{fmtNum(d.totalCredit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      <div className="hint">
        Skill 调用来自 skill_billing_events（约 1 秒延迟）；转账记录来自 credits_transactions。
      </div>
    </>
  );
}
