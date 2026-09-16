// Agents 管理 — 跨客户的 Agent（dealclaw-agent）统一运维视图。
// 数据：provisioning GET /v1/tenants（含 k8s/飞书/MIO CDP 字段）+ credits-ledger
// GET /v1/admin/customers（余额/消耗）。每个客户（tenant）对应一个 agent。
// 「添加 Agent」参考创建客户：选企业（新建 / 从已有客户重建）+ 飞书绑定 + 米奥 CDP ID。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canQuickStart } from '../lib/roles';
import type {
  CreateTenantResponse,
  MioSupplierOption,
  MioSupplierSearchResponse,
  QuickStartCandidates,
  QuickStartResponse,
  Tenant,
} from '../lib/types';
import { fmtNum, fmtTime } from '../components/badges';
import Modal from '../components/Modal';
import FeishuAppScanModal from '../components/FeishuAppScanModal';
import QuickStartScanModal from '../components/QuickStartScanModal';
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
  /** 解析出的米奥供应商 id（只读回显，不再手填）。 */
  mioSupplierId: '',
};

/**
 * 供应商解析状态机（「添加 Agent」里唯一入口，串行推进）：
 *   idle → searching → found / ambiguous / notfound
 * - found = 已解析出 ID，可提交（只读回显，不手填）；
 * - ambiguous = 多命中，需在下拉里人工选定（绝不自动取第一条）；
 * - notfound = 未命中，只给提示文案，**不提供注册入口**
 *   （2026-09-16 按 A 方案：注册供应商统一在小元运营后台完成）。
 */
type SupplierPhase = 'idle' | 'searching' | 'found' | 'ambiguous' | 'notfound';

const SUPPLIER_PHASE_LABEL: Record<SupplierPhase, string> = {
  idle: '未查询',
  searching: '查询中…',
  found: '已命中',
  ambiguous: '多命中，待选定',
  notfound: '未命中',
};

/** 名称归一：忽略大小写与首尾空格的完整名称比较（与后端 isExactCompanyNameMatch 同口径）。 */
function normalizeName(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

export default function AgentsPage() {
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement | null>(null);
  // 「一键开通小元」入口仅 FDE 可见（角色门禁，后端不加 FDE 校验）。
  const { user } = useAuth();
  const showQuickStartEntry = canQuickStart(user);

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

  // ── 供应商（米奥）：「添加 Agent」唯一入口，一个状态机按顺序走 ──
  // 查到的米奥 `id`（12 位数字）写入 addForm.mioSupplierId，只读回显。
  const [supplierPhase, setSupplierPhase] = useState<SupplierPhase>('idle');
  const [supplierHits, setSupplierHits] = useState<MioSupplierOption[]>([]);
  const [supplierTotal, setSupplierTotal] = useState(0);
  const [supplierErr, setSupplierErr] = useState('');
  const [mioSelected, setMioSelected] = useState<MioSupplierOption | null>(null);

  // ── 一键开通小元（FDE 版·工单 1）──────────────────────────────────────
  // 入参：「企业名 + 联系人手机(含区号) + 套餐」(+ 可选 mioCdpSupplierId)：供应商由
  // 后端按企业名解析（显式传 ID 则直接用；否则唯一精确命中取 id；0 命中 → 404
  // MIO_SUPPLIER_NOT_FOUND；多条同名 → 409 MIO_SUPPLIER_AMBIGUOUS 候选列表，
  // 绝不自动取第一条，也**绝不自动注册**）。
  const [showQuickStart, setShowQuickStart] = useState(false);
  const [qsForm, setQsForm] = useState({
    companyName: '',
    contactPhone: '',
    intDialingCode: '+86',
    planTier: 'starter',
  });
  const [qsErr, setQsErr] = useState('');
  const [qsBusy, setQsBusy] = useState(false);
  const [qsResult, setQsResult] = useState<QuickStartResponse | null>(null);
  const [showQsScan, setShowQsScan] = useState(false);
  /** 409 多命中候选（需人工指定，不走自动绑定）。 */
  const [qsCandidates, setQsCandidates] = useState<MioSupplierOption[]>([]);
  /** 供应商模糊搜索结果（仅供参考：后端按企业名重新精确匹配）。 */
  const [qsSearch, setQsSearch] = useState<{
    busy: boolean;
    searched: boolean;
    err: string;
    items: MioSupplierOption[];
    total: number;
  }>({ busy: false, searched: false, err: '', items: [], total: 0 });

  const openQuickStartModal = () => {
    setShowQuickStart(true);
    setQsErr('');
    setQsCandidates([]);
    setQsSearch({ busy: false, searched: false, err: '', items: [], total: 0 });
  };

  /** 查供应商（模糊）：仅给操作者看会命中谁；实际绑定仍由后端精确判定。 */
  const searchQsSuppliers = async () => {
    const kw = qsForm.companyName.trim();
    if (!kw) {
      setQsErr('请先填写企业名称，再搜索米奥供应商');
      return;
    }
    setQsSearch({ busy: true, searched: false, err: '', items: [], total: 0 });
    try {
      const r = await api<MioSupplierSearchResponse>(
        `/v1/admin/mio-suppliers?search=${encodeURIComponent(kw)}&page=0`,
      );
      setQsSearch({ busy: false, searched: true, err: '', items: r.items || [], total: r.total ?? 0 });
    } catch (e) {
      setQsSearch({ busy: false, searched: true, err: errMsg(e), items: [], total: 0 });
    }
  };

  /**
   * 2026-09-16 按 A 方案移除：在米奥侧新建供应商（POST /v1/admin/mio-suppliers）。
   *
   * 供应商注册统一在小元运营后台完成，本页只负责「查询并关联」；连带的
   * 「新建供应商」按钮、qsNewSupplier 子表单与 qsSupplierBusy 一并删除。
   * 后端 POST /v1/admin/mio-suppliers 仍存在（未做任何改动），只是本页不再调用。
   */

  /** 调 quick-start：后端按企业名匹配已有供应商 → 建租户 → 出二维码（不新建供应商）。 */
  const submitQuickStart = async () => {
    const companyName = qsForm.companyName.trim();
    const digits = qsForm.contactPhone.replace(/[^0-9]/g, '');
    const intDialingCode = qsForm.intDialingCode.trim() || '+86';
    if (!companyName) {
      setQsErr('请填写企业名称');
      return;
    }
    if (!digits) {
      setQsErr('请填写联系人手机号（含国际区号，必填）');
      return;
    }
    if (
      !window.confirm(
        `确认为企业「${companyName}」一键开通小元？\n\n将完成：按企业名命中**已有**米奥供应商 → 创建客户与 Agent 记录 → 生成飞书扫码二维码。未命中不会自动注册。`,
      )
    )
      return;
    setQsBusy(true);
    setQsErr('');
    setQsCandidates([]);
    try {
      const r = await api<QuickStartResponse>('/v1/admin/onboarding/quick-start', {
        method: 'POST',
        body: { companyName, contactPhone: digits, intDialingCode, planTier: qsForm.planTier },
      });
      setQsResult(r);
      setShowQuickStart(false);
      setShowQsScan(true);
      await load();
    } catch (e) {
      // 供应商歧义（多条同名）与未命中（米奥侧没有）都需要人工处置——
      // 后端不再自动注册，也不再自动取第一条。
      const maybe = e as QuickStartCandidates & { status?: number };
      const code = maybe?.code || '';
      if (maybe?.status === 409 && (code === 'MIO_SUPPLIER_AMBIGUOUS' || code === 'MULTIPLE_MATCHES')) {
        setQsCandidates(maybe.candidates || []);
        setQsErr(maybe.message || '米奥侧有多个同名供应商，请人工指定');
      } else if (maybe?.status === 404 || code === 'MIO_SUPPLIER_NOT_FOUND') {
        // 引导操作者先注册供应商，再用 ID 重试。
        setQsSearch((s) => ({ ...s, searched: true }));
        setQsErr(errMsg(e));
      } else {
        setQsErr(errMsg(e));
      }
    } finally {
      setQsBusy(false);
    }
  };

  /** 多命中时：把候选的供应商 ID 带进「添加 Agent」并视为已解析。 */
  const pickCandidateInAddForm = (c: MioSupplierOption) => {
    setShowQuickStart(false);
    setShowAdd(true);
    setPickTenant('');
    setAddForm({
      ...emptyAdd,
      companyName: qsForm.companyName.trim(),
      contactPhone: qsForm.contactPhone.replace(/[^0-9]/g, ''),
      contactPhoneCode: qsForm.intDialingCode.trim() || '+86',
      planTier: qsForm.planTier,
      mioSupplierId: c.id,
    });
    setMioSelected(c);
    setSupplierHits([c]);
    setSupplierTotal(0);
    setSupplierErr('');
    setSupplierPhase('found');
  };

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
      const prebound = (t.mioCdpSupplierId || '').trim();
      setAddForm((f) => ({
        ...f,
        companyName: t.companyName || '',
        contactEmail: t.contactEmail || '',
        mioSupplierId: prebound,
      }));
      // 带入已有绑定 → 直接视为「已解析出 ID」，无需重新走查询。
      setSupplierErr('');
      setSupplierHits([]);
      if (prebound) {
        setMioSelected({ id: prebound, code: null, name: null });
        setSupplierPhase('found');
      } else {
        setMioSelected(null);
        setSupplierPhase('idle');
      }
    }
  };

  /** 打开「添加 Agent」弹窗，重置上一轮遗留的供应商状态。 */
  const openAddModal = () => {
    setShowAdd(true);
    setPickTenant('');
    setAddErr('');
    setSupplierPhase('idle');
    setSupplierHits([]);
    setSupplierTotal(0);
    setSupplierErr('');
    setMioSelected(null);
  };

  const closeAddModal = () => {
    setShowAdd(false);
  };

  /**
   * 状态机：idle/notfound/found/ambiguous → searching → found / ambiguous / notfound。
   * 米奥侧是模糊匹配，这里只认「名称归一后完全相等」的命中（与后端同口径）。
   */
  const resolveSupplier = async () => {
    const kw = addForm.companyName.trim();
    if (!kw) {
      setSupplierErr('请先填写公司名称，再查询米奥供应商');
      return;
    }
    setSupplierPhase('searching');
    setSupplierErr('');
    setSupplierHits([]);
    setSupplierTotal(0);
    setMioSelected(null);
    setAddForm((f) => ({ ...f, mioSupplierId: '' }));
    try {
      const r = await api<MioSupplierSearchResponse>(
        `/v1/admin/mio-suppliers?search=${encodeURIComponent(kw)}&page=0`,
      );
      const items = r.items || [];
      const exact = items.filter(
        (i) => normalizeName(i.name) !== '' && normalizeName(i.name) === normalizeName(kw),
      );
      setSupplierTotal(r.total ?? 0);
      if (exact.length === 1) {
        // 唯一命中：自动选中。
        setSupplierHits(exact);
        setMioSelected(exact[0]);
        setAddForm((f) => ({ ...f, mioSupplierId: exact[0].id }));
        setSupplierPhase('found');
        return;
      }
      if (exact.length > 1) {
        // 多命中：绝不自动取第一条，交下拉人工选定。
        setSupplierHits(exact);
        setSupplierPhase('ambiguous');
        return;
      }
      setSupplierHits([]);
      setSupplierPhase('notfound');
    } catch (e) {
      setSupplierErr(errMsg(e));
      setSupplierPhase('idle');
    }
  };

  /** ambiguous：下拉人工选定 → 解析出 ID（选中后即可提交）。 */
  const pickMioSupplier = (id: string) => {
    setSupplierErr('');
    setAddForm((f) => ({ ...f, mioSupplierId: id }));
    setMioSelected(supplierHits.find((i) => i.id === id) || null);
  };

  /**
   * 2026-09-16 按 A 方案移除：notfound 时的「注册供应商」入口
   * （POST /v1/admin/mio-suppliers → 米奥 quickRegister）。
   *
   * A 方案以 master 的意图为准：本页停用米奥供应商注册入口，未命中只给提示文案；
   * 请先在小元运营后台把供应商创建好，再回本页重新「查询供应商」关联。
   * 连带删除：supplierRegisterErr / supplierRegisterBusy，以及状态机里的
   * 'registering' / 'registered' 两个阶段；后端接口未做任何改动。
   */

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
    if (!body.mioCdpSupplierId) {
      setAddErr('请先查询并选定供应商：未解析出 Mio CDP 供应商 ID 时无法开通');
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
      setSupplierPhase('idle');
      setSupplierHits([]);
      setSupplierTotal(0);
      setSupplierErr('');
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
          {showQuickStartEntry && (
            <button
              className="btn-secondary"
              title="企业名 → 自动查/建米奥供应商 → 建 Agent → 出飞书二维码（FDE 专用入口）"
              onClick={openQuickStartModal}
            >
              ⚡ 一键开通小元
            </button>
          )}
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
            {/* ── 供应商：一个入口，按顺序走（查 → 命中即用 / 多命中选 / 未命中才注册）── */}
            <div className="form-row">
              <label className="field-label">公司名称</label>
              <input
                type="text"
                value={addForm.companyName}
                onChange={(e) => {
                  const companyName = e.target.value;
                  // 换了名字：之前解析出的供应商 ID 立即失效，回到未查询态。
                  const stale = supplierPhase !== 'idle';
                  setAddForm((f) => ({ ...f, companyName, mioSupplierId: stale ? '' : f.mioSupplierId }));
                  if (stale) {
                    setSupplierPhase('idle');
                    setSupplierHits([]);
                    setSupplierTotal(0);
                    setSupplierErr('');
                    setMioSelected(null);
                  }
                }}
                placeholder="如：示例科技有限公司"
              />
              <button
                className="btn-secondary"
                style={{ flex: '0 0 auto' }}
                disabled={supplierPhase === 'searching'}
                onClick={() => void resolveSupplier()}
              >
                {supplierPhase === 'searching' ? '查询中…' : '查询供应商'}
              </button>
            </div>
            <div className="hint" style={{ marginTop: -4 }}>
              供应商状态：<b>{SUPPLIER_PHASE_LABEL[supplierPhase]}</b>
              {supplierPhase === 'ambiguous' && `（${supplierHits.length} 个名称完全一致，请下拉选定）`}
              {supplierPhase === 'notfound' && `（模糊命中 ${supplierTotal} 条，但无名称完全一致）`}
              {supplierPhase === 'idle' && '（填好公司名称后点右侧「查询供应商」）'}
            </div>
            {supplierErr && <div className="msg msg-err">供应商查询失败：{supplierErr}</div>}
            {supplierPhase === 'ambiguous' && (
              <div className="form-row">
                <label className="field-label">选择供应商</label>
                <select value={addForm.mioSupplierId} onChange={(e) => pickMioSupplier(e.target.value)}>
                  <option value="">请选择（名称 / 编码 / ID）…</option>
                  {supplierHits.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name || '(未命名)'} / {i.code || '无编码'} / {i.id}
                    </option>
                  ))}
                </select>
                <span className="hint" style={{ margin: 0 }}>
                  同名多条，绝不自动取第一条
                </span>
              </div>
            )}
            {supplierPhase === 'notfound' && (
              <div className="msg msg-warn">
                未找到该供应商，请先在小元运营后台创建后再关联
                <div style={{ marginTop: 4, opacity: 0.8 }}>
                  模糊命中 {supplierTotal} 条，但无名称完全一致的供应商；本页不提供注册入口。创建好之后
                  回到上方重新点「查询供应商」，命中后选中的供应商 ID 会自动只读回显。
                </div>
              </div>
            )}
            <div className="form-row">
              <label className="field-label">Mio CDP 供应商 ID</label>
              <input
                type="text"
                className="mono"
                value={addForm.mioSupplierId}
                readOnly
                placeholder="尚未解析 — 请先在上方「查询供应商」"
              />
              {mioSelected && (
                <span className="hint" style={{ margin: 0 }}>
                  已选：{mioSelected.name || '(未命名)'}
                  {mioSelected.code ? ` · ${mioSelected.code}` : ''}
                </span>
              )}
            </div>
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
            <div className="hint">
              添加即真实开通——写客户记录、建 credits 账户、在独立 namespace 创建
              Deployment/Secret/PVC，飞书消息走 openclaw 直连平面（agent 内 @openclaw/feishu
              插件）。<b>飞书 App ID / Secret 必填</b>：未提供凭据将只创建客户记录、不创建
              Agent。前置条件：需先在「模型供应商」页配好全局大模型提供商（LLM_PROVIDERS）。
              供应商必填：先「查询供应商」拿到 Mio CDP 供应商 ID（唯一命中自动选中；多命中下拉选定）；
              未命中请先在小元运营后台创建供应商后再回来查询关联（本页不提供注册入口）。
              解析出的 ID 只读回显，会注入 agent 的 MIO_CDP_SUPPLIER_ID。
            </div>
            <div className="form-row" style={{ marginTop: 12 }}>
              <button
                className="btn-primary"
                onClick={() => void addAgent()}
                disabled={adding || !addForm.mioSupplierId.trim()}
                title={addForm.mioSupplierId.trim() ? undefined : '请先查询并选定供应商'}
              >
                {adding ? '开通中…' : '添加并开通'}
              </button>
              <button className="btn-secondary" onClick={closeAddModal}>
                取消
              </button>
              {!addForm.mioSupplierId.trim() && (
                <span className="hint" style={{ margin: 0 }}>
                  请先查询并选定供应商
                </span>
              )}
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

      {/* ── 一键开通小元（FDE）── */}
      <Modal title="一键开通小元" open={showQuickStart} onClose={() => setShowQuickStart(false)} width={560}>
        {qsErr && <div className="msg msg-err">{qsErr}</div>}
        <div className="form-row">
          <label className="field-label">企业名称</label>
          <input
            type="text"
            value={qsForm.companyName}
            onChange={(e) => setQsForm({ ...qsForm, companyName: e.target.value })}
            placeholder="如：示例科技有限公司（需与米奥侧供应商名称一致）"
          />
          <button
            className="btn-secondary"
            style={{ flex: '0 0 auto' }}
            disabled={qsSearch.busy}
            onClick={() => void searchQsSuppliers()}
          >
            {qsSearch.busy ? '搜索中…' : '查供应商'}
          </button>
        </div>
        {qsSearch.err && <div className="msg msg-err">供应商搜索失败：{qsSearch.err}</div>}
        {qsSearch.searched && !qsSearch.err && (
          <div className="msg msg-warn" style={{ fontSize: 12 }}>
            模糊命中 {qsSearch.total} 条：
            {qsSearch.items.length === 0 ? (
              <span>
                {' '}
                米奥侧无同名供应商 —— 请先在小元运营后台创建供应商，再回来重试；本流程不自动新建。
              </span>
            ) : (
              <span>
                {' '}
                {qsSearch.items.slice(0, 5).map((i) => `${i.name || '(未命名)'} / ${i.id}`).join('；')}
                {qsSearch.items.length > 5 ? ' …' : ''}
              </span>
            )}
          </div>
        )}
        <div className="form-row">
          <label className="field-label">联系人手机</label>
          <input
            type="text"
            style={{ flex: '0 0 90px', minWidth: 0 }}
            value={qsForm.intDialingCode}
            onChange={(e) => setQsForm({ ...qsForm, intDialingCode: e.target.value })}
            placeholder="+86"
          />
          <input
            type="text"
            value={qsForm.contactPhone}
            onChange={(e) => setQsForm({ ...qsForm, contactPhone: e.target.value })}
            placeholder="必填，如 13800000000"
          />
        </div>
        <div className="form-row">
          <label className="field-label">套餐档位</label>
          <select
            value={qsForm.planTier}
            onChange={(e) => setQsForm({ ...qsForm, planTier: e.target.value })}
          >
            <option value="starter">starter</option>
            <option value="pro">pro</option>
            <option value="enterprise">enterprise</option>
          </select>
        </div>

        {qsCandidates.length > 0 && (
          <div className="panel" style={{ marginTop: 8 }}>
            <div className="panel-head">
              <div>
                <div className="panel-title">米奥侧有 {qsCandidates.length} 个同名供应商</div>
                <div className="panel-sub">按规则不自动取第一条：以下候选需人工指定</div>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>编码</th>
                  <th>ID</th>
                  <th style={{ width: 150 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {qsCandidates.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name || '(未命名)'}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{c.code || '—'}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{c.id}</td>
                    <td>
                      <button className="btn-secondary btn-sm" onClick={() => pickCandidateInAddForm(c)}>
                        用它手工开通
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="hint">
          一键开通只填「企业名称 + 联系人手机 + 套餐」：系统按企业名命中**已有**米奥供应商
          （唯一精确命中）→ 创建客户与 Agent 记录 → 生成飞书扫码二维码。
          不再自动注册供应商：未命中会明确报错，请先在小元运营后台创建后再重试；
          无飞书凭据时先建客户记录（Agent 待客户扫码后自动开通）；
          米奥多命中时不会自动选第一条，需人工指定。
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={() => void submitQuickStart()} disabled={qsBusy}>
            {qsBusy ? '开通中…' : '⚡ 一键开通并出码'}
          </button>
          <button className="btn-secondary" onClick={() => setShowQuickStart(false)}>
            取消
          </button>
        </div>
      </Modal>

      <QuickStartScanModal
        open={showQsScan}
        result={qsResult}
        onClose={() => setShowQsScan(false)}
        onCompleted={() => {
          void load().then(loadCredits);
        }}
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
