// 客户详情 — migrated from the legacy prebuilt SPA (view: detail).
// Data: credits-ledger GET /v1/admin/customers/:tenantId.
// 租户生命周期（状态/资料/销毁/状态日志）合并自原「租户管理」页。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { TENANT_STATUSES, type ImageRelease, type StatusLogEntry, type Tenant } from '../lib/types';
import { PlanBadge, StatusBadge, fmtNum, fmtTime } from '../components/badges';
import FeishuAppScanModal from '../components/FeishuAppScanModal';
import { IconArrowLeft, IconBox, IconChat, IconRefresh, IconTrash } from '../components/icons';

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

  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [statusLog, setStatusLog] = useState<StatusLogEntry[]>([]);
  const [tenantErr, setTenantErr] = useState('');
  const [dStatus, setDStatus] = useState('pending');
  const [dReason, setDReason] = useState('');
  const [dCompany, setDCompany] = useState('');
  const [dEmail, setDEmail] = useState('');
  const [msg, setMsg] = useState('');

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 6000);
  };

  const loadTenant = useCallback(async () => {
    try {
      const r = await api<{ tenant: Tenant; statusLog: StatusLogEntry[] }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}`,
      );
      setTenant(r.tenant);
      setStatusLog(r.statusLog || []);
      setDStatus(r.tenant.status || 'pending');
      setDCompany(r.tenant.companyName || '');
      setDEmail(r.tenant.contactEmail || '');
      setTenantErr('');
    } catch (e) {
      setTenant(null);
      setTenantErr(errMsg(e));
    }
  }, [tenantId]);

  useEffect(() => {
    void loadTenant();
  }, [loadTenant]);

  const changeStatus = async () => {
    const reason = dReason.trim() || '管理员手动变更';
    if (!window.confirm(`确认将租户 ${tenantId} 状态改为 ${dStatus}？`)) return;
    try {
      const r = await api<{ fromStatus: string; toStatus: string }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/status`,
        { method: 'PATCH', body: { status: dStatus, reason } },
      );
      flash(`状态已更新：${r.fromStatus} → ${r.toStatus}`);
      setDReason('');
      await loadTenant();
    } catch (e) {
      flash(`状态变更失败：${errMsg(e)}`);
    }
  };

  const saveProfile = async () => {
    const companyName = dCompany.trim();
    const contactEmail = dEmail.trim();
    if (!companyName && !contactEmail) {
      flash('公司名称与邮箱至少填一项');
      return;
    }
    try {
      await api(`/v1/tenants/${encodeURIComponent(tenantId)}/profile`, {
        method: 'PATCH',
        body: { companyName, contactEmail },
      });
      flash('资料已更新');
      await loadTenant();
    } catch (e) {
      flash(`资料更新失败：${errMsg(e)}`);
    }
  };

  const destroyTenant = async () => {
    if (
      !window.confirm(
        `确认销毁租户「${tenant?.companyName || tenantId}」？将删除其 namespace 内全部 K8s 资源（租户记录保留为 destroyed）。此操作不可逆。`,
      )
    )
      return;
    try {
      await api(`/v1/tenants/${encodeURIComponent(tenantId)}`, { method: 'DELETE' });
      flash(`租户已销毁：${tenantId}`);
      await loadTenant();
    } catch (e) {
      flash(`销毁失败：${errMsg(e)}`);
    }
  };

  // ── 飞书绑定 ──
  interface FeishuBinding {
    tenantId: string;
    bound: boolean;
    appId: string | null;
    platform: string;
    imOpenId: string | null;
  }

  const [fsBinding, setFsBinding] = useState<FeishuBinding | null>(null);
  const [fsAppId, setFsAppId] = useState('');
  const [fsAppSecret, setFsAppSecret] = useState('');
  const [fsBusy, setFsBusy] = useState(false);
  const [fsScan, setFsScan] = useState(false);

  const loadBinding = useCallback(async () => {
    try {
      const r = await api<{ binding: FeishuBinding }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/feishu-binding`,
      );
      setFsBinding(r.binding);
    } catch {
      setFsBinding(null);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadBinding();
  }, [loadBinding]);

  const bindFeishu = async () => {
    const appId = fsAppId.trim();
    const appSecret = fsAppSecret.trim();
    if (!/^cli_[a-zA-Z0-9]{4,64}$/.test(appId)) {
      flash('App ID 格式不正确（应以 cli_ 开头）');
      return;
    }
    if (!appSecret || appSecret.length < 8) {
      flash('请填写完整的 App Secret');
      return;
    }
    setFsBusy(true);
    try {
      const r = await api<{ message?: string }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/feishu-binding`,
        { method: 'PUT', body: { appId, appSecret } },
      );
      flash(r.message || `已绑定 ${appId}`);
      setFsAppSecret('');
      await loadBinding();
      await loadTenant();
    } catch (e) {
      flash(`绑定失败：${errMsg(e)}`);
    } finally {
      setFsBusy(false);
    }
  };

  const unbindFeishu = async () => {
    if (
      !window.confirm(
        `确认解绑租户「${tenant?.companyName || tenantId}」的飞书应用 ${fsBinding?.appId || ''}？\n解绑后该租户无法通过飞书聊天（网页对话不受影响），网关将被删除。`,
      )
    )
      return;
    setFsBusy(true);
    try {
      const r = await api<{ message?: string }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/feishu-binding`,
        { method: 'DELETE' },
      );
      flash(r.message || '已解绑');
      await loadBinding();
      await loadTenant();
    } catch (e) {
      flash(`解绑失败：${errMsg(e)}`);
    } finally {
      setFsBusy(false);
    }
  };

  // ── Skill 环境变量（.env）──
  interface SkillEnvEntry {
    key: string;
    source: 'tenant' | 'global' | 'tenant-record';
    isSecret: boolean;
    description: string | null;
    updatedAt: string;
    displayValue: string;
  }

  interface SkillEnvPush {
    status?: 'ok' | 'failed' | 'skipped';
    rollout?: string;
    detail?: string;
    hint: string;
  }

  const [skillEnv, setSkillEnv] = useState<SkillEnvEntry[] | null>(null);
  const [seKey, setSeKey] = useState('');
  const [seValue, setSeValue] = useState('');
  const [seBusy, setSeBusy] = useState(false);
  const [seSyncBusy, setSeSyncBusy] = useState(false);

  const loadSkillEnv = useCallback(async () => {
    try {
      const r = await api<{ entries: SkillEnvEntry[] }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/skill-env`,
      );
      setSkillEnv(r.entries || []);
    } catch {
      setSkillEnv([]);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadSkillEnv();
  }, [loadSkillEnv]);

  // MIO_CDP_SUPPLIER_ID 存在客户档案（tenants 行），走独立 API：
  // 会同步刷新 skill-env .env 并滚动重启 agent 一次。
  const saveMioSupplier = async (supplierId: string | null) => {
    setSeBusy(true);
    try {
      const r = await api<{ message?: string }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/mio-supplier-id`,
        { method: 'PATCH', body: { supplierId } },
      );
      flash(r.message || '供应商 ID 已更新');
      await Promise.all([loadTenant(), loadSkillEnv()]);
    } catch (e) {
      flash(`供应商 ID 更新失败：${errMsg(e)}`);
    } finally {
      setSeBusy(false);
    }
  };

  const saveSkillEnvKey = async (keyOverride?: string, valueOverride?: string) => {
    const key = (keyOverride ?? seKey).trim();
    const value = valueOverride ?? seValue;
    if (!key || !value) {
      flash('Key 与 Value 为必填');
      return;
    }
    if (key === 'MIO_CDP_SUPPLIER_ID') {
      // 统一入口：供应商 ID 落客户档案而非 runtime_configs（有唯一性校验）
      await saveMioSupplier(value.trim());
      setSeKey('');
      setSeValue('');
      return;
    }
    setSeBusy(true);
    try {
      const r = await api<{ push: SkillEnvPush }>('/v1/admin/runtime-configs', {
        method: 'PUT',
        body: { tenantId, key, value, isSecret: true },
      });
      // 生效时间提示由服务端按推送结果返回（热生效 / 首次挂载重启 / 失败重试）
      flash(r.push?.hint || `已保存 ${key}（租户覆盖）`);
      setSeKey('');
      setSeValue('');
      await loadSkillEnv();
    } catch (e) {
      flash(`保存失败：${errMsg(e)}`);
    } finally {
      setSeBusy(false);
    }
  };

  const isMasked = (v: string) => !v || v === '••••••••' || v === '(解密失败)';

  const editSkillEnvValue = async (entry: SkillEnvEntry) => {
    if (entry.source === 'tenant-record') {
      const value = window.prompt(
        `为「MIO_CDP_SUPPLIER_ID」输入新的供应商 ID（1–64 位字母/数字/下划线/连字符）：`,
        isMasked(entry.displayValue) ? '' : entry.displayValue,
      );
      if (value === null) return;
      if (!value.trim()) {
        flash('供应商 ID 不能为空；如需清除请点「清除」');
        return;
      }
      await saveMioSupplier(value.trim());
      return;
    }
    const value = window.prompt(
      `为「${entry.key}」输入该租户的新值：`,
      isMasked(entry.displayValue) ? '' : entry.displayValue,
    );
    if (value === null || value === '') return;
    await saveSkillEnvKey(entry.key, value);
  };

  const clearMioSupplier = async () => {
    if (
      !window.confirm(
        `确认清除该客户的 Mio CDP 供应商 ID？\n将从 work/mio-api/.env 移除 MIO_CDP_SUPPLIER_ID，并滚动重启 agent 一次。`,
      )
    )
      return;
    await saveMioSupplier(null);
  };

  const removeSkillEnvOverride = async (entry: SkillEnvEntry) => {
    if (
      !window.confirm(
        `确认删除该租户对「${entry.key}」的覆盖值？删除后将回退使用全局默认值（如存在）。`,
      )
    )
      return;
    setSeBusy(true);
    try {
      const r = await api<{ push: SkillEnvPush }>(
        `/v1/admin/runtime-configs/${encodeURIComponent(entry.key)}?tenantId=${encodeURIComponent(tenantId)}`,
        { method: 'DELETE' },
      );
      flash(r.push?.hint || `已删除 ${entry.key} 的租户覆盖`);
      await loadSkillEnv();
    } catch (e) {
      flash(`删除失败：${errMsg(e)}`);
    } finally {
      setSeBusy(false);
    }
  };

  const syncSkillEnv = async () => {
    setSeSyncBusy(true);
    try {
      const r = await api<{ message?: string; hint?: string; warnings?: string[] }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/skill-env/sync`,
        { method: 'POST' },
      );
      flash([r.message, ...(r.warnings || [])].filter(Boolean).join('；'));
      await loadSkillEnv();
    } catch (e) {
      flash(`同步失败：${errMsg(e)}`);
    } finally {
      setSeSyncBusy(false);
    }
  };

  const SE_SOURCE_BADGE: Record<SkillEnvEntry['source'], { cls: string; text: string }> = {
    tenant: { cls: 'badge badge-warn', text: '租户覆盖' },
    global: { cls: 'badge badge-active', text: '全局默认' },
    'tenant-record': { cls: 'badge badge-pending', text: '客户档案' },
  };

  // ── 运行镜像更新（单租户） ──
  const [releases, setReleases] = useState<ImageRelease[]>([]);
  const [imgService, setImgService] = useState<'dealclaw-agent' | 'nexus-gateway'>('dealclaw-agent');
  const [imgTag, setImgTag] = useState('');
  const [imgBusy, setImgBusy] = useState(false);

  useEffect(() => {
    api<{ releases: ImageRelease[] }>('/v1/admin/image-releases?limit=50')
      .then((r) => setReleases(r.releases || []))
      .catch(() => {});
  }, []);

  const serviceReleases = releases.filter((r) => r.service === imgService);

  const updateImage = async () => {
    const tag = imgTag.trim();
    if (!tag) {
      flash('请输入或选择镜像 Tag');
      return;
    }
    if (
      !window.confirm(
        `确认将租户 ${tenantId} 的 ${imgService} 镜像更新为 ${tag}？\nPod 将滚动重启，期间该租户服务短暂不可用。`,
      )
    )
      return;
    setImgBusy(true);
    try {
      const r = await api<{ image: string }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/deployment`,
        { method: 'PATCH', body: { service: imgService, image: tag } },
      );
      flash(`已触发滚动更新：${imgService} → ${r.image || tag}`);
      setImgTag('');
    } catch (e) {
      flash(`镜像更新失败：${errMsg(e)}`);
    } finally {
      setImgBusy(false);
    }
  };

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
      <div className="page-head">
        <Link to="/customers" className="link-back">
          <IconArrowLeft /> 返回客户列表
        </Link>
        <div className="page-actions">
          <button
            className="btn-secondary"
            onClick={() => {
              void load();
              void loadTenant();
            }}
          >
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>

      {msg && <div className="msg msg-ok">{msg}</div>}

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

      {/* ── 租户开通与状态 ── */}
      <div className="section-title" style={{ fontSize: 14, marginTop: 24 }}>
        租户开通与状态
      </div>
      {tenantErr ? (
        <div className="hint">未加载到开通信息：{tenantErr}</div>
      ) : !tenant ? (
        <div className="empty">加载中...</div>
      ) : (
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">开通信息</div>
              <div className="panel-sub">provisioning-service · {tenant.tenantId}</div>
            </div>
            <StatusBadge status={tenant.status} />
          </div>
          <div className="panel-body">
            <div className="detail-grid">
              <div className="detail-item">
                <div className="k">公司名称</div>
                <div className="v">{tenant.companyName || '-'}</div>
              </div>
              <div className="detail-item">
                <div className="k">联系邮箱 / 电话</div>
                <div className="v">
                  {tenant.contactEmail || '-'} / {tenant.contactPhone || '-'}
                </div>
              </div>
              <div className="detail-item">
                <div className="k">套餐 / Agent 配额</div>
                <div className="v">
                  <PlanBadge plan={tenant.planTier} /> × {tenant.quotaAgents ?? '-'}
                </div>
              </div>
              <div className="detail-item">
                <div className="k">月度积分额度</div>
                <div className="v">{fmtNum(tenant.quotaCreditsMonthly)}</div>
              </div>
              <div className="detail-item">
                <div className="k">K8s Namespace</div>
                <div className="v">{tenant.k8sNamespace || '-'}</div>
              </div>
              <div className="detail-item">
                <div className="k">Mio CDP 供应商 ID</div>
                <div className="v mono">{tenant.mioCdpSupplierId || '—'}</div>
              </div>
              <div className="detail-item">
                <div className="k">Credits 账户</div>
                <div className="v">{tenant.creditsAccountId || '-'}</div>
              </div>
              <div className="detail-item">
                <div className="k">创建时间</div>
                <div className="v">{fmtTime(tenant.createdAt)}</div>
              </div>
              <div className="detail-item">
                <div className="k">更新时间</div>
                <div className="v">{fmtTime(tenant.updatedAt)}</div>
              </div>
            </div>

            <div className="form-row">
              <label className="field-label">变更状态</label>
              <select value={dStatus} onChange={(e) => setDStatus(e.target.value)}>
                {TENANT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <input
                type="text"
                style={{ flex: 1, minWidth: 180 }}
                value={dReason}
                onChange={(e) => setDReason(e.target.value)}
                placeholder="变更原因（记入状态日志）"
              />
              <button className="btn-secondary" onClick={() => void changeStatus()}>
                应用
              </button>
            </div>
            <div className="form-row">
              <label className="field-label">编辑资料</label>
              <input
                type="text"
                style={{ flex: 1, minWidth: 160 }}
                value={dCompany}
                onChange={(e) => setDCompany(e.target.value)}
                placeholder="公司名称"
              />
              <input
                type="text"
                style={{ flex: 1, minWidth: 160 }}
                value={dEmail}
                onChange={(e) => setDEmail(e.target.value)}
                placeholder="联系邮箱"
              />
              <button className="btn-secondary" onClick={() => void saveProfile()}>
                保存
              </button>
            </div>
            <div className="form-row">
              <label className="field-label" />
              <button className="btn-danger" onClick={() => void destroyTenant()}>
                <IconTrash /> 销毁租户
              </button>
            </div>

            {statusLog.length > 0 && (
              <>
                <div style={{ fontSize: 13, color: '#171c2e', fontWeight: 600, margin: '14px 0 8px' }}>
                  状态日志
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>变更</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statusLog.map((l, i) => (
                      <tr key={i}>
                        <td style={{ fontSize: 11, color: '#777' }}>{fmtTime(l.at)}</td>
                        <td className="mono">
                          {l.from ?? '∅'} → {l.to}
                        </td>
                        <td>{l.reason || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── 飞书绑定 ── */}
      <div className="section-title" style={{ fontSize: 14, marginTop: 24 }}>
        飞书绑定
      </div>
      <div className="panel">
        <div className="panel-body">
          <div className="form-row" style={{ marginBottom: 10 }}>
            <label className="field-label">当前状态</label>
            {fsBinding === null ? (
              <span className="hint" style={{ margin: 0 }}>加载中…</span>
            ) : fsBinding.bound ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="badge badge-active">已绑定</span>
                <span className="mono" style={{ fontSize: 12 }}>{fsBinding.appId}</span>
                {fsBinding.imOpenId && (
                  <span className="hint" style={{ margin: 0 }}>
                    通知联系人 open_id：{fsBinding.imOpenId.slice(0, 12)}…
                  </span>
                )}
                <button
                  className="btn-danger"
                  disabled={fsBusy}
                  onClick={() => void unbindFeishu()}
                >
                  解绑
                </button>
              </span>
            ) : (
              <span className="badge badge-pending">未绑定（仅网页对话）</span>
            )}
          </div>
          <div className="form-row">
            <label className="field-label">App ID</label>
            <input
              type="text"
              className="mono"
              style={{ flex: '0 1 260px' }}
              value={fsAppId}
              onChange={(e) => setFsAppId(e.target.value)}
              placeholder="cli_xxxxxxxxxxxxxxxx"
            />
            <input
              type="password"
              style={{ flex: 1, minWidth: 180 }}
              value={fsAppSecret}
              onChange={(e) => setFsAppSecret(e.target.value)}
              placeholder="App Secret（仅提交时传输）"
            />
            <button
              className="btn-secondary"
              disabled={fsBusy}
              style={{ flex: '0 0 auto' }}
              onClick={() => setFsScan(true)}
            >
              扫码获取
            </button>
            <button className="btn-primary" disabled={fsBusy} onClick={() => void bindFeishu()}>
              <IconChat /> {fsBusy ? '处理中…' : fsBinding?.bound ? '更换绑定' : '绑定'}
            </button>
          </div>
          <div className="hint">
            绑定后该租户的智能体即可在飞书中对话：网关通过长连接接入飞书，无需公网回调。要求应用已启用「机器人」能力并开启「长连接」接收模式。
            绑定时会先向飞书校验凭据，校验通过才生效；同一应用同时只能绑定一个租户。
          </div>
        </div>
      </div>

      {/* ── 飞书扫码获取应用凭据（回填绑定表单） ── */}
      <FeishuAppScanModal
        open={fsScan}
        onClose={() => setFsScan(false)}
        onCredentials={(appId, appSecret) => {
          setFsAppId(appId);
          setFsAppSecret(appSecret);
          flash(`已扫码获取凭据（${appId}），请确认后点击绑定`);
        }}
      />

      {/* ── Skill 环境变量（.env） ── */}
      <div className="section-title" style={{ fontSize: 14, marginTop: 24 }}>
        Skill 环境变量（.env）
      </div>
      <div className="panel">
        <div className="panel-body">
          <div className="hint" style={{ marginBottom: 10 }}>
            这些 Key 以 <span className="mono">work/mio-api/.env</span> 形式下发到该租户 agent
            （每个租户可单独设值，未覆盖的 Key 沿用全局默认，可添加任意 KEY=VALUE）。
            保存后由 Secret 卷自动热更新，<b>通常无需重启 agent，约 1 分钟内生效</b>；首次挂载会滚动重启一次。
            MIO_CDP_SUPPLIER_ID 在此一并管理（存客户档案，修改后 agent 滚动重启一次生效）。
            DEEPSEEK_API_KEY 不在此管理（仅开通/重启时经 envFrom 注入）。
          </div>

          {skillEnv === null ? (
            <div className="empty">加载中…</div>
          ) : skillEnv.length === 0 ? (
            <div className="empty">暂无配置：在下方添加该租户的专属 Key，或到「运行时配置」页设置全局默认</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>来源</th>
                  <th>当前值</th>
                  <th>说明</th>
                  <th>更新时间</th>
                  <th style={{ width: 150 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {skillEnv.map((entry) => (
                  <tr key={entry.key}>
                    <td className="mono">{entry.key}</td>
                    <td>
                      <span className={SE_SOURCE_BADGE[entry.source].cls}>
                        {SE_SOURCE_BADGE[entry.source].text}
                      </span>
                    </td>
                    <td className="mono">{entry.displayValue}</td>
                    <td style={{ fontSize: 12 }}>{entry.description || '-'}</td>
                    <td style={{ fontSize: 11, color: '#777' }}>
                      {entry.updatedAt ? fmtTime(entry.updatedAt) : '-'}
                    </td>
                    <td>
                      <button
                        className="btn-secondary btn-sm"
                        disabled={seBusy}
                        onClick={() => void editSkillEnvValue(entry)}
                      >
                        改值
                      </button>{' '}
                      {entry.source === 'tenant' && (
                        <button
                          className="btn-danger btn-sm"
                          disabled={seBusy}
                          onClick={() => void removeSkillEnvOverride(entry)}
                        >
                          删除覆盖
                        </button>
                      )}
                      {entry.source === 'tenant-record' && (
                        <button
                          className="btn-danger btn-sm"
                          disabled={seBusy}
                          onClick={() => void clearMioSupplier()}
                        >
                          清除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="form-row" style={{ marginTop: 12 }}>
            <label className="field-label">添加 / 覆盖</label>
            <input
              type="text"
              className="mono"
              style={{ flex: '0 1 240px' }}
              value={seKey}
              onChange={(e) => setSeKey(e.target.value)}
              placeholder="任意 KEY_NAME，如 APIFY_TOKEN"
            />
            <input
              type="text"
              className="mono"
              style={{ flex: 1, minWidth: 200 }}
              value={seValue}
              onChange={(e) => setSeValue(e.target.value)}
              placeholder="该租户的专属值（保存时加密入库）"
            />
            <button
              className="btn-primary"
              disabled={seBusy}
              onClick={() => void saveSkillEnvKey()}
            >
              {seBusy ? '保存中…' : '保存'}
            </button>
          </div>
          <div className="form-row">
            <label className="field-label" />
            <button
              className="btn-secondary"
              disabled={seSyncBusy}
              onClick={() => void syncSkillEnv()}
            >
              <IconRefresh /> {seSyncBusy ? '同步中…' : '同步到 agent'}
            </button>
          </div>
          <div className="hint">
            「同步到 agent」会重写该租户的 skill-env Secret 并确保已挂载；当推送失败或修改后未生效时可手动触发。
          </div>
        </div>
      </div>

      {/* ── 运行镜像更新 ── */}
      <div className="section-title" style={{ fontSize: 14, marginTop: 24 }}>
        运行镜像更新
      </div>
      <div className="panel">
        <div className="panel-body">
          <div className="form-row">
            <label className="field-label">服务</label>
            <select
              value={imgService}
              onChange={(e) => {
                setImgService(e.target.value as 'dealclaw-agent' | 'nexus-gateway');
                setImgTag('');
              }}
            >
              <option value="dealclaw-agent">dealclaw-agent</option>
              <option value="nexus-gateway">nexus-gateway</option>
            </select>
            <input
              type="text"
              className="mono"
              style={{ flex: 1, minWidth: 220 }}
              list={`img-tags-${imgService}`}
              value={imgTag}
              onChange={(e) => setImgTag(e.target.value)}
              placeholder="选择或输入镜像 Tag，如 master.e3d43339.12"
            />
            <datalist id={`img-tags-${imgService}`}>
              {serviceReleases.map((r) => (
                <option key={r.id} value={r.tag}>
                  {`${fmtTime(r.createdAt)} · ${r.createdBy || ''}`}
                </option>
              ))}
            </datalist>
            <button className="btn-primary" onClick={() => void updateImage()} disabled={imgBusy}>
              {imgBusy ? '更新中…' : (<><IconBox /> 更新此租户镜像</>)}
            </button>
          </div>
          <div className="hint">
            仅更新当前租户（滚动重启该服务的 Deployment）。如需把某个版本推给全部租户，请到
            「镜像版本」页使用「提升发布」，由 ops-agent 自动滚动更新。
          </div>
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
