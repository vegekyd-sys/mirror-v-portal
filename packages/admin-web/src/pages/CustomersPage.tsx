// 客户与 Credits — migrated from the legacy prebuilt SPA (view: customers).
// Data: credits-ledger GET /v1/admin/customers (+ plans for the create form).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { fmtNum } from '../components/badges';
import Modal from '../components/Modal';

interface Customer {
  accountId: string;
  tenantId: string;
  companyName?: string | null;
  planTier?: string | null;
  planId?: string | null;
  balance?: number;
  frozenCredits?: number;
  availableBalance?: number;
  frozenReason?: string | null;
  monthlyAllowance?: number;
  monthlyUsed?: number;
  lifetimeConsumed?: number;
  totalConsumed?: number;
  totalTasks?: number;
  status?: string | null;
  subscriptionEnd?: string | null;
  createdAt?: string | null;
}

interface CustomerStats {
  active?: number;
  totalBalance?: number;
  totalConsumed?: number;
  lowBalance?: number;
  total?: number;
  closed?: number;
}

interface Plan {
  planId: string;
  planName: string;
  tier?: string;
  annualFeeYuan?: number;
  initialCredit?: number;
}

const emptyCreate = {
  tenantId: '',
  companyName: '',
  contactName: '',
  contactEmail: '',
  planId: '',
};

export default function CustomersPage() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stats, setStats] = useState<CustomerStats>({});
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [sortBy, setSortBy] = useState<'consumed' | 'balance' | 'name'>('consumed');

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ ...emptyCreate });
  const [createErr, setCreateErr] = useState('');
  const [creating, setCreating] = useState(false);

  const [topupFor, setTopupFor] = useState<Customer | null>(null);
  const [topupAmount, setTopupAmount] = useState('100000');
  const [topupReason, setTopupReason] = useState('');
  const [topupBusy, setTopupBusy] = useState(false);
  const [topupErr, setTopupErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ customers: Customer[]; stats?: CustomerStats }>(
        '/v1/admin/customers',
      );
      setCustomers(r.customers || []);
      setStats(r.stats || {});
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
    api<{ plans: Plan[] }>('/v1/admin/plans')
      .then((r) => setPlans(r.plans || []))
      .catch(() => {});
  }, [load]);

  const tiers = useMemo(
    () => Array.from(new Set(customers.map((c) => c.planTier).filter(Boolean))) as string[],
    [customers],
  );

  const rows = useMemo(() => {
    let list = customers;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (c) =>
          (c.companyName || '').toLowerCase().includes(q) ||
          c.tenantId.toLowerCase().includes(q),
      );
    }
    if (tierFilter) list = list.filter((c) => c.planTier === tierFilter);
    return [...list].sort((a, b) => {
      if (sortBy === 'consumed') return (b.lifetimeConsumed || 0) - (a.lifetimeConsumed || 0);
      if (sortBy === 'balance') return (b.balance || 0) - (a.balance || 0);
      return (a.companyName || '').localeCompare(b.companyName || '');
    });
  }, [customers, search, tierFilter, sortBy]);

  const createCustomer = async () => {
    const body = {
      tenantId: createForm.tenantId.trim(),
      companyName: createForm.companyName.trim() || undefined,
      contactName: createForm.contactName.trim() || undefined,
      contactEmail: createForm.contactEmail.trim() || undefined,
      planId: createForm.planId,
    };
    if (!body.tenantId || !body.planId) {
      setCreateErr('租户 ID 与套餐为必填');
      return;
    }
    setCreating(true);
    setCreateErr('');
    try {
      const r = await api<{ ok: boolean; accountId?: string; message?: string; error?: string }>(
        '/v1/admin/customers',
        { method: 'POST', body },
      );
      if (r.ok === false) throw new Error(r.error || '创建失败');
      setShowCreate(false);
      setCreateForm({ ...emptyCreate });
      await load();
    } catch (e) {
      setCreateErr(errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  const doTopup = async () => {
    if (!topupFor) return;
    const amount = Number(topupAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setTopupErr('充值金额必须为正数');
      return;
    }
    setTopupBusy(true);
    setTopupErr('');
    try {
      const r = await api<{ balanceAfter?: number; message?: string }>(
        `/v1/admin/customers/${encodeURIComponent(topupFor.tenantId)}/topup`,
        { method: 'POST', body: { amount, reason: topupReason.trim() || undefined } },
      );
      setTopupFor(null);
      setTopupAmount('100000');
      setTopupReason('');
      window.alert(`充值成功，当前余额 ${fmtNum(r.balanceAfter)} credits`);
      await load();
    } catch (e) {
      setTopupErr(errMsg(e));
    } finally {
      setTopupBusy(false);
    }
  };

  return (
    <>
      <div className="section-title">客户与 Credits</div>

      {error && <div className="msg msg-err">加载失败：{error}</div>}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="num">{stats.active ?? 0}</div>
          <div className="label">活跃客户</div>
        </div>
        <div className="stat-card">
          <div className="num">{fmtNum(stats.totalBalance)}</div>
          <div className="label">总余额（credits）</div>
        </div>
        <div className="stat-card">
          <div className="num">{fmtNum(stats.totalConsumed)}</div>
          <div className="label">累计消耗</div>
        </div>
        <div className="stat-card">
          <div className="num">{stats.lowBalance ?? 0}</div>
          <div className="label">低余额预警（&lt;50,000）</div>
        </div>
      </div>

      <div className="action-bar" style={{ marginTop: 20 }}>
        <input
          type="text"
          placeholder="搜索公司 / 租户 ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 200 }}
        />
        <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
          <option value="">全部套餐</option>
          {tiers.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
        >
          <option value="consumed">按消耗排序</option>
          <option value="balance">按余额排序</option>
          <option value="name">按名称排序</option>
        </select>
        <button className="btn-secondary" onClick={() => void load()}>
          🔄 刷新
        </button>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          ➕ 新建客户账户
        </button>
        <span style={{ fontSize: 12, color: '#666' }}>{rows.length} 个客户</span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">暂无客户</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>客户</th>
              <th>套餐</th>
              <th>余额 / 可用</th>
              <th>已消耗（任务数）</th>
              <th>冻结</th>
              <th>状态</th>
              <th style={{ width: 150 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.tenantId}
                className="clickable"
                onClick={() => navigate(`/customers/${encodeURIComponent(c.tenantId)}`)}
              >
                <td>
                  {c.companyName || c.tenantId}
                  <br />
                  <span style={{ fontSize: 11, color: '#777' }}>{c.tenantId}</span>
                </td>
                <td>
                  <span className="badge badge-plan-starter">{c.planTier || '-'}</span>
                </td>
                <td className="mono">
                  {fmtNum(c.balance)} / {fmtNum(c.availableBalance)}
                </td>
                <td className="mono">
                  {fmtNum(c.lifetimeConsumed)}（{fmtNum(c.totalTasks)}）
                </td>
                <td className="mono">{fmtNum(c.frozenCredits)}</td>
                <td>
                  <span
                    className={`badge ${c.status === 'active' ? 'badge-active' : c.status === 'suspended' ? 'badge-failed' : 'badge-dead'}`}
                  >
                    {c.status || '-'}
                  </span>
                </td>
                <td>
                  <button
                    className="btn-secondary btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/customers/${encodeURIComponent(c.tenantId)}`);
                    }}
                  >
                    详情
                  </button>{' '}
                  <button
                    className="btn-primary btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTopupFor(c);
                      setTopupErr('');
                    }}
                  >
                    充值
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="hint">
        数据来源：credits-ledger <code>GET /v1/admin/customers</code>
        。点击行查看消耗明细、调用日志与转账记录。
      </div>

      {/* ── 新建客户 ── */}
      <Modal title="新建客户账户" open={showCreate} onClose={() => setShowCreate(false)}>
        {createErr && <div className="msg msg-err">{createErr}</div>}
        <div className="form-row">
          <label className="field-label">租户 ID</label>
          <input
            type="text"
            value={createForm.tenantId}
            onChange={(e) => setCreateForm({ ...createForm, tenantId: e.target.value })}
            placeholder="小写字母/数字/连字符，如 acme-corp"
          />
        </div>
        <div className="form-row">
          <label className="field-label">公司名称</label>
          <input
            type="text"
            value={createForm.companyName}
            onChange={(e) => setCreateForm({ ...createForm, companyName: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="field-label">联系人</label>
          <input
            type="text"
            value={createForm.contactName}
            onChange={(e) => setCreateForm({ ...createForm, contactName: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="field-label">联系邮箱</label>
          <input
            type="text"
            value={createForm.contactEmail}
            onChange={(e) => setCreateForm({ ...createForm, contactEmail: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="field-label">套餐</label>
          <select
            value={createForm.planId}
            onChange={(e) => setCreateForm({ ...createForm, planId: e.target.value })}
          >
            <option value="">选择套餐…</option>
            {plans.map((p) => (
              <option key={p.planId} value={p.planId}>
                {p.planName} · ¥{fmtNum(p.annualFeeYuan)}/年 · 初始 {fmtNum(p.initialCredit)}{' '}
                credits
              </option>
            ))}
          </select>
        </div>
        <div className="hint">
          创建账户 <code>acct_&lt;tenantId&gt;</code>
          ，按套餐发放初始 Credits，订阅期一年。已存在的租户将重新激活。
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={() => void createCustomer()} disabled={creating}>
            {creating ? '创建中…' : '创建'}
          </button>
          <button className="btn-secondary" onClick={() => setShowCreate(false)}>
            取消
          </button>
        </div>
      </Modal>

      {/* ── 充值 ── */}
      <Modal
        title={`充值 Credits — ${topupFor?.companyName || topupFor?.tenantId || ''}`}
        open={!!topupFor}
        onClose={() => setTopupFor(null)}
      >
        {topupErr && <div className="msg msg-err">{topupErr}</div>}
        <div className="form-row">
          <label className="field-label">金额</label>
          <input
            type="number"
            min={1}
            step={10000}
            value={topupAmount}
            onChange={(e) => setTopupAmount(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="field-label">原因</label>
          <input
            type="text"
            value={topupReason}
            onChange={(e) => setTopupReason(e.target.value)}
            placeholder="如：年度续费充值"
          />
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={() => void doTopup()} disabled={topupBusy}>
            {topupBusy ? '充值中…' : '确认充值'}
          </button>
          <button className="btn-secondary" onClick={() => setTopupFor(null)}>
            取消
          </button>
        </div>
      </Modal>
    </>
  );
}
