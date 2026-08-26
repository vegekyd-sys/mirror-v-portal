// Agent 详情与设置 — 从 CustomerDetailPage 迁移的 Agent 运维四区块
// （开通信息与状态 / 飞书绑定 / Skill 环境变量 / 运行镜像更新），
// 并新增：运行状态面板（Deployment/Pod）、扩缩容（挂起/恢复）、备份/归档/恢复。
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import { TENANT_STATUSES, type ImageRelease, type StatusLogEntry, type Tenant } from '../lib/types';
import { PlanBadge, StatusBadge, fmtNum, fmtTime } from '../components/badges';
import FeishuAppScanModal from '../components/FeishuAppScanModal';
import { IconArrowLeft, IconBox, IconChat, IconRefresh, IconTrash } from '../components/icons';

interface RuntimeContainer {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  state: string;
  startedAt?: string | null;
}

interface RuntimePod {
  name: string;
  phase: string;
  ready: boolean;
  containers: RuntimeContainer[];
}

interface RuntimeStatus {
  dryRun?: boolean;
  namespace?: string;
  deployments: { name: string; replicas: number; readyReplicas: number; unavailableReplicas: number }[];
  pods: RuntimePod[];
}

interface FeishuBinding {
  tenantId: string;
  bound: boolean;
  appId: string | null;
  platform: string;
  imOpenId: string | null;
}

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

const SE_SOURCE_BADGE: Record<SkillEnvEntry['source'], { cls: string; text: string }> = {
  tenant: { cls: 'badge badge-warn', text: '租户覆盖' },
  global: { cls: 'badge badge-active', text: '全局默认' },
  'tenant-record': { cls: 'badge badge-pending', text: '客户档案' },
};

export default function AgentDetailPage() {
  const { tenantId = '' } = useParams();
  const [msg, setMsg] = useState('');

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 6000);
  };

  // ── 开通信息与状态 ──
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [statusLog, setStatusLog] = useState<StatusLogEntry[]>([]);
  const [tenantErr, setTenantErr] = useState('');
  const [dStatus, setDStatus] = useState('pending');
  const [dReason, setDReason] = useState('');
  const [dCompany, setDCompany] = useState('');
  const [dEmail, setDEmail] = useState('');

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
    if (!window.confirm(`确认将 Agent（租户 ${tenantId}）状态改为 ${dStatus}？`)) return;
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
        `确认销毁 Agent「${tenant?.companyName || tenantId}」？将删除其 namespace 内全部 K8s 资源（客户记录保留为 destroyed）。此操作不可逆。`,
      )
    )
      return;
    try {
      await api(`/v1/tenants/${encodeURIComponent(tenantId)}`, { method: 'DELETE' });
      flash(`Agent 已销毁：${tenantId}`);
      await loadTenant();
    } catch (e) {
      flash(`销毁失败：${errMsg(e)}`);
    }
  };

  // ── 运行状态（K8s） ──
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [rtBusy, setRtBusy] = useState(false);
  const [scaleService, setScaleService] = useState<'dealclaw-agent' | 'nexus-gateway'>('dealclaw-agent');
  const [scaleReplicas, setScaleReplicas] = useState('1');

  const loadRuntime = useCallback(async () => {
    setRtBusy(true);
    try {
      const r = await api<RuntimeStatus>(`/v1/tenants/${encodeURIComponent(tenantId)}/runtime`);
      setRuntime(r);
    } catch (e) {
      setRuntime(null);
      flash(`运行状态获取失败：${errMsg(e)}`);
    } finally {
      setRtBusy(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadRuntime();
  }, [loadRuntime]);

  const applyScale = async () => {
    const replicas = Number(scaleReplicas);
    if (!Number.isInteger(replicas) || replicas < 0) {
      flash('副本数必须为不小于 0 的整数（0 = 挂起）');
      return;
    }
    if (
      !window.confirm(
        `确认将 ${scaleService} 副本数设为 ${replicas}？${replicas === 0 ? '该服务将停止（挂起）。' : '将滚动到新副本数。'}`,
      )
    )
      return;
    try {
      const r = await api<{ action?: string }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/deployment/scale`,
        { method: 'PATCH', body: { service: scaleService, replicas } },
      );
      flash(`已${r.action === 'suspend' ? '挂起' : '恢复/扩缩容'}：${scaleService} × ${replicas}`);
      await loadRuntime();
    } catch (e) {
      flash(`扩缩容失败：${errMsg(e)}`);
    }
  };

  const runBackup = async (mode: 'backup' | 'archive') => {
    if (!window.confirm(`确认发起${mode === 'archive' ? '归档' : '备份'} Job？将在后台执行。`)) return;
    try {
      const r = await api<{ jobName: string; warnings?: string[] }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/backup`,
        { method: 'POST', body: { mode } },
      );
      flash(`${mode === 'archive' ? '归档' : '备份'} Job 已创建：${r.jobName}${r.warnings?.length ? `（${r.warnings.join('；')}）` : ''}`);
    } catch (e) {
      flash(`${mode === 'archive' ? '归档' : '备份'}失败：${errMsg(e)}`);
    }
  };

  const runRestore = async () => {
    const source = window.confirm('点「确定」从 backup 恢复；点「取消」改选 archive 归档恢复。') ? 'backup' : null;
    let src = source;
    if (!source) {
      src = window.confirm('确认从 archive 归档恢复？当前数据将被归档数据覆盖。') ? 'archive' : null;
    }
    if (!src) return;
    if (!window.confirm(`确认执行恢复（source=${src}）？恢复期间 Agent 短暂不可用。`)) return;
    try {
      const r = await api<{ jobName: string; warnings?: string[] }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}/restore`,
        { method: 'POST', body: { source: src } },
      );
      flash(`恢复 Job 已创建：${r.jobName}`);
    } catch (e) {
      flash(`恢复失败：${errMsg(e)}`);
    }
  };

  // ── 飞书绑定 ──
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
      await Promise.all([loadBinding(), loadTenant()]);
    } catch (e) {
      flash(`绑定失败：${errMsg(e)}`);
    } finally {
      setFsBusy(false);
    }
  };

  const unbindFeishu = async () => {
    if (
      !window.confirm(
        `确认解绑该 Agent 的飞书应用 ${fsBinding?.appId || ''}？\n解绑后无法通过飞书对话（网页对话不受影响），网关将保留（LLM 出口代理）。`,
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
      await Promise.all([loadBinding(), loadTenant()]);
    } catch (e) {
      flash(`解绑失败：${errMsg(e)}`);
    } finally {
      setFsBusy(false);
    }
  };

  // ── Skill 环境变量（.env） ──
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
        `确认清除该 Agent 的 Mio CDP 供应商 ID？\n将从 work/mio-api/.env 移除 MIO_CDP_SUPPLIER_ID，并滚动重启 agent 一次。`,
      )
    )
      return;
    await saveMioSupplier(null);
  };

  const removeSkillEnvOverride = async (entry: SkillEnvEntry) => {
    if (
      !window.confirm(
        `确认删除该 Agent 对「${entry.key}」的覆盖值？删除后将回退使用全局默认值（如存在）。`,
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

  // ── 模型选择（从全局供应商库中为本 Agent 选模型） ──
  interface LlmSelectionView {
    rawSelection: string | null;
    rawImageSelection: string | null;
    selection: string | null;
    effectiveModel: string | null;
    imageSelection: string | null;
    effectiveImageModel: string | null;
    libraryEmpty: boolean;
    globalDefaultModel: string | null;
    globalImageModel: string | null;
    directMode: boolean;
  }
  interface LlmLibraryProvider {
    name: string;
    models: Array<{ id: string; vision?: boolean }>;
  }
  const [llmSel, setLlmSel] = useState<LlmSelectionView | null>(null);
  const [llmLib, setLlmLib] = useState<LlmLibraryProvider[]>([]);
  const [llmChoice, setLlmChoice] = useState('');
  const [llmImageChoice, setLlmImageChoice] = useState('');
  const [llmDirect, setLlmDirect] = useState(false);
  const [llmBusy, setLlmBusy] = useState(false);

  const loadLlmSelection = useCallback(async () => {
    try {
      const [sel, lib] = await Promise.all([
        api<LlmSelectionView>(
          `/v1/admin/llm-providers/selection?tenantId=${encodeURIComponent(tenantId)}`,
        ),
        api<{ config: { providers: LlmLibraryProvider[] } | null }>(
          '/v1/admin/llm-providers',
        ),
      ]);
      setLlmSel(sel);
      setLlmLib(lib.config?.providers || []);
      setLlmChoice(sel.selection || '');
      setLlmImageChoice(sel.imageSelection || '');
      setLlmDirect(sel.directMode === true);
    } catch {
      setLlmSel(null);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadLlmSelection();
  }, [loadLlmSelection]);

  // ── LLM 用量摘要（网关出口代理记账，shadow 不扣 credits） ──
  interface LlmUsageSummary {
    totals: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number };
    byModel: Array<{ provider: string; model: string; calls: number; inputTokens: number; outputTokens: number }>;
  }
  const [llmUsage, setLlmUsage] = useState<LlmUsageSummary | null>(null);

  const loadLlmUsage = useCallback(async () => {
    try {
      const r = await api<LlmUsageSummary>(
        `/v1/admin/llm-usage/summary?tenantId=${encodeURIComponent(tenantId)}&days=7`,
      );
      setLlmUsage(r);
    } catch {
      setLlmUsage(null);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadLlmUsage();
  }, [loadLlmUsage]);

  const saveLlmSelection = async () => {
    setLlmBusy(true);
    try {
      const r = await api<{ push?: { hint?: string } }>('/v1/admin/llm-providers/selection', {
        method: 'PUT',
        body: { tenantId, defaultModel: llmChoice || null, imageModel: llmImageChoice || null, directMode: llmDirect },
      });
      const parts: string[] = [];
      if (llmChoice) parts.push(`主模型：${llmChoice}`);
      else parts.push('主模型：跟随系统默认');
      if (llmImageChoice) parts.push(`视觉模型：${llmImageChoice}`);
      else parts.push('视觉模型：跟随系统默认');
      parts.push(`大模型接入：${llmDirect ? '直连上游（绕过网关）' : '经网关代理（含增值服务）'}`);
      flash(`已保存本 Agent 模型选择（${parts.join('；')}）。${r.push?.hint || ''}`);
      await loadLlmSelection();
    } catch (e) {
      flash(`模型选择保存失败：${errMsg(e)}`);
    } finally {
      setLlmBusy(false);
    }
  };

  // ── 运行镜像更新 ──
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
        `确认将该 Agent 的 ${imgService} 镜像更新为 ${tag}？\nPod 将滚动重启，期间服务短暂不可用。`,
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
      await loadRuntime();
    } catch (e) {
      flash(`镜像更新失败：${errMsg(e)}`);
    } finally {
      setImgBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <Link to="/agents" className="link-back">
          <IconArrowLeft /> 返回 Agents 管理
        </Link>
        <div className="page-actions">
          <button
            className="btn-secondary"
            onClick={() => {
              void loadTenant();
              void loadRuntime();
              void loadBinding();
              void loadSkillEnv();
              void loadLlmSelection();
              void loadLlmUsage();
            }}
          >
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>

      {msg && <div className="msg msg-ok">{msg}</div>}

      <div className="section-title">
        Agent · {tenant?.companyName || tenantId}
        <span className="mono" style={{ fontSize: 12, color: '#888', marginLeft: 12 }}>
          {tenantId}
        </span>
        {tenant && <StatusBadge status={tenant.status} />}
        <Link
          to={`/customers/${encodeURIComponent(tenantId)}`}
          style={{ fontSize: 12, marginLeft: 16 }}
        >
          客户与 Credits 视图 →
        </Link>
      </div>

      {/* ── 开通信息与状态 ── */}
      {tenantErr ? (
        <div className="msg msg-err">未加载到 Agent 信息：{tenantErr}</div>
      ) : !tenant ? (
        <div className="empty">加载中...</div>
      ) : (
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">开通信息与生命周期</div>
              <div className="panel-sub">
                provisioning-service · {tenant.tenantId}
                {tenant.k8sNamespace ? ` · ${tenant.k8sNamespace}` : ''}
              </div>
            </div>
            <PlanBadge plan={tenant.planTier} />
          </div>
          <div className="panel-body">
            <div className="detail-grid">
              <div className="detail-item">
                <div className="k">所属企业</div>
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
                <div className="v mono" style={{ fontSize: 12 }}>{tenant.k8sNamespace || '-'}</div>
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
                <div className="k">创建 / 更新时间</div>
                <div className="v" style={{ fontSize: 12 }}>
                  {fmtTime(tenant.createdAt)} / {fmtTime(tenant.updatedAt)}
                </div>
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
              <label className="field-label">数据安全</label>
              <button className="btn-secondary" onClick={() => void runBackup('backup')}>
                备份
              </button>
              <button className="btn-secondary" onClick={() => void runBackup('archive')}>
                归档
              </button>
              <button className="btn-secondary" onClick={() => void runRestore()}>
                恢复…
              </button>
              <button className="btn-danger" onClick={() => void destroyTenant()}>
                <IconTrash /> 销毁 Agent
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

      {/* ── 运行状态 ── */}
      <div className="section-title" style={{ fontSize: 14, marginTop: 24 }}>
        运行状态（K8s）
      </div>
      <div className="panel">
        <div className="panel-body">
          {rtBusy && !runtime ? (
            <div className="empty">加载中…</div>
          ) : !runtime || runtime.dryRun ? (
            <div className="empty">dry-run 模式或无运行数据</div>
          ) : (
            <>
              <table>
                <thead>
                  <tr>
                    <th>Deployment</th>
                    <th>副本</th>
                    <th>就绪</th>
                    <th>未就绪</th>
                  </tr>
                </thead>
                <tbody>
                  {runtime.deployments.map((d) => (
                    <tr key={d.name}>
                      <td className="mono" style={{ fontSize: 12 }}>{d.name}</td>
                      <td className="mono">{d.replicas}</td>
                      <td className="mono">{d.readyReplicas}</td>
                      <td className="mono">{d.unavailableReplicas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {runtime.pods.length > 0 && (
                <table style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>Pod</th>
                      <th>阶段</th>
                      <th>容器 / 镜像</th>
                      <th>重启</th>
                      <th>状态</th>
                      <th>启动时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runtime.pods.map((p) =>
                      p.containers.map((c, ci) => (
                        <tr key={`${p.name}-${c.name}`}>
                          {ci === 0 ? (
                            <td rowSpan={p.containers.length} className="mono" style={{ fontSize: 11 }}>
                              {p.name}
                            </td>
                          ) : null}
                          {ci === 0 ? (
                            <td rowSpan={p.containers.length}>
                              <span className={`badge ${p.phase === 'Running' && p.ready ? 'badge-active' : 'badge-warn'}`}>
                                {p.phase}
                              </span>
                            </td>
                          ) : null}
                          <td style={{ fontSize: 11 }}>
                            {c.name} <span className="mono" style={{ color: '#666' }}>{c.image}</span>
                          </td>
                          <td className="mono">{c.restartCount}</td>
                          <td>
                            <span className={`badge ${c.ready ? 'badge-active' : 'badge-failed'}`}>{c.state}</span>
                          </td>
                          <td style={{ fontSize: 11, color: '#777' }}>{fmtTime(c.startedAt)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              )}
            </>
          )}
          <div className="form-row" style={{ marginTop: 12 }}>
            <label className="field-label">扩缩容 / 挂起</label>
            <select
              value={scaleService}
              onChange={(e) => setScaleService(e.target.value as 'dealclaw-agent' | 'nexus-gateway')}
            >
              <option value="dealclaw-agent">dealclaw-agent</option>
              <option value="nexus-gateway">nexus-gateway</option>
            </select>
            <input
              type="number"
              min={0}
              max={10}
              style={{ flex: '0 0 100px' }}
              value={scaleReplicas}
              onChange={(e) => setScaleReplicas(e.target.value)}
              placeholder="副本数"
            />
            <button className="btn-secondary" onClick={() => void applyScale()}>
              应用
            </button>
            <button className="btn-secondary" disabled={rtBusy} onClick={() => void loadRuntime()}>
              <IconRefresh /> {rtBusy ? '查询中…' : '刷新运行状态'}
            </button>
          </div>
          <div className="hint">
            副本数设为 0 即挂起（节省资源，恢复设回 1）。备份/归档/恢复为后台 Job，进度见状态日志。
          </div>
        </div>
      </div>

      {/* ── 模型选择 ── */}
      <div className="section-title" style={{ fontSize: 14, marginTop: 24 }}>
        模型选择
      </div>
      <div className="panel">
        <div className="panel-body">
          {llmSel === null ? (
            <span className="hint" style={{ margin: 0 }}>加载中…</span>
          ) : llmSel.libraryEmpty ? (
            <div className="msg msg-warn" style={{ margin: 0 }}>
              全局供应商库为空：请先到「模型供应商」页添加供应商并设置系统默认模型，再回到此处选择。
            </div>
          ) : (
            <>
              <div className="form-row" style={{ marginBottom: 10 }}>
                <label className="field-label">当前生效</label>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  {llmSel.effectiveModel ? (
                    <span className="badge badge-active mono">{llmSel.effectiveModel}</span>
                  ) : (
                    <span className="badge badge-pending">无默认模型（对话不可用）</span>
                  )}
                  {llmSel.selection ? (
                    <span className="badge badge-warn">本 Agent 指定</span>
                  ) : (
                    <span className="hint" style={{ margin: 0 }}>
                      跟随系统默认（{llmSel.globalDefaultModel || '未设置'}）
                    </span>
                  )}
                  {llmSel.rawSelection && !llmSel.selection && (
                    <span className="badge badge-warn">原选择已失效（供应商被移除），现跟随系统默认</span>
                  )}
                </span>
              </div>
              <div className="form-row">
                <label className="field-label">选择模型</label>
                <select
                  value={llmChoice}
                  onChange={(e) => setLlmChoice(e.target.value)}
                  style={{ flex: '0 1 320px' }}
                >
                  <option value="">跟随系统默认（{llmSel.globalDefaultModel || '未设置'}）</option>
                  {llmLib.flatMap((p) =>
                    p.models.map((m) => (
                      <option key={`${p.name}/${m.id}`} value={`${p.name}/${m.id}`}>
                        {p.name}/{m.id}
                      </option>
                    )),
                  )}
                </select>
                <span className="hint">本 Agent 主对话模型</span>
              </div>
              <div className="form-row">
                <label className="field-label">视觉模型</label>
                <select
                  value={llmImageChoice}
                  onChange={(e) => setLlmImageChoice(e.target.value)}
                  style={{ flex: '0 1 320px' }}
                >
                  <option value="">跟随系统默认（{llmSel.globalImageModel || '未设置'}）</option>
                  {llmLib.flatMap((p) =>
                    p.models
                      .filter((m) => m.vision)
                      .map((m) => (
                        <option key={`${p.name}/${m.id}`} value={`${p.name}/${m.id}`}>
                          {p.name}/{m.id}
                        </option>
                      )),
                  )}
                </select>
                <span className="hint">本 Agent 图片理解模型（view_image 等）</span>
              </div>
              <div className="form-row">
                <label className="field-label">大模型接入</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={llmDirect}
                    onChange={(e) => setLlmDirect(e.target.checked)}
                    disabled={llmBusy}
                  />
                  <span>
                    <b>直连上游（绕过网关代理）</b>
                    <span className="hint" style={{ margin: 0, marginLeft: 6 }}>
                      勾选后把供应商真实 Base URL + API Key 直接写入 OpenClaw，跳过 nexus-gateway 的余额拦截/记账/限流，用于排查网关增值服务是否拖慢回复
                    </span>
                  </span>
                </label>
              </div>
              <div className="form-row" style={{ marginBottom: 0 }}>
                <label className="field-label" />
                <button className="btn-primary" disabled={llmBusy} onClick={() => void saveLlmSelection()}>
                  {llmBusy ? '处理中…' : '保存（滚动重启生效）'}
                </button>
              </div>
              <div className="hint">
                保存后写入该 Agent 的 <span className="mono">tenant-config</span> Secret 并滚动重启，约 1–2 分钟生效
                （模型配置在容器启动时应用，不支持热更新）。供应商与 API Key 在「模型供应商」页集中维护。
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── LLM 用量（近 7 天，网关出口代理记账） ── */}
      <div className="section-title" style={{ fontSize: 14, marginTop: 24 }}>
        LLM 用量（近 7 天）
      </div>
      <div className="panel">
        <div className="panel-body">
          {llmUsage === null ? (
            <span className="hint" style={{ margin: 0 }}>暂无记录（近 7 天没有大模型调用，或记账服务不可达）</span>
          ) : (
            <>
              <div className="form-row" style={{ marginBottom: 10 }}>
                <label className="field-label">合计</label>
                <span style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
                  <span>调用 <b>{llmUsage.totals.calls}</b> 次</span>
                  <span>输入 <b>{llmUsage.totals.inputTokens.toLocaleString()}</b> tokens</span>
                  <span>输出 <b>{llmUsage.totals.outputTokens.toLocaleString()}</b> tokens</span>
                  <span>合计 <b>{llmUsage.totals.totalTokens.toLocaleString()}</b> tokens</span>
                </span>
              </div>
              {llmUsage.byModel.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>供应商 / 模型</th>
                      <th>调用次数</th>
                      <th>输入 tokens</th>
                      <th>输出 tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {llmUsage.byModel.map((m) => (
                      <tr key={`${m.provider}/${m.model}`}>
                        <td className="mono">{m.provider}/{m.model}</td>
                        <td>{m.calls}</td>
                        <td>{m.inputTokens.toLocaleString()}</td>
                        <td>{m.outputTokens.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="hint" style={{ marginBottom: 0 }}>
                数据来自 nexus-gateway LLM 出口代理上报的 <span className="mono">llm_usage_events</span>（shadow 记账，不扣减 credits）。
              </div>
            </>
          )}
        </div>
      </div>

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
                <button className="btn-danger" disabled={fsBusy} onClick={() => void unbindFeishu()}>
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
            绑定后该 Agent 即可在飞书中对话：网关通过长连接接入飞书，无需公网回调。要求应用已启用「机器人」能力并开启「长连接」接收模式。
            绑定时会先向飞书校验凭据，校验通过才生效；同一应用同时只能绑定一个 Agent。
          </div>
        </div>
      </div>

      <FeishuAppScanModal
        open={fsScan}
        onClose={() => setFsScan(false)}
        onCredentials={(appId, appSecret) => {
          setFsAppId(appId);
          setFsAppSecret(appSecret);
          flash(`已扫码获取凭据（${appId}），请确认后点击绑定`);
        }}
      />

      {/* ── Skill 环境变量 ── */}
      <div className="section-title" style={{ fontSize: 14, marginTop: 24 }}>
        Skill 环境变量（.env）
      </div>
      <div className="panel">
        <div className="panel-body">
          <div className="hint" style={{ marginBottom: 10 }}>
            这些 Key 以 <span className="mono">work/mio-api/.env</span> 形式下发到该 Agent
            （每个 Agent 可单独设值，未覆盖的 Key 沿用全局默认，可添加任意 KEY=VALUE）。
            保存后由 Secret 卷自动热更新，<b>通常无需重启，约 1 分钟内生效</b>；首次挂载会滚动重启一次。
            MIO_CDP_SUPPLIER_ID 在此一并管理（存客户档案，修改后 Agent 滚动重启一次生效）。
          </div>

          {skillEnv === null ? (
            <div className="empty">加载中…</div>
          ) : skillEnv.length === 0 ? (
            <div className="empty">暂无配置：在下方添加该 Agent 的专属 Key，或到「运行时配置」页设置全局默认</div>
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
                        <button className="btn-danger btn-sm" disabled={seBusy} onClick={() => void clearMioSupplier()}>
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
              placeholder="该 Agent 的专属值（保存时加密入库）"
            />
            <button className="btn-primary" disabled={seBusy} onClick={() => void saveSkillEnvKey()}>
              {seBusy ? '保存中…' : '保存'}
            </button>
          </div>
          <div className="form-row">
            <label className="field-label" />
            <button className="btn-secondary" disabled={seSyncBusy} onClick={() => void syncSkillEnv()}>
              <IconRefresh /> {seSyncBusy ? '同步中…' : '同步到 Agent'}
            </button>
          </div>
          <div className="hint">
            「同步到 Agent」会重写该 Agent 的 skill-env Secret 并确保已挂载；当推送失败或修改后未生效时可手动触发。
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
              list={`agent-img-tags-${imgService}`}
              value={imgTag}
              onChange={(e) => setImgTag(e.target.value)}
              placeholder="选择或输入镜像 Tag，如 master.e3d43339.12"
            />
            <datalist id={`agent-img-tags-${imgService}`}>
              {serviceReleases.map((r) => (
                <option key={r.id} value={r.tag}>
                  {`${fmtTime(r.createdAt)} · ${r.createdBy || ''}`}
                </option>
              ))}
            </datalist>
            <button className="btn-primary" onClick={() => void updateImage()} disabled={imgBusy}>
              {imgBusy ? '更新中…' : (<><IconBox /> 更新此 Agent 镜像</>)}
            </button>
          </div>
          <div className="hint">
            仅更新当前 Agent（滚动重启该服务的 Deployment）。如需把某个版本推给全部租户，请到
            「镜像版本」页使用「提升发布」。
          </div>
        </div>
      </div>
    </>
  );
}
