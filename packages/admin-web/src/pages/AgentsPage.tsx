// Agents 管理 — 跨客户的 Agent（dealclaw-agent）统一运维视图。
// 数据：provisioning GET /v1/tenants（含 k8s/飞书/MIO CDP 字段）+ credits-ledger
// GET /v1/admin/customers（余额/消耗）。每个客户（tenant）对应一个 agent。
// 「添加 Agent」参考创建客户：选企业（新建 / 从已有客户重建）+ 飞书绑定 + 米奥 CDP ID。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import type {
  CreateTenantResponse,
  // MioSupplierCreateResponse,  // 2026-09-16 暂时停用「新建供应商」(quickRegister)，恢复时取消注释
  MioSupplierOption,
  MioSupplierSearchResponse,
  Tenant,
} from '../lib/types';
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
  /** 国际区号（与手机号拼成 contactPhone 提交）。 */
  contactPhoneCode: '+86',
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

  // 米奥（Mio）供应商：搜索结果下拉 + 新建供应商入口。
  // 绑定的值是米奥返回的 `id`（12 位数字），不是 `code`。
  const [mioItems, setMioItems] = useState<MioSupplierOption[]>([]);
  const [mioTotal, setMioTotal] = useState(0);
  const [mioBusy, setMioBusy] = useState(false);
  const [mioSearched, setMioSearched] = useState(false);
  const [mioErr, setMioErr] = useState('');
  const [mioSelected, setMioSelected] = useState<MioSupplierOption | null>(null);
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupplier, setNewSupplier] = useState({ companyName: '', mobile: '', intDialingCode: '+86' });
  const [newSupplierBusy, setNewSupplierBusy] = useState(false);
  const [newSupplierErr, setNewSupplierErr] = useState('');

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

  /** 打开「添加 Agent」弹窗，重置上一轮遗留的米奥搜索状态。 */
  const openAddModal = () => {
    setShowAdd(true);
    setPickTenant('');
    setAddErr('');
    setMioItems([]);
    setMioTotal(0);
    setMioSearched(false);
    setMioErr('');
    setMioSelected(null);
    setShowNewSupplier(false);
    setNewSupplierErr('');
  };

  const closeAddModal = () => {
    setShowAdd(false);
    setShowNewSupplier(false);
  };

  /** 米奥供应商模糊搜索（结果可能 0 条，也可能多条）。 */
  const searchMioSuppliers = async () => {
    const kw = addForm.companyName.trim();
    if (!kw) {
      setMioErr('请先填写公司名称，再搜索米奥供应商');
      return;
    }
    setMioBusy(true);
    setMioErr('');
    setMioItems([]);
    setMioSearched(false);
    setShowNewSupplier(false);
    try {
      const r = await api<MioSupplierSearchResponse>(
        `/v1/admin/mio-suppliers?search=${encodeURIComponent(kw)}&page=0`,
      );
      setMioItems(r.items || []);
      setMioTotal(r.total ?? 0);
      setMioSearched(true);
    } catch (e) {
      setMioErr(errMsg(e));
    } finally {
      setMioBusy(false);
    }
  };

  /** 选中下拉项 → 把米奥 `id` 作为 mioSupplierId 提交。 */
  const pickMioSupplier = (id: string) => {
    setMioErr('');
    setAddForm((f) => ({ ...f, mioSupplierId: id }));
    setMioSelected(mioItems.find((i) => i.id === id) || null);
  };

  /**
   * 2026-09-16 暂时停用：「新建供应商」入口（openNewSupplier）。
   *
   * 原因：该入口 → createMioSupplier → 米奥 quickRegister，而 quickRegister 必填手机号，
   * 与本次「联系人手机改回非必填」的口径冲突；且注册供应商与建租户本就该分开
   * （先在米奥侧建好，再在本页「搜索供应商」选中绑定）。
   *
   * 恢复方式：取消下面注释，并恢复 JSX 里的「新建供应商」按钮 + import 的
   * MioSupplierCreateResponse + createMioSupplier 的原始实现。
   */
  // const openNewSupplier = () => {
  //   setNewSupplier({
  //     companyName: addForm.companyName.trim(),
  //     mobile: addForm.contactPhone.replace(/[^0-9]/g, ''),
  //     intDialingCode: addForm.contactPhoneCode.trim() || '+86',
  //   });
  //   setNewSupplierErr('');
  //   setShowNewSupplier(true);
  // };

  /**
   * 2026-09-16 暂时停用：调用米奥 quickRegister 注册供应商。
   *
   * 原实现（POST /v1/admin/mio-suppliers）保留在下方注释里，恢复时取回即可。
   */
  const createMioSupplier = async () => {
    setNewSupplierBusy(true);
    setNewSupplierErr('本页暂不支持新建米奥供应商：请先在米奥侧创建，再用「搜索供应商」选中绑定。');
    setNewSupplierBusy(false);
    /* 原实现（暂时停用）：
    const companyName = (newSupplier.companyName || addForm.companyName).trim();
    const mobile = newSupplier.mobile.trim();
    const intDialingCode = newSupplier.intDialingCode.trim() || '+86';
    if (!companyName) {
      setNewSupplierErr('请填写公司名称');
      return;
    }
    if (!mobile) {
      setNewSupplierErr('请填写联系人手机号');
      return;
    }
    setNewSupplierBusy(true);
    setNewSupplierErr('');
    try {
      const r = await api<MioSupplierCreateResponse>('/v1/admin/mio-suppliers', {
        method: 'POST',
        body: { companyName, mobile, intDialingCode },
      });
      setAddForm((f) => ({
        ...f,
        companyName: f.companyName.trim() || companyName,
        mioSupplierId: r.supplierId,
      }));
      setMioSelected({ id: r.supplierId, code: null, name: r.name ?? companyName });
      setMioItems([]);
      setMioSearched(false);
      setShowNewSupplier(false);
      window.alert(
        `已新建米奥供应商：${r.name || companyName}\n供应商 ID：${r.supplierId}\n已自动填入表单，点「添加并开通」即完成绑定。`,
      );
    } catch (e) {
      // 同名重复等业务错误：直接展示米奥返回的原始信息。
      setNewSupplierErr(errMsg(e));
    } finally {
      setNewSupplierBusy(false);
    }
    */
  };

  const addAgent = async () => {
    const phoneDigits = addForm.contactPhone.replace(/[^0-9]/g, '');
    const body = {
      companyName: addForm.companyName.trim(),
      contactEmail: addForm.contactEmail.trim(),
      // 手机号可选（2026-09-16 改回非必填）：留空时提交空串，后端存 null；
      // 不再拼出只有区号的 "+86"。
      contactPhone: phoneDigits ? `${addForm.contactPhoneCode.trim() || '+86'}${phoneDigits}` : '',
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
    // 联系人手机：2026-09-16 改回**非必填**（本页不再代米奥注册供应商后，
    // 手机号不再是创建阻塞项；留空提交空串，后端存 null）。
    // Requirement (2026-08-27): creating an Agent REQUIRES Feishu bot
    // credentials — without them the backend refuses to provision agent
    // workloads (no creds → customer-only record). Enforce here so the
    // operator cannot even submit an invalid request.
    if (!body.botAppId || !body.botAppSecret) {
      setAddErr('创建 Agent 必须填写飞书 App ID 与 App Secret（可用「扫码获取」回填）——未绑定飞书凭据无法开通 Agent');
      return;
    }
    if (
      !window.confirm(
        `确认为企业「${body.companyName}」开通 Agent？将创建客户记录并在独立 namespace 中开通 K8s 资源（飞书消息走 openclaw 直连平面）。`,
      )
    )
      return;
    setAdding(true);
    setAddErr('');
    try {
      const r = await api<CreateTenantResponse>('/v1/tenants', {
        method: 'POST',
        body,
      });
      closeAddModal();
      setAddForm({ ...emptyAdd });
      setPickTenant('');
      setMioItems([]);
      setMioSearched(false);
      setMioSelected(null);
      const tid = r.tenant?.tenantId || '';
      // mioSupplier=null → 本次未绑定米奥供应商（不阻塞创建），提示后续绑定。
      const mioNote = r.mioSupplier ? '' : '\n注意：本次未绑定米奥供应商 ID，可在 Agent 详情页或重开表单补绑。';
      window.alert(
        `Agent 开通成功：${tid}${r.provisioning?.dryRun ? '（dry-run 模式）' : ''}。初始状态 provisioning，数十秒后自动就绪。${mioNote}`,
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
            onClick={openAddModal}
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
                    <div style={{ marginBottom: 2 }}>
                      {a.messagePlane === 'openclaw' ? (
                        <span className="badge badge-active" title="飞书消息：agent 内 @openclaw/feishu 插件直连">openclaw 直连</span>
                      ) : (
                        <span className="badge badge-warn" title="飞书消息：nexus-gateway WS 桥接（存量旧平面，建议迁移）">gateway 桥接</span>
                      )}
                    </div>
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
      <Modal title="添加 Agent" open={showAdd} onClose={closeAddModal}>
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
              <button
                className="btn-secondary"
                style={{ flex: '0 0 auto' }}
                disabled={mioBusy}
                onClick={() => void searchMioSuppliers()}
              >
                {mioBusy ? '搜索中…' : '搜索供应商'}
              </button>
            </div>
            {mioErr && <div className="msg msg-err">米奥供应商搜索失败：{mioErr}</div>}
            {mioItems.length > 0 && (
              <div className="form-row">
                <label className="field-label">匹配供应商</label>
                <select value={addForm.mioSupplierId} onChange={(e) => pickMioSupplier(e.target.value)}>
                  <option value="">请选择（名称 / 编码 / ID）…</option>
                  {mioItems.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name || '(未命名)'} / {i.code || '无编码'} / {i.id}
                    </option>
                  ))}
                </select>
                <span className="hint" style={{ margin: 0 }}>
                  模糊命中 {mioTotal} 条，选中即用其 id 绑定
                </span>
              </div>
            )}
            {mioSearched && mioItems.length === 0 && !mioErr && (
              <div className="msg msg-warn">
                米奥未找到「{addForm.companyName.trim()}」的供应商：请先在米奥侧新建，再回到本页重新搜索选中绑定。
                {/* 2026-09-16 暂时停用「新建供应商」（quickRegister）；恢复时取消注释： */}
                {/* <button className="btn-secondary btn-sm" style={{ marginLeft: 8 }} onClick={openNewSupplier}>新建供应商</button> */}
              </div>
            )}
            {showNewSupplier && (
              <div className="form-row" style={{ marginBottom: 4 }}>
                <label className="field-label">新建供应商 · 公司名</label>
                <input
                  type="text"
                  value={newSupplier.companyName}
                  onChange={(e) => setNewSupplier({ ...newSupplier, companyName: e.target.value })}
                  placeholder="米奥侧将以此名称注册"
                />
              </div>
            )}
            {showNewSupplier && (
              <div className="form-row">
                <label className="field-label">联系人手机</label>
                <input
                  type="text"
                  style={{ flex: '0 0 90px', minWidth: 0 }}
                  value={newSupplier.intDialingCode}
                  onChange={(e) => setNewSupplier({ ...newSupplier, intDialingCode: e.target.value })}
                  placeholder="+86"
                />
                <input
                  type="text"
                  value={newSupplier.mobile}
                  onChange={(e) => setNewSupplier({ ...newSupplier, mobile: e.target.value })}
                  placeholder="如 13800000000"
                />
                <button
                  className="btn-primary"
                  style={{ flex: '0 0 auto' }}
                  disabled={newSupplierBusy}
                  onClick={() => void createMioSupplier()}
                >
                  {newSupplierBusy ? '创建中…' : '创建供应商'}
                </button>
                <button
                  className="btn-secondary"
                  style={{ flex: '0 0 auto' }}
                  onClick={() => setShowNewSupplier(false)}
                >
                  取消
                </button>
              </div>
            )}
            {showNewSupplier && newSupplierErr && (
              <div className="msg msg-err">米奥返回：{newSupplierErr}</div>
            )}
            <div className="form-row">
              <label className="field-label">联系邮箱</label>
              <input
                type="text"
                value={addForm.contactEmail}
                onChange={(e) => setAddForm({ ...addForm, contactEmail: e.target.value })}
                placeholder="可选，缺失时系统生成占位邮箱"
              />
            </div>
            <div className="form-row">
              <label className="field-label">联系人手机</label>
              <input
                type="text"
                style={{ flex: '0 0 90px', minWidth: 0 }}
                value={addForm.contactPhoneCode}
                onChange={(e) => setAddForm({ ...addForm, contactPhoneCode: e.target.value })}
                placeholder="+86"
              />
              <input
                type="text"
                value={addForm.contactPhone}
                onChange={(e) => setAddForm({ ...addForm, contactPhone: e.target.value })}
                placeholder="可选，如 13800000000"
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
                placeholder="cli_xxxx（必填，可用「扫码获取」）"
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
                placeholder="必填（可与 App ID 同用「扫码获取」）"
              />
            </div>
            <div className="form-row">
              <label className="field-label">Mio CDP 供应商 ID</label>
              {/* 2026-09-16：恢复手填 —— 上方「搜索供应商」选中后仍会自动填入，
                  但搜索不到/已知 ID 时也可以直接输入或粘贴（之前误置 readOnly 导致无法输入）。 */}
              <input
                type="text"
                className="mono"
                value={addForm.mioSupplierId}
                onChange={(e) => {
                  const value = e.target.value;
                  setAddForm((f) => ({ ...f, mioSupplierId: value }));
                  // 手改后之前选中的供应商不再可信，避免「已选：xxx」与实际 ID 不一致
                  setMioSelected((cur) => (cur && cur.id === value.trim() ? cur : null));
                }}
                placeholder="由上方「搜索供应商」选中后自动填入，也可直接输入/粘贴 ID"
              />
              {addForm.mioSupplierId && (
                <button
                  className="btn-secondary btn-sm"
                  style={{ flex: '0 0 auto' }}
                  onClick={() => {
                    setAddForm((f) => ({ ...f, mioSupplierId: '' }));
                    setMioSelected(null);
                  }}
                >
                  清除
                </button>
              )}
              {mioSelected && (
                <span className="hint" style={{ margin: 0 }}>
                  已选：{mioSelected.name || '(未命名)'}
                  {mioSelected.code ? ` · ${mioSelected.code}` : ''}
                </span>
              )}
            </div>
            <div className="hint">
              添加即真实开通——写客户记录、建 credits 账户、在独立 namespace 创建
              Deployment/Secret/PVC，飞书消息走 openclaw 直连平面（agent 内 @openclaw/feishu
              插件）。<b>飞书 App ID / Secret 必填</b>：未提供凭据将只创建客户记录、不创建
              Agent。前置条件：需先在「模型供应商」页配好全局大模型提供商（LLM_PROVIDERS）。
              米奥供应商 ID 可选：不选也能建租户（不阻塞、不自动绑定），但建议在上方搜索并选中，
              选中后该 ID 会注入 agent 的 MIO_CDP_SUPPLIER_ID。
            </div>
            <div className="form-row" style={{ marginTop: 12 }}>
              <button className="btn-primary" onClick={() => void addAgent()} disabled={adding}>
                {adding ? '开通中…' : '添加并开通'}
              </button>
              <button className="btn-secondary" onClick={closeAddModal}>
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
