// 租户管理 — migrated from legacy admin-dashboard/public/admin-tenants.html.
// Talks directly to provisioning-service via /v1/tenants* (Bearer JWT auth).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { TENANT_STATUSES, type StatusLogEntry, type Tenant } from '../lib/types';
import { PlanBadge, StatusBadge, fmtNum, fmtTime, shortId } from '../components/badges';

interface OpLog {
  t: string;
  text: string;
  err?: boolean;
}

interface Msg {
  kind: 'ok' | 'err';
  text: string;
}

const emptyCreateForm = {
  companyName: '',
  contactEmail: '',
  contactPhone: '',
  planTier: 'starter',
  quotaAgents: '1',
  quotaCreditsMonthly: '1000000',
  botAppId: '',
  botAppSecret: '',
};

export default function TenantsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<Msg | null>(null);
  const [opLogs, setOpLogs] = useState<OpLog[]>([]);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ ...emptyCreateForm });
  const [creating, setCreating] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Tenant | null>(null);
  const [statusLog, setStatusLog] = useState<StatusLogEntry[]>([]);
  const [detailErr, setDetailErr] = useState('');
  const [dStatus, setDStatus] = useState('pending');
  const [dReason, setDReason] = useState('');
  const [dCompany, setDCompany] = useState('');
  const [dEmail, setDEmail] = useState('');

  const msgTimer = useRef<number | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  const showMsg = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setMsg({ kind, text });
    if (msgTimer.current) window.clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => setMsg(null), 8000);
  }, []);

  const log = useCallback((text: string, err = false) => {
    setOpLogs((prev) => [{ t: new Date().toLocaleTimeString(), text, err }, ...prev]);
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ tenants: Tenant[] }>('/v1/tenants');
      setTenants(r.tenants || []);
    } catch (e) {
      showMsg(`列表加载失败：${errMsg(e)}`, 'err');
    } finally {
      setLoading(false);
    }
  }, [showMsg]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (detail) detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [detail]);

  const openDetail = useCallback(async (tenantId: string) => {
    setSelectedId(tenantId);
    setDetailErr('');
    setDetail(null);
    try {
      const r = await api<{ tenant: Tenant; statusLog: StatusLogEntry[] }>(
        `/v1/tenants/${encodeURIComponent(tenantId)}`,
      );
      setDetail(r.tenant);
      setStatusLog(r.statusLog || []);
      setDStatus(r.tenant.status || 'pending');
      setDCompany(r.tenant.companyName || '');
      setDEmail(r.tenant.contactEmail || '');
      setDReason('');
    } catch (e) {
      setDetailErr(errMsg(e));
    }
  }, []);

  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
    setDetailErr('');
  };

  const createTenant = async () => {
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
    if (
      !window.confirm(
        `确认创建租户「${body.companyName || '未命名'}」？将立即开通 K8s 资源与计费账户。`,
      )
    ) {
      return;
    }
    setCreating(true);
    try {
      const r = await api<{ tenant?: Tenant; provisioning?: { dryRun?: boolean } }>(
        '/v1/tenants',
        { method: 'POST', body },
      );
      const tid = r.tenant?.tenantId;
      showMsg(`租户创建成功：${tid}${r.provisioning?.dryRun ? '（dry-run 模式）' : ''}`);
      log(`创建租户 ${tid}`);
      setShowCreate(false);
      setCreateForm({ ...emptyCreateForm });
      await loadList();
      if (tid) void openDetail(tid);
    } catch (e) {
      showMsg(`创建失败：${errMsg(e)}`, 'err');
      log(`创建失败：${errMsg(e)}`, true);
    } finally {
      setCreating(false);
    }
  };

  const changeStatus = async () => {
    if (!selectedId) return;
    const reason = dReason.trim() || '管理员手动变更';
    if (!window.confirm(`确认将租户 ${shortId(selectedId)} 状态改为 ${dStatus}？`)) return;
    try {
      const r = await api<{ fromStatus: string; toStatus: string }>(
        `/v1/tenants/${encodeURIComponent(selectedId)}/status`,
        { method: 'PATCH', body: { status: dStatus, reason } },
      );
      showMsg(`状态已更新：${r.fromStatus} → ${r.toStatus}`);
      log(`状态变更 ${selectedId}: ${r.fromStatus} → ${r.toStatus}`);
      await loadList();
      void openDetail(selectedId);
    } catch (e) {
      showMsg(`状态变更失败：${errMsg(e)}`, 'err');
    }
  };

  const saveProfile = async () => {
    if (!selectedId) return;
    const companyName = dCompany.trim();
    const contactEmail = dEmail.trim();
    if (!companyName && !contactEmail) {
      showMsg('公司名称与邮箱至少填一项', 'err');
      return;
    }
    try {
      await api(`/v1/tenants/${encodeURIComponent(selectedId)}/profile`, {
        method: 'PATCH',
        body: { companyName, contactEmail },
      });
      showMsg('资料已更新');
      log(`资料更新 ${selectedId}`);
      await loadList();
      void openDetail(selectedId);
    } catch (e) {
      showMsg(`资料更新失败：${errMsg(e)}`, 'err');
    }
  };

  const destroyTenant = async (tenantId: string) => {
    const name = tenants.find((t) => t.tenantId === tenantId)?.companyName || tenantId;
    if (
      !window.confirm(
        `确认销毁租户「${name}」？将删除其 namespace 内全部 K8s 资源（租户记录保留为 destroyed）。此操作不可逆。`,
      )
    ) {
      return;
    }
    try {
      await api(`/v1/tenants/${encodeURIComponent(tenantId)}`, { method: 'DELETE' });
      showMsg(`租户已销毁：${tenantId}`);
      log(`销毁租户 ${tenantId}`);
      closeDetail();
      void loadList();
    } catch (e) {
      showMsg(`销毁失败：${errMsg(e)}`, 'err');
    }
  };

  const rows = filter ? tenants.filter((t) => t.status === filter) : tenants;

  return (
    <>
      {msg && <div className={`msg msg-${msg.kind}`}>{msg.text}</div>}

      <div className="action-bar">
        <label className="field-label" style={{ minWidth: 'auto' }}>
          状态筛选：
        </label>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">全部</option>
          {TENANT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="btn-secondary" onClick={() => void loadList()} disabled={loading}>
          🔄 刷新
        </button>
        <button className="btn-primary" onClick={() => setShowCreate((v) => !v)}>
          ➕ 新建租户
        </button>
        <span style={{ fontSize: 12, color: '#666' }}>
          {rows.length} / {tenants.length} 个租户
        </span>
      </div>

      {/* ── 创建租户 ── */}
      {showCreate && (
        <div className="form-card">
          <div className="section-title" style={{ marginTop: 0 }}>
            ➕ 新建租户
          </div>
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
              onChange={(e) =>
                setCreateForm({ ...createForm, quotaCreditsMonthly: e.target.value })
              }
            />
            <span style={{ fontSize: 12, color: '#666' }}>
              （初始余额按套餐模板发放，此处仅为配额上限）
            </span>
          </div>
          <div className="form-row">
            <label className="field-label">飞书 App ID</label>
            <input
              type="text"
              className="mono"
              value={createForm.botAppId}
              onChange={(e) => setCreateForm({ ...createForm, botAppId: e.target.value })}
              placeholder="cli_xxxx（租户自建应用，可留空后补）"
            />
          </div>
          <div className="form-row">
            <label className="field-label">飞书 App Secret</label>
            <input
              type="text"
              className="mono"
              value={createForm.botAppSecret}
              onChange={(e) => setCreateForm({ ...createForm, botAppSecret: e.target.value })}
              placeholder="可留空后补（PUT credentials）"
            />
          </div>
          <div className="form-row">
            <label className="field-label" />
            <button className="btn-primary" onClick={() => void createTenant()} disabled={creating}>
              {creating ? '创建中…' : '🚀 创建并开通（Provision K8s）'}
            </button>
            <button className="btn-secondary" onClick={() => setShowCreate(false)}>
              取消
            </button>
          </div>
          <div className="hint">
            说明：创建即真实开通——写租户记录、建 credits 账户、在独立 namespace 中创建
            Deployment/Secret/PVC。<b>前置条件</b>：运行时配置必须先配好全局默认（如
            DEEPSEEK_API_KEY），否则开通失败（状态停在 provisioning_failed，无自动重试）。
            飞书凭据留空时机器人无法连接飞书，可之后通过 PUT credentials 补齐。
          </div>
        </div>
      )}

      {/* ── 详情 ── */}
      {selectedId && (
        <div ref={detailRef}>
          <div className="section-title">
            📋 租户详情 — <span className="mono">{selectedId}</span>
          </div>
          <div className="form-card">
            {detailErr && <div className="msg msg-err">加载失败：{detailErr}</div>}
            {!detail && !detailErr && <span className="empty">加载中...</span>}
            {detail && (
              <>
                <div className="detail-grid">
                  <div className="detail-item">
                    <div className="k">公司名称</div>
                    <div className="v">{detail.companyName || '-'}</div>
                  </div>
                  <div className="detail-item">
                    <div className="k">状态</div>
                    <div className="v">
                      <StatusBadge status={detail.status} />
                    </div>
                  </div>
                  <div className="detail-item">
                    <div className="k">联系邮箱</div>
                    <div className="v">{detail.contactEmail || '-'}</div>
                  </div>
                  <div className="detail-item">
                    <div className="k">联系电话</div>
                    <div className="v">{detail.contactPhone || '-'}</div>
                  </div>
                  <div className="detail-item">
                    <div className="k">套餐 / Agent 配额</div>
                    <div className="v">
                      <PlanBadge plan={detail.planTier} /> × {detail.quotaAgents ?? '-'}
                    </div>
                  </div>
                  <div className="detail-item">
                    <div className="k">月度积分额度</div>
                    <div className="v">{fmtNum(detail.quotaCreditsMonthly)}</div>
                  </div>
                  <div className="detail-item">
                    <div className="k">K8s Namespace</div>
                    <div className="v">{detail.k8sNamespace || '-'}</div>
                  </div>
                  <div className="detail-item">
                    <div className="k">Credits 账户</div>
                    <div className="v">{detail.creditsAccountId || '-'}</div>
                  </div>
                  <div className="detail-item">
                    <div className="k">创建时间</div>
                    <div className="v">{fmtTime(detail.createdAt)}</div>
                  </div>
                  <div className="detail-item">
                    <div className="k">更新时间</div>
                    <div className="v">{fmtTime(detail.updatedAt)}</div>
                  </div>
                </div>

                <div className="form-row" style={{ marginTop: 14 }}>
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
                  <button
                    className="btn-danger"
                    onClick={() => void destroyTenant(selectedId)}
                  >
                    🗑 销毁租户（deprovision + 软删）
                  </button>
                  <button className="btn-secondary" onClick={closeDetail}>
                    关闭详情
                  </button>
                </div>
              </>
            )}
          </div>
          <div className="section-title" style={{ fontSize: 14 }}>
            状态日志
          </div>
          {statusLog.length === 0 ? (
            <div className="empty">暂无状态变更记录</div>
          ) : (
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
          )}
        </div>
      )}

      {/* ── 列表 ── */}
      <div className="section-title">租户列表</div>
      {rows.length === 0 ? (
        <div className="empty">{loading ? '加载中...' : '暂无租户'}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>公司 / 租户</th>
              <th>Tenant ID</th>
              <th>套餐</th>
              <th>状态</th>
              <th>月度积分额度</th>
              <th>创建时间</th>
              <th style={{ width: 130 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.tenantId}
                className={`clickable ${t.tenantId === selectedId ? 'selected' : ''}`}
                onClick={() => void openDetail(t.tenantId)}
              >
                <td>
                  {t.companyName || <span style={{ color: '#666' }}>未命名</span>}
                  <br />
                  <span style={{ fontSize: 11, color: '#777' }}>{t.contactEmail || ''}</span>
                </td>
                <td className="mono" title={t.tenantId}>
                  {shortId(t.tenantId)}
                </td>
                <td>
                  <PlanBadge plan={t.planTier} />
                </td>
                <td>
                  <StatusBadge status={t.status} />
                </td>
                <td>{fmtNum(t.quotaCreditsMonthly)}</td>
                <td style={{ fontSize: 11, color: '#777' }}>{fmtTime(t.createdAt)}</td>
                <td>
                  <button
                    className="btn-secondary btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void openDetail(t.tenantId);
                    }}
                  >
                    详情
                  </button>{' '}
                  <button
                    className="btn-danger btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void destroyTenant(t.tenantId);
                    }}
                  >
                    销毁
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="hint">
        数据来源：provisioning-service <code>GET /v1/tenants</code>（最多 100 条，按创建时间倒序）。
        点击行查看详情与状态日志。
      </div>

      <div className="section-title">📜 操作日志</div>
      <div className="log-area">
        {opLogs.map((l, i) => (
          <div key={i} className={l.err ? 'log-err' : ''}>
            [{l.t}] {l.text}
          </div>
        ))}
      </div>
    </>
  );
}
