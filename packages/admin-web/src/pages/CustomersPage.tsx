// 客户与 Credits — 合并原「租户管理」后的客户统一视图。
// 数据：credits-ledger GET /v1/admin/customers；租户状态与开通来自 provisioning-service
// GET /v1/tenants；创建客户走 provisioning POST /v1/tenants（真实开通 K8s + 计费账户）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import type { Tenant } from '../lib/types';
import { fmtNum } from '../components/badges';
import Modal from '../components/Modal';
import {
  IconChevronDown,
  IconPlus,
  IconRefresh,
  IconSearch,
} from '../components/icons';

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

const emptyCreate = {
  companyName: '',
  contactEmail: '',
  contactPhone: '',
  planTier: 'starter',
  quotaAgents: '1',
  quotaCreditsMonthly: '1000000',
  botAppId: '',
  botAppSecret: '',
};

const dotTone = (status?: string | null): string => {
  switch (status) {
    case 'active':
      return 'green';
    case 'suspended':
    case 'grace':
    case 'low_credits':
      return 'orange';
    case 'pending':
    case 'provisioning':
      return 'blue';
    case 'provisioning_failed':
    case 'destroyed':
      return 'red';
    default:
      return '';
  }
};

export default function CustomersPage() {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stats, setStats] = useState<CustomerStats>({});
  const [tenants, setTenants] = useState<Record<string, Tenant>>({});
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
    api<{ tenants: Tenant[] }>('/v1/tenants')
      .then((r) => {
        const m: Record<string, Tenant> = {};
        (r.tenants || []).forEach((t) => {
          m[t.tenantId] = t;
        });
        setTenants(m);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void load();
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

  const totalFrozen = useMemo(
    () => customers.reduce((s, c) => s + (c.frozenCredits || 0), 0),
    [customers],
  );

  const createCustomer = async () => {
    const body = {
      companyName: createForm.companyName.trim(),
      contactEmail: createForm.contactEmail.trim(),
      contactPhone: createForm.contactPhone.trim(),
      planTier: createForm.planTier,
      quotaAgents: Number(createForm.quotaAgents) || 1,
      quotaCreditsMonthly: Number(createForm.quotaCreditsMonthly) || 1000000,
      botAppId: createForm.botAppId.trim(),
      botAppSecret: createForm.botAppSecret.trim(),
    };
    if (!window.confirm(`确认创建客户「${body.companyName || '未命名'}」？将立即开通 K8s 资源与计费账户。`))
      return;
    setCreating(true);
    setCreateErr('');
    try {
      const r = await api<{ tenant?: Tenant; provisioning?: { dryRun?: boolean } }>(
        '/v1/tenants',
        { method: 'POST', body },
      );
      setShowCreate(false);
      setCreateForm({ ...emptyCreate });
      window.alert(
        `客户创建成功：${r.tenant?.tenantId || '-'}${r.provisioning?.dryRun ? '（dry-run 模式）' : ''}`,
      );
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
      window.alert(`续费充值成功，当前余额 ${fmtNum(r.balanceAfter)} credits`);
      await load();
    } catch (e) {
      setTopupErr(errMsg(e));
    } finally {
      setTopupBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">客户与 Credits</div>
          <div className="page-sub">掌握客户用量、客户健康度与续费机会</div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => void load()}>
            <IconRefresh /> 刷新
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <IconPlus /> 创建客户
          </button>
          <button
            className="icon-btn"
            title="搜索客户"
            onClick={() => searchRef.current?.focus()}
          >
            <IconSearch />
          </button>
        </div>
      </div>

      {error && <div className="msg msg-err">加载失败：{error}</div>}

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-icon">客</span>
          <div className="label">活跃客户</div>
          <div className="num">{stats.active ?? 0}</div>
          <div className="stat-sub">共 {stats.total ?? customers.length} 个客户账户</div>
        </div>
        <div className="stat-card">
          <span className="stat-icon green">余</span>
          <div className="label">总余额</div>
          <div className="num">{fmtNum(stats.totalBalance)}</div>
          <div className="stat-sub">credits_accounts.balance</div>
        </div>
        <div className="stat-card">
          <span className="stat-icon orange">耗</span>
          <div className="label">累计消耗</div>
          <div className="num">{fmtNum(stats.totalConsumed)}</div>
          <div className="stat-sub">lifetime_consumed</div>
        </div>
        <div className="stat-card">
          <span className="stat-icon blue">冻</span>
          <div className="label">冻结 / 预留</div>
          <div className="num">{fmtNum(totalFrozen)}</div>
          <div className="stat-sub">当前冻结中的 credits</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">客户账户</div>
            <div className="panel-sub">数据采自 credits_accounts · 近实时</div>
          </div>
          <div className="panel-meta">{rows.length} 个结果</div>
        </div>

        <div className="filter-row">
          <div className="search-box">
            <IconSearch />
            <input
              ref={searchRef}
              type="text"
              placeholder="搜索公司名称…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
            <option value="">全部套餐</option>
            {tiers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
            <option value="consumed">消耗：从高到低</option>
            <option value="balance">余额：从高到低</option>
            <option value="name">名称：A–Z</option>
          </select>
        </div>

        {rows.length === 0 ? (
          <div className="empty">暂无客户</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>客户</th>
                <th>套餐</th>
                <th>余额</th>
                <th>已消耗</th>
                <th>冻结</th>
                <th>消耗占比</th>
                <th style={{ width: 110, textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const tStatus = tenants[c.tenantId]?.status ?? c.status;
                const consumed = c.lifetimeConsumed || 0;
                const total = consumed + (c.balance || 0);
                const pct = total > 0 ? Math.round((consumed / total) * 100) : 0;
                return (
                  <tr
                    key={c.tenantId}
                    className="clickable"
                    onClick={() => navigate(`/customers/${encodeURIComponent(c.tenantId)}`)}
                  >
                    <td>
                      <div className="cell-main">
                        <span className={`dot ${dotTone(tStatus)}`} />
                        {c.companyName || c.tenantId}
                      </div>
                      <div className="cell-sub">{c.tenantId}</div>
                    </td>
                    <td>
                      <span className={`badge badge-plan-${c.planTier || 'starter'}`}>
                        {c.planTier || '-'}
                      </span>
                    </td>
                    <td>
                      <div className="cell-main">{fmtNum(c.balance)}</div>
                      <div className="cell-sub">可用 {fmtNum(c.availableBalance)}</div>
                    </td>
                    <td>
                      <div className="cell-main">{fmtNum(consumed)}</div>
                      <div className="cell-sub">{fmtNum(c.totalTasks)} 次任务</div>
                    </td>
                    <td className="mono">
                      {c.frozenCredits ? (
                        <span className="frozen-num">{fmtNum(c.frozenCredits)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <span className="progress-wrap">
                        <span className="progress">
                          <i style={{ width: `${pct}%` }} />
                        </span>
                        <span className="progress-pct">{pct}%</span>
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn-soft btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setTopupFor(c);
                          setTopupErr('');
                        }}
                      >
                        续费
                      </button>{' '}
                      <button
                        className="icon-btn sm"
                        title="查看详情"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/customers/${encodeURIComponent(c.tenantId)}`);
                        }}
                      >
                        <IconChevronDown />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="hint">
        点击行查看消耗明细、调用日志与租户开通状态；圆点代表租户生命周期状态
        （绿 active · 橙 停用/宽限/欠费 · 蓝 开通中 · 红 失败/已销毁）。
      </div>

      {/* ── 创建客户（provisioning 开通） ── */}
      <Modal title="创建客户" open={showCreate} onClose={() => setShowCreate(false)}>
        {createErr && <div className="msg msg-err">{createErr}</div>}
        <div className="form-row">
          <label className="field-label">公司名称</label>
          <input
            type="text"
            value={createForm.companyName}
            onChange={(e) => setCreateForm({ ...createForm, companyName: e.target.value })}
            placeholder="如：示例科技有限公司（建议填写，可后补）"
          />
        </div>
        <div className="form-row">
          <label className="field-label">联系邮箱</label>
          <input
            type="text"
            value={createForm.contactEmail}
            onChange={(e) => setCreateForm({ ...createForm, contactEmail: e.target.value })}
            placeholder="可选，缺失时系统生成占位邮箱"
          />
        </div>
        <div className="form-row">
          <label className="field-label">联系电话</label>
          <input
            type="text"
            value={createForm.contactPhone}
            onChange={(e) => setCreateForm({ ...createForm, contactPhone: e.target.value })}
            placeholder="可选"
          />
        </div>
        <div className="form-row">
          <label className="field-label">套餐档位</label>
          <select
            value={createForm.planTier}
            onChange={(e) => setCreateForm({ ...createForm, planTier: e.target.value })}
          >
            <option value="starter">starter</option>
            <option value="pro">pro</option>
            <option value="enterprise">enterprise</option>
          </select>
          <label className="field-label" style={{ minWidth: 70 }}>
            Agent 配额
          </label>
          <input
            type="number"
            min={1}
            max={100}
            style={{ flex: 0, minWidth: 90 }}
            value={createForm.quotaAgents}
            onChange={(e) => setCreateForm({ ...createForm, quotaAgents: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="field-label">月度积分额度</label>
          <input
            type="number"
            min={0}
            max={100000000}
            style={{ flex: 0, minWidth: 160 }}
            value={createForm.quotaCreditsMonthly}
            onChange={(e) => setCreateForm({ ...createForm, quotaCreditsMonthly: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="field-label">飞书 App ID</label>
          <input
            type="text"
            className="mono"
            value={createForm.botAppId}
            onChange={(e) => setCreateForm({ ...createForm, botAppId: e.target.value })}
            placeholder="cli_xxxx（可留空后补）"
          />
        </div>
        <div className="form-row">
          <label className="field-label">飞书 App Secret</label>
          <input
            type="text"
            className="mono"
            value={createForm.botAppSecret}
            onChange={(e) => setCreateForm({ ...createForm, botAppSecret: e.target.value })}
            placeholder="可留空后补"
          />
        </div>
        <div className="hint">
          创建即真实开通——写租户记录、建 credits 账户、在独立 namespace 中创建
          Deployment/Secret/PVC。前置条件：运行时配置需先配好全局默认（如 DEEPSEEK_API_KEY）。
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={() => void createCustomer()} disabled={creating}>
            {creating ? '创建中…' : '创建并开通'}
          </button>
          <button className="btn-secondary" onClick={() => setShowCreate(false)}>
            取消
          </button>
        </div>
      </Modal>

      {/* ── 续费充值 ── */}
      <Modal
        title={`续费充值 — ${topupFor?.companyName || topupFor?.tenantId || ''}`}
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
