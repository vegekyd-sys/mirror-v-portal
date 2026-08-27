// Agents 管理 — 跨客户的 Agent（dealclaw-agent）统一运维视图。
// 数据：provisioning GET /v1/tenants（含 k8s/飞书/MIO CDP 字段）+ credits-ledger
// GET /v1/admin/customers（余额/消耗）。每个客户（tenant）对应一个 agent。
// 「添加 Agent」参考创建客户：选企业（新建 / 从已有客户重建）+ 飞书绑定 + 米奥 CDP ID。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import type { Tenant } from '../lib/types';
import { fmtNum, fmtTime } from '../components/badges';
import Modal from '../components/Modal';
import FeishuAppScanModal from '../components/FeishuAppScanModal';
import { IconPlus, IconRefresh, IconSearch } from '../components/icons';

interface AgentRow extends Tenant {
  feishuAppId?: string | null;
  externalAgent?: boolean;
  updatedAt?: string | null;
  // 来自 credits 视图（可选合并展示）
  balance?: number | null;
  lifetimeConsumed?: number | null;
}

const emptyAdd = {
  companyName: '',
  contactEmail: '',
  contactPhone: '',
  planTier: 'starter',
  quotaAgents: '1',
  quotaCreditsMonthly: '1000000',
  botAppId: '',
  botAppSecret: '',
  mioSupplierId: '',
};

export default function AgentsPage() {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ ...emptyAdd });
  const [addErr, setAddErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [showScan, setShowScan] = useState(false);
  // 选择已有企业（tenantId）为空 = 新建企业
  const [pickTenant, setPickTenant] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ tenants: AgentRow[] }>('/v1/tenants');
      setAgents(r.tenants || []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // 合并客户余额数据（列表只做轻量展示）
  const loadCredits = useCallback(async () => {
    try {
      const r = await api<{
        customers: { tenantId: string; balance?: number; lifetimeConsumed?: number }[];
      }>('/v1/admin/customers');
      setAgents((prev) => {
        const m = new Map((r.customers || []).map((c) => [c.tenantId, c]));
        return prev.map((a) => {
          const c = m.get(a.tenantId);
          return c ? { ...a, balance: c.balance, lifetimeConsumed: c.lifetimeConsumed } : a;
        });
      });
    } catch {
      /* credits 信息可选 */
    }
  }, []);

  useEffect(() => {
    void load().then(loadCredits);
  }, [load, loadCredits]);

  const stats = useMemo(() => {
    const live = agents.filter((a) => a.status !== 'destroyed');
    return {
      total: agents.length,
      active: agents.filter((a) => a.status === 'active').length,
      abnormal: live.filter((a) =>
        ['provisioning_failed', 'suspended', 'grace', 'low_credits', 'pending', 'provisioning'].includes(
          a.status || '',
        ),
      ).length,
      destroyed: agents.filter((a) => a.status === 'destroyed').length,
      feishuBound: live.filter((a) => a.feishuAppId).length,
    };
  }, [agents]);

  const rows = useMemo(() => {
    let list = agents;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (a) =>
          (a.companyName || '').toLowerCase().includes(q) ||
          a.tenantId.toLowerCase().includes(q) ||
          (a.k8sNamespace || '').toLowerCase().includes(q),
      );
    }
    if (statusFilter) list = list.filter((a) => a.status === statusFilter);
    return list;
  }, [agents, search, statusFilter]);

  const pickedTenant = useMemo(
    () => agents.find((a) => a.tenantId === pickTenant) || null,
    [agents, pickTenant],
  );

  // 选择已有企业：预填其资料，便于「重建 / 补全信息后开通新 Agent」
  const onPickTenant = (tenantId: string) => {
    setPickTenant(tenantId);
    setAddErr('');
    const t = agents.find((a) => a.tenantId === tenantId);
    if (t) {
      setAddForm((f) => ({
        ...f,
        companyName: t.companyName || '',
        contactEmail: t.contactEmail || '',
        mioSupplierId: t.mioCdpSupplierId || '',
      }));
    }
  };

  const addAgent = async () => {
    const body = {
      companyName: addForm.companyName.trim(),
      contactEmail: addForm.contactEmail.trim(),
      contactPhone: addForm.contactPhone.trim(),
      planTier: addForm.planTier,
      quotaAgents: Number(addForm.quotaAgents) || 1,
      quotaCreditsMonthly: Number(addForm.quotaCreditsMonthly) || 1000000,
      botAppId: addForm.botAppId.trim(),
      botAppSecret: addForm.botAppSecret.trim(),
      mioCdpSupplierId: addForm.mioSupplierId.trim(),
    };
    if (!body.companyName) {
      setAddErr('请填写公司名称（企业标识）');
      return;
    }
    if (
      !window.confirm(
        `确认为企业「${body.companyName}」开通 Agent？将创建客户记录并在独立 namespace 中开通 K8s 资源。`,
      )
    )
      return;
    setAdding(true);
    setAddErr('');
    try {
      const r = await api<{ tenant?: Tenant; provisioning?: { dryRun?: boolean } }>('/v1/tenants', {
        method: 'POST',
        body,
      });
      setShowAdd(false);
      setAddForm({ ...emptyAdd });
      setPickTenant('');
      const tid = r.tenant?.tenantId || '';
      window.alert(
        `Agent 开通成功：${tid}${r.provisioning?.dryRun ? '（dry-run 模式）' : ''}。初始状态 provisioning，数十秒后自动就绪。`,
      );
      await load().then(loadCredits);
      if (tid) navigate(`/agents/${encodeURIComponent(tid)}`);
    } catch (e) {
      setAddErr(errMsg(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">Agents 管理</div>
          <div className="page-sub">全部客户的 Agent 生命周期与运维（开通 · 飞书 · 环境变量 · 镜像 · 扩缩容）</div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => void load().then(loadCredits)}>
            <IconRefresh /> 刷新
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setShowAdd(true);
              setPickTenant('');
              setAddErr('');
            }}
          >
            <IconPlus /> 添加 Agent
          </button>
          <button className="icon-btn" title="搜索" onClick={() => searchRef.current?.focus()}>
            <IconSearch />
          </button>
        </div>
      </div>

      {error && <div className="msg msg-err">加载失败：{error}</div>}

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-icon blue">A</span>
          <div className="label">Agent 总数</div>
          <div className="num">{stats.total}</div>
          <div className="stat-sub">含已销毁 {stats.destroyed} 个</div>
        </div>
        <div className="stat-card">
          <span className="stat-icon green">活</span>
          <div className="label">运行中（active）</div>
          <div className="num">{stats.active}</div>
          <div className="stat-sub">正常提供服务</div>
        </div>
        <div className="stat-card">
          <span className="stat-icon orange">异</span>
          <div className="label">异常 / 过渡态</div>
          <div className="num">{stats.abnormal}</div>
          <div className="stat-sub">开通中·失败·停用·欠费等</div>
        </div>
        <div className="stat-card">
          <span className="stat-icon">飞</span>
          <div className="label">已绑定飞书</div>
          <div className="num">{stats.feishuBound}</div>
          <div className="stat-sub">未销毁 Agent 中</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">Agent 列表</div>
            <div className="panel-sub">每个客户一个 agent · 点击行进入设置</div>
          </div>
          <div className="panel-meta">{rows.length} 个结果</div>
        </div>

        <div className="filter-row">
          <div className="search-box">
            <IconSearch />
            <input
              ref={searchRef}
              type="text"
              placeholder="搜索公司名称 / Agent ID / namespace…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">全部状态</option>
            {['active', 'provisioning', 'pending', 'provisioning_failed', 'suspended', 'low_credits', 'grace', 'destroyed'].map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </select>
        </div>

        {loading ? (
          <div className="empty">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="empty">暂无 Agent</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>所属企业</th>
                <th>状态</th>
                <th>K8s Namespace</th>
                <th>飞书</th>
                <th>接入方式</th>
                <th>Mio CDP</th>
                <th>余额 / 累计消耗</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr
                  key={a.tenantId}
                  className="clickable"
                  onClick={() => navigate(`/agents/${encodeURIComponent(a.tenantId)}`)}
                >
                  <td>
                    <div className="cell-main mono" style={{ fontSize: 12 }}>
                      dealclaw-agent
                    </div>
                    <div className="cell-sub mono">{a.tenantId.slice(0, 16)}…</div>
                  </td>
                  <td>
                    <div className="cell-main">{a.companyName || '-'}</div>
                    <div className="cell-sub">
                      <Link
                        to={`/customers/${encodeURIComponent(a.tenantId)}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        客户与 Credits →
                      </Link>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${statusBadgeCls(a.status)}`}>{a.status || '-'}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {a.k8sNamespace || '—'}
                  </td>
                  <td>
                    {a.feishuAppId ? (
                      <span className="badge badge-active">已绑定</span>
                    ) : (
                      <span className="badge badge-pending">未绑定</span>
                    )}
                  </td>
                  <td>
                    {a.directMode ? (
                      <span className="badge badge-warn" title="绕过网关直连大模型 API，计费/余额拦截失效">直连上游</span>
                    ) : (
                      <span className="badge" style={{ opacity: 0.5 }}>网关代理</span>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {a.mioCdpSupplierId || '—'}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {fmtNum(a.balance)} / {fmtNum(a.lifetimeConsumed)}
                  </td>
                  <td style={{ fontSize: 11, color: '#777' }}>{fmtTime(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="hint">
        Agent 与客户一一对应：添加 Agent 即开通一个新客户（独立 namespace + Deployment/Secret/PVC +
        计费账户）。Agent 的详细设置（状态、飞书、环境变量、镜像、扩缩容、备份）在行详情页。
      </div>

      {/* ── 添加 Agent ── */}
      <Modal title="添加 Agent" open={showAdd} onClose={() => setShowAdd(false)}>
        {addErr && <div className="msg msg-err">{addErr}</div>}
        <div className="form-row">
          <label className="field-label">选择企业</label>
          <select value={pickTenant} onChange={(e) => onPickTenant(e.target.value)}>
            <option value="">＋ 新建企业（开通全新 Agent）</option>
            {agents
              .filter((a) => a.status === 'destroyed')
              .map((a) => (
                <option key={a.tenantId} value={a.tenantId}>
                  重建：{a.companyName || a.tenantId}（已销毁）
                </option>
              ))}
            {agents
              .filter((a) => a.status !== 'destroyed')
              .map((a) => (
                <option key={a.tenantId} value={a.tenantId}>
                  {a.companyName || a.tenantId}（{a.status}）
                </option>
              ))}
          </select>
          {pickedTenant && pickedTenant.status !== 'destroyed' && (
            <button
              className="btn-secondary"
              style={{ flex: '0 0 auto' }}
              onClick={() => navigate(`/agents/${encodeURIComponent(pickedTenant.tenantId)}`)}
            >
              该企业已有 Agent，去管理 →
            </button>
          )}
        </div>
        {pickedTenant && pickedTenant.status !== 'destroyed' && (
          <div className="msg msg-err">
            所选企业的 Agent 已存在（状态 {pickedTenant.status}）。1 个企业对应 1 个
            Agent；如需更换请先销毁后在「重建」。直接点上方按钮进入管理。
          </div>
        )}
        {(!pickedTenant || pickedTenant.status === 'destroyed') && (
          <>
            <div className="form-row">
              <label className="field-label">公司名称</label>
              <input
                type="text"
                value={addForm.companyName}
                onChange={(e) => setAddForm({ ...addForm, companyName: e.target.value })}
                placeholder="如：示例科技有限公司"
              />
            </div>
            <div className="form-row">
              <label className="field-label">联系邮箱</label>
              <input
                type="text"
                value={addForm.contactEmail}
                onChange={(e) => setAddForm({ ...addForm, contactEmail: e.target.value })}
                placeholder="可选，缺失时系统生成占位邮箱"
              />
              <label className="field-label" style={{ minWidth: 60 }}>
                电话
              </label>
              <input
                type="text"
                value={addForm.contactPhone}
                onChange={(e) => setAddForm({ ...addForm, contactPhone: e.target.value })}
                placeholder="可选"
              />
            </div>
            <div className="form-row">
              <label className="field-label">套餐档位</label>
              <select
                value={addForm.planTier}
                onChange={(e) => setAddForm({ ...addForm, planTier: e.target.value })}
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
                value={addForm.quotaAgents}
                onChange={(e) => setAddForm({ ...addForm, quotaAgents: e.target.value })}
              />
              <label className="field-label" style={{ minWidth: 90 }}>
                月度积分
              </label>
              <input
                type="number"
                min={0}
                style={{ flex: 0, minWidth: 140 }}
                value={addForm.quotaCreditsMonthly}
                onChange={(e) => setAddForm({ ...addForm, quotaCreditsMonthly: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="field-label">飞书 App ID</label>
              <input
                type="text"
                className="mono"
                style={{ flex: 1 }}
                value={addForm.botAppId}
                onChange={(e) => setAddForm({ ...addForm, botAppId: e.target.value })}
                placeholder="cli_xxxx（可留空后补）"
              />
              <button className="btn-secondary" style={{ flex: '0 0 auto' }} onClick={() => setShowScan(true)}>
                扫码获取
              </button>
            </div>
            <div className="form-row">
              <label className="field-label">飞书 App Secret</label>
              <input
                type="text"
                className="mono"
                value={addForm.botAppSecret}
                onChange={(e) => setAddForm({ ...addForm, botAppSecret: e.target.value })}
                placeholder="可留空后补"
              />
            </div>
            <div className="form-row">
              <label className="field-label">Mio CDP 供应商 ID</label>
              <input
                type="text"
                className="mono"
                value={addForm.mioSupplierId}
                onChange={(e) => setAddForm({ ...addForm, mioSupplierId: e.target.value })}
                placeholder="可选，如 SUP12345；注入 agent 环境变量 MIO_CDP_SUPPLIER_ID"
              />
            </div>
            <div className="hint">
              添加即真实开通——写客户记录、建 credits 账户、在独立 namespace 创建
              Deployment/Secret/PVC。前置条件：需先在「模型供应商」页配好全局大模型提供商（LLM_PROVIDERS）。
            </div>
            <div className="form-row" style={{ marginTop: 12 }}>
              <button className="btn-primary" onClick={() => void addAgent()} disabled={adding}>
                {adding ? '开通中…' : '添加并开通'}
              </button>
              <button className="btn-secondary" onClick={() => setShowAdd(false)}>
                取消
              </button>
            </div>
          </>
        )}
      </Modal>

      <FeishuAppScanModal
        open={showScan}
        onClose={() => setShowScan(false)}
        onCredentials={(appId, appSecret) =>
          setAddForm((f) => ({ ...f, botAppId: appId, botAppSecret: appSecret }))
        }
      />
    </>
  );
}

function statusBadgeCls(status?: string | null): string {
  switch (status) {
    case 'active':
      return 'badge-active';
    case 'suspended':
    case 'grace':
    case 'low_credits':
      return 'badge-warn';
    case 'pending':
    case 'provisioning':
      return 'badge-pending';
    case 'provisioning_failed':
    case 'destroyed':
      return 'badge-failed';
    default:
      return '';
  }
}
