// 模型目录 — 新结构化管理 UI（P2）。
// 覆盖 Provider / Model / Global Policy / Release / Rollout 全部管理操作，
// 替代旧 JSON Editor 风格的 LlmProvidersPage（过渡期保留旧页面）。
//
// Data: provisioning-service /v1/admin/model-catalog/*（P2 写入 API）。
// 所有写操作带 CAS expectedRevision，冲突时提示刷新后重试。
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import type {
  CatalogModel,
  CatalogPreview,
  CatalogProvider,
  CatalogRelease,
  GlobalModelPolicy,
  ImpactManifest,
  RolloutScopeType,
  TenantReleaseStatus,
} from '../lib/modelCatalogTypes';
import Modal from '../components/Modal';
import { IconPlus, IconRefresh, IconEdit, IconTrash } from '../components/icons';
import { shortId } from '../components/badges';

type Tab = 'providers' | 'policy' | 'release' | 'migration';

const TAB_LABELS: Record<Tab, string> = {
  providers: 'Providers / Models',
  policy: 'Global Policy',
  release: 'Release & Rollout',
  migration: '迁移说明',
};

const MODEL_TYPE_OPTIONS = ['chat', 'reasoning', 'vision', 'embedding', 'rerank', 'image', 'audio', 'video'];

const SCOPE_LABELS: Record<RolloutScopeType, string> = {
  full: '全量（所有租户）',
  allowlist: '白名单（指定租户）',
  single: '单租户',
  affected: '仅受影响租户',
  canary: '灰度（Canary）',
};

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

/** Build '<providerName>/<modelId>' reference options from providers + models. */
function buildModelRefs(
  providers: CatalogProvider[],
  modelsByProvider: Record<string, CatalogModel[]>,
): Array<{ value: string; label: string }> {
  const refs: Array<{ value: string; label: string }> = [];
  for (const p of providers) {
    const models = modelsByProvider[p.id] ?? [];
    for (const m of models) {
      const value = `${p.legacyProviderName}/${m.modelId}`;
      refs.push({ value, label: `${p.displayName || p.legacyProviderName} / ${m.modelId}` });
    }
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────
// Provider create / edit modal
// ─────────────────────────────────────────────────────────────

interface ProviderFormState {
  legacyProviderName: string;
  displayName: string;
  templateKey: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

const EMPTY_PROVIDER_FORM: ProviderFormState = {
  legacyProviderName: '',
  displayName: '',
  templateKey: 'openai',
  protocol: 'openai',
  baseUrl: '',
  apiKey: '',
  enabled: true,
};

function ProviderFormModal({
  open,
  mode,
  initial,
  expectedRevision,
  onClose,
  onSubmit,
  busy,
  formError,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  initial: ProviderFormState;
  expectedRevision?: number;
  onClose: () => void;
  onSubmit: (form: ProviderFormState) => void;
  busy: boolean;
  formError: string;
}) {
  const [form, setForm] = useState<ProviderFormState>(initial);

  // Reset form state whenever the modal is opened. We intentionally do NOT
  // depend on `initial` — the parent recreates it each render (e.g. when busy
  // toggles), and re-initializing mid-input would wipe the user's typing.
  useEffect(() => {
    if (open) setForm(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = () => {
    if (!form.legacyProviderName.trim() && mode === 'create') return;
    if (!form.baseUrl.trim()) return;
    if (!/^https?:\/\/.+/.test(form.baseUrl.trim())) return;
    onSubmit({
      ...form,
      legacyProviderName: form.legacyProviderName.trim(),
      displayName: form.displayName.trim(),
      templateKey: form.templateKey.trim() || 'openai',
      protocol: form.protocol.trim() || 'openai',
      baseUrl: form.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: form.apiKey.trim(),
    });
  };

  return (
    <Modal
      title={mode === 'create' ? '新建 Provider' : `编辑 Provider${expectedRevision !== undefined ? ` (r${expectedRevision})` : ''}`}
      open={open}
      onClose={onClose}
      width={560}
    >
      <div>
        <div className="form-row">
          <label className="field-label">Provider ID *</label>
          <input
            type="text"
            className="mono"
            value={form.legacyProviderName}
            onChange={(e) => set('legacyProviderName', e.target.value)}
            placeholder="如 qwen、glm、kimi"
            disabled={mode === 'edit'}
          />
        </div>
        <div className="form-row">
          <label className="field-label">显示名</label>
          <input
            type="text"
            value={form.displayName}
            onChange={(e) => set('displayName', e.target.value)}
            placeholder="通义千问"
          />
        </div>
        <div className="form-row">
          <label className="field-label">Template Key</label>
          <input
            type="text"
            className="mono"
            value={form.templateKey}
            onChange={(e) => set('templateKey', e.target.value)}
            placeholder="openai"
            disabled={mode === 'edit'}
          />
        </div>
        <div className="form-row">
          <label className="field-label">Protocol</label>
          <input
            type="text"
            className="mono"
            value={form.protocol}
            onChange={(e) => set('protocol', e.target.value)}
            placeholder="openai"
            disabled={mode === 'edit'}
          />
        </div>
        <div className="form-row">
          <label className="field-label">Base URL *</label>
          <input
            type="text"
            className="mono"
            value={form.baseUrl}
            onChange={(e) => set('baseUrl', e.target.value)}
            placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
          />
        </div>
        <div className="form-row">
          <label className="field-label">API Key{mode === 'edit' ? '' : ' *'}</label>
          <input
            type="password"
            className="mono"
            value={form.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
            placeholder={mode === 'edit' ? '留空表示不修改（沿用原 Key）' : 'sk-...'}
            autoComplete="off"
          />
        </div>
        {mode === 'edit' && (
          <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
            编辑时 API Key 留空则不修改；输入新值则覆盖。expectedRevision={expectedRevision ?? 'N/A'}
          </div>
        )}
        <div className="form-row">
          <label className="field-label">启用</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            {form.enabled ? 'enabled' : 'disabled'}
          </label>
        </div>
        {formError && <div className="msg msg-err">{formError}</div>}
        <div className="form-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {mode === 'create' ? '创建' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// Model create / edit modal
// ─────────────────────────────────────────────────────────────

interface ModelFormState {
  modelId: string;
  displayName: string;
  modelType: string;
  runtimeEnabled: boolean;
}

const EMPTY_MODEL_FORM: ModelFormState = {
  modelId: '',
  displayName: '',
  modelType: 'chat',
  runtimeEnabled: true,
};

function ModelFormModal({
  open,
  mode,
  initial,
  expectedRevision,
  providerLabel,
  onClose,
  onSubmit,
  busy,
  formError,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  initial: ModelFormState;
  expectedRevision?: number;
  providerLabel: string;
  onClose: () => void;
  onSubmit: (form: ModelFormState) => void;
  busy: boolean;
  formError: string;
}) {
  const [form, setForm] = useState<ModelFormState>(initial);

  // Reset form when modal opens (not on every parent re-render).
  useEffect(() => {
    if (open) setForm(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof ModelFormState>(key: K, value: ModelFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = () => {
    if (!form.modelId.trim()) return;
    onSubmit({
      ...form,
      modelId: form.modelId.trim(),
      displayName: form.displayName.trim(),
      modelType: form.modelType.trim() || 'chat',
    });
  };

  return (
    <Modal
      title={mode === 'create' ? `新建 Model — ${providerLabel}` : `编辑 Model — ${providerLabel}${expectedRevision !== undefined ? ` (r${expectedRevision})` : ''}`}
      open={open}
      onClose={onClose}
      width={500}
    >
      <div>
        <div className="form-row">
          <label className="field-label">Model ID *</label>
          <input
            type="text"
            className="mono"
            value={form.modelId}
            onChange={(e) => set('modelId', e.target.value)}
            placeholder="如 qwen-max-0428"
            disabled={mode === 'edit'}
          />
        </div>
        <div className="form-row">
          <label className="field-label">显示名</label>
          <input
            type="text"
            value={form.displayName}
            onChange={(e) => set('displayName', e.target.value)}
            placeholder="通义千问 Max"
          />
        </div>
        <div className="form-row">
          <label className="field-label">Model Type</label>
          <select value={form.modelType} onChange={(e) => set('modelType', e.target.value)}>
            {MODEL_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="field-label">运行时启用</label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.runtimeEnabled}
              onChange={(e) => set('runtimeEnabled', e.target.checked)}
            />
            {form.runtimeEnabled ? 'enabled' : 'disabled'}
          </label>
        </div>
        {formError && <div className="msg msg-err">{formError}</div>}
        <div className="form-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {mode === 'create' ? '创建' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// Global Policy edit modal
// ─────────────────────────────────────────────────────────────

function PolicyFormModal({
  open,
  initial,
  expectedRevision,
  modelRefs,
  onClose,
  onSubmit,
  busy,
  formError,
}: {
  open: boolean;
  initial: GlobalModelPolicy;
  expectedRevision: number;
  modelRefs: Array<{ value: string; label: string }>;
  onClose: () => void;
  onSubmit: (policy: GlobalModelPolicy) => void;
  busy: boolean;
  formError: string;
}) {
  const [defaultModel, setDefaultModel] = useState(initial.defaultModel || '');
  const [imageModel, setImageModel] = useState(initial.imageModel || '');
  const [compactionModel, setCompactionModel] = useState(initial.compactionModel || '');
  const [fallbackModels, setFallbackModels] = useState<string[]>(initial.fallbackModels);
  const [addRef, setAddRef] = useState('');

  // Reset form when modal opens (not on every parent re-render).
  useEffect(() => {
    if (open) {
      setDefaultModel(initial.defaultModel || '');
      setImageModel(initial.imageModel || '');
      setCompactionModel(initial.compactionModel || '');
      setFallbackModels(initial.fallbackModels);
      setAddRef('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const addFallback = () => {
    if (!addRef || fallbackModels.includes(addRef)) return;
    if (fallbackModels.length >= 5) return;
    setFallbackModels([...fallbackModels, addRef]);
    setAddRef('');
  };

  const removeFallback = (ref: string) => {
    setFallbackModels(fallbackModels.filter((r) => r !== ref));
  };

  const moveFallback = (idx: number, delta: number) => {
    const j = idx + delta;
    if (j < 0 || j >= fallbackModels.length) return;
    const next = [...fallbackModels];
    [next[idx], next[j]] = [next[j], next[idx]];
    setFallbackModels(next);
  };

  const submit = () => {
    onSubmit({
      defaultModel: defaultModel || null,
      imageModel: imageModel || null,
      compactionModel: compactionModel || null,
      fallbackModels,
      revision: expectedRevision,
    });
  };

  return (
    <Modal title={`编辑 Global Policy (r${expectedRevision})`} open={open} onClose={onClose} width={560}>
      <div>
        <div className="form-row">
          <label className="field-label">Default Model</label>
          <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} style={{ flex: 1 }}>
            <option value="">— 未设置 —</option>
            {modelRefs.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="field-label">Image Model</label>
          <select value={imageModel} onChange={(e) => setImageModel(e.target.value)} style={{ flex: 1 }}>
            <option value="">— 未设置 —</option>
            {modelRefs.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="field-label">Compaction Model</label>
          <select value={compactionModel} onChange={(e) => setCompactionModel(e.target.value)} style={{ flex: 1 }}>
            <option value="">— 未设置（跟随主模型）—</option>
            {modelRefs.map((r) => (
              <option key={`cmp-${r.value}`} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
        <div className="form-row" style={{ alignItems: 'flex-start' }}>
          <label className="field-label" style={{ paddingTop: 8 }}>Fallback Models</label>
          <div style={{ flex: 1, minWidth: 0 }}>
            {fallbackModels.length === 0 ? (
              <div className="hint" style={{ margin: 0, marginBottom: 6 }}>未配置备用模型链。</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                {fallbackModels.map((ref, idx) => (
                  <span key={ref} className="badge mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px' }}>
                    {idx + 1}. {ref}
                    <button type="button" style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontSize: 12, opacity: 0.7 }} disabled={idx === 0} onClick={() => moveFallback(idx, -1)} title="上移">↑</button>
                    <button type="button" style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontSize: 12, opacity: 0.7 }} disabled={idx === fallbackModels.length - 1} onClick={() => moveFallback(idx, 1)} title="下移">↓</button>
                    <button type="button" style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontSize: 12, opacity: 0.7 }} onClick={() => removeFallback(ref)} title="移除">✕</button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={addRef} onChange={(e) => setAddRef(e.target.value)} style={{ flex: 1 }} disabled={fallbackModels.length >= 5}>
                <option value="">{fallbackModels.length >= 5 ? '— 已达上限（5 个） —' : '+ 添加备用模型 —'}</option>
                {modelRefs.filter((r) => !fallbackModels.includes(r.value) && r.value !== defaultModel).map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <button className="btn-secondary btn-sm" onClick={addFallback} disabled={!addRef || fallbackModels.length >= 5}>添加</button>
            </div>
          </div>
        </div>
        {formError && <div className="msg msg-err">{formError}</div>}
        <div className="form-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>保存</button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// Scoped Rollout modal
// ─────────────────────────────────────────────────────────────

function RolloutFormModal({
  open,
  onClose,
  onSubmit,
  busy,
  formError,
  releaseId,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (scopeType: RolloutScopeType, tenantIds: string[]) => void;
  busy: boolean;
  formError: string;
  releaseId: string | null;
}) {
  const [scopeType, setScopeType] = useState<RolloutScopeType>('full');
  const [tenantIds, setTenantIds] = useState('');

  useEffect(() => {
    if (open) {
      setScopeType('full');
      setTenantIds('');
    }
  }, [open]);

  const needsTenants = scopeType === 'allowlist' || scopeType === 'single';

  const submit = () => {
    let ids: string[] = [];
    if (needsTenants) {
      ids = tenantIds
        .split(/[\s,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) return;
    }
    onSubmit(scopeType, ids);
  };

  return (
    <Modal title="创建 Scoped Rollout" open={open} onClose={onClose} width={500}>
      <div>
        <div className="hint" style={{ marginBottom: 10 }}>
          目标 Release：<code className="mono">{releaseId ? shortId(releaseId) : '当前 Release'}</code>
        </div>
        <div className="form-row">
          <label className="field-label">Scope Type *</label>
          <select value={scopeType} onChange={(e) => setScopeType(e.target.value as RolloutScopeType)} style={{ flex: 1 }}>
            {(Object.keys(SCOPE_LABELS) as RolloutScopeType[]).map((s) => (
              <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
            ))}
          </select>
        </div>
        {needsTenants && (
          <div className="form-row" style={{ alignItems: 'flex-start' }}>
            <label className="field-label" style={{ paddingTop: 8 }}>Tenant IDs *</label>
            <textarea
              className="mono"
              rows={3}
              style={{ flex: 1, resize: 'vertical', minHeight: 60 }}
              value={tenantIds}
              onChange={(e) => setTenantIds(e.target.value)}
              placeholder={scopeType === 'single' ? '单个 Tenant ID' : '多个 Tenant ID，逗号或换行分隔'}
            />
          </div>
        )}
        <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
          {scopeType === 'full' && '全量推送到所有租户。'}
          {scopeType === 'affected' && '仅推送到受当前 Release 影响的租户。'}
          {scopeType === 'canary' && '灰度推送（仅内部/canary 租户）。'}
          {needsTenants && '仅推送到指定的租户。'}
        </div>
        {formError && <div className="msg msg-err">{formError}</div>}
        <div className="form-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={busy || (needsTenants && !tenantIds.trim())}>创建</button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────

export default function CatalogPage() {
  const [tab, setTab] = useState<Tab>('providers');

  // Shared data
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, CatalogModel[]>>({});
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  // Global policy
  const [policy, setPolicy] = useState<GlobalModelPolicy | null>(null);

  // Release & rollout
  const [releases, setReleases] = useState<CatalogRelease[]>([]);
  const [currentRelease, setCurrentRelease] = useState<CatalogRelease | null>(null);
  const [catalogPreview, setCatalogPreview] = useState<CatalogPreview | null>(null);
  const [impactPreview, setImpactPreview] = useState<ImpactManifest | null>(null);
  const [rolloutStatus, setRolloutStatus] = useState<TenantReleaseStatus[]>([]);

  // Modals
  const [providerModal, setProviderModal] = useState<{ open: boolean; mode: 'create' | 'edit'; provider: CatalogProvider | null }>({ open: false, mode: 'create', provider: null });
  const [modelModal, setModelModal] = useState<{ open: boolean; mode: 'create' | 'edit'; model: CatalogModel | null; providerId: string }>({ open: false, mode: 'create', model: null, providerId: '' });
  const [policyModalOpen, setPolicyModalOpen] = useState(false);
  const [rolloutModalOpen, setRolloutModalOpen] = useState(false);
  const [formError, setFormError] = useState('');

  const flash = (text: string, isErr = false) => {
    if (isErr) {
      setError(text);
      setMsg('');
    } else {
      setMsg(text);
      setError('');
    }
    window.setTimeout(() => {
      setMsg('');
      setError('');
    }, 8000);
  };

  // ── Data loaders ──

  const loadProviders = useCallback(async () => {
    try {
      const r = await api<{ providers: CatalogProvider[] }>('/v1/admin/model-catalog/providers');
      setProviders(r.providers ?? []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  const loadModelsForProvider = useCallback(async (providerId: string) => {
    try {
      const r = await api<{ models: CatalogModel[] }>(
        `/v1/admin/model-catalog/providers/${encodeURIComponent(providerId)}/models`,
      );
      setModelsByProvider((prev) => ({ ...prev, [providerId]: r.models ?? [] }));
    } catch (e) {
      flash(errMsg(e), true);
    }
  }, []);

  const loadPolicy = useCallback(async () => {
    try {
      const r = await api<GlobalModelPolicy>('/v1/admin/model-catalog/global-policy');
      setPolicy(r);
    } catch (e) {
      // Policy may not exist yet; don't block the page.
      if (e instanceof Error && !e.message.includes('404')) {
        flash(errMsg(e), true);
      }
    }
  }, []);

  const loadReleases = useCallback(async () => {
    try {
      const r = await api<{ releases: CatalogRelease[] }>('/v1/admin/model-catalog/releases');
      setReleases(r.releases ?? []);
    } catch (e) {
      flash(errMsg(e), true);
    }
  }, []);

  const loadCurrentRelease = useCallback(async () => {
    try {
      const r = await api<CatalogRelease | null>('/v1/admin/model-catalog/releases/current');
      setCurrentRelease(r);
    } catch {
      setCurrentRelease(null);
    }
  }, []);

  const loadRolloutStatus = useCallback(async () => {
    try {
      const r = await api<{ tenants: TenantReleaseStatus[] }>('/v1/admin/model-catalog/rollout/status');
      setRolloutStatus(r.tenants ?? []);
    } catch {
      setRolloutStatus([]);
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      loadProviders(),
      loadPolicy(),
      loadReleases(),
      loadCurrentRelease(),
      loadRolloutStatus(),
    ]);
    setLoading(false);
  }, [loadProviders, loadPolicy, loadReleases, loadCurrentRelease, loadRolloutStatus]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Load models for expanded provider
  useEffect(() => {
    if (expandedProviderId && !modelsByProvider[expandedProviderId]) {
      void loadModelsForProvider(expandedProviderId);
    }
  }, [expandedProviderId, modelsByProvider, loadModelsForProvider]);

  // ── Provider CRUD ──

  const openCreateProvider = () => {
    setFormError('');
    setProviderModal({ open: true, mode: 'create', provider: null });
  };

  const openEditProvider = (p: CatalogProvider) => {
    setFormError('');
    setProviderModal({ open: true, mode: 'edit', provider: p });
  };

  const submitProvider = async (form: ProviderFormState) => {
    setBusy(true);
    setFormError('');
    try {
      if (providerModal.mode === 'create') {
        await api('/v1/admin/model-catalog/providers', {
          method: 'POST',
          body: {
            legacyProviderName: form.legacyProviderName,
            displayName: form.displayName || undefined,
            templateKey: form.templateKey,
            protocol: form.protocol,
            baseUrl: form.baseUrl,
            apiKey: form.apiKey || undefined,
            enabled: form.enabled,
          },
        });
        flash(`Provider ${form.legacyProviderName} 已创建`);
      } else if (providerModal.provider) {
        const body: Record<string, unknown> = {
          displayName: form.displayName || undefined,
          baseUrl: form.baseUrl,
          enabled: form.enabled,
          expectedRevision: providerModal.provider.revision ?? 0,
        };
        if (form.apiKey) body.apiKey = form.apiKey;
        await api(`/v1/admin/model-catalog/providers/${encodeURIComponent(providerModal.provider.id)}`, {
          method: 'PATCH',
          body,
        });
        flash(`Provider ${providerModal.provider.legacyProviderName} 已更新`);
      }
      setProviderModal({ open: false, mode: 'create', provider: null });
      await loadProviders();
    } catch (e) {
      setFormError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const disableProvider = async (p: CatalogProvider) => {
    if (!window.confirm(`确认停用 Provider ${p.displayName || p.legacyProviderName}？停用后相关模型将不可用。`)) return;
    setBusy(true);
    try {
      await api(`/v1/admin/model-catalog/providers/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      flash(`Provider ${p.legacyProviderName} 已停用`);
      await loadProviders();
    } catch (e) {
      flash(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  // ── Model CRUD ──

  const openCreateModel = (providerId: string) => {
    setFormError('');
    setModelModal({ open: true, mode: 'create', model: null, providerId });
  };

  const openEditModel = (model: CatalogModel, providerId: string) => {
    setFormError('');
    setModelModal({ open: true, mode: 'edit', model, providerId });
  };

  const submitModel = async (form: ModelFormState) => {
    setBusy(true);
    setFormError('');
    try {
      if (modelModal.mode === 'create') {
        await api(`/v1/admin/model-catalog/providers/${encodeURIComponent(modelModal.providerId)}/models`, {
          method: 'POST',
          body: {
            modelId: form.modelId,
            displayName: form.displayName || undefined,
            modelType: form.modelType,
            runtimeEnabled: form.runtimeEnabled,
          },
        });
        flash(`Model ${form.modelId} 已创建`);
      } else if (modelModal.model) {
        await api(`/v1/admin/model-catalog/models/${encodeURIComponent(modelModal.model.id)}`, {
          method: 'PATCH',
          body: {
            displayName: form.displayName || undefined,
            runtimeEnabled: form.runtimeEnabled,
            expectedRevision: modelModal.model.revision ?? 0,
          },
        });
        flash(`Model ${modelModal.model.modelId} 已更新`);
      }
      setModelModal({ open: false, mode: 'create', model: null, providerId: '' });
      if (modelModal.providerId) {
        await loadModelsForProvider(modelModal.providerId);
      }
    } catch (e) {
      setFormError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const disableModel = async (model: CatalogModel, providerId: string) => {
    if (!window.confirm(`确认停用 Model ${model.modelId}？停用后该模型将不可用。`)) return;
    setBusy(true);
    try {
      await api(`/v1/admin/model-catalog/models/${encodeURIComponent(model.id)}`, { method: 'DELETE' });
      flash(`Model ${model.modelId} 已停用`);
      await loadModelsForProvider(providerId);
    } catch (e) {
      flash(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  // ── Global Policy ──

  const submitPolicy = async (next: GlobalModelPolicy) => {
    setBusy(true);
    setFormError('');
    try {
      const r = await api<GlobalModelPolicy>('/v1/admin/model-catalog/global-policy', {
        method: 'PUT',
        body: {
          defaultModel: next.defaultModel,
          imageModel: next.imageModel,
          compactionModel: next.compactionModel,
          fallbackModels: next.fallbackModels,
          expectedRevision: next.revision,
        },
      });
      setPolicy(r);
      setPolicyModalOpen(false);
      flash('Global Policy 已更新');
    } catch (e) {
      setFormError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // ── Release & Rollout ──

  const loadCatalogPreview = async () => {
    setBusy(true);
    setCatalogPreview(null);
    try {
      const r = await api<CatalogPreview>('/v1/admin/model-catalog/catalog-preview');
      setCatalogPreview(r);
      flash('Catalog preview 已生成');
    } catch (e) {
      flash(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const loadImpactPreview = async () => {
    setBusy(true);
    setImpactPreview(null);
    try {
      const r = await api<ImpactManifest>('/v1/admin/model-catalog/rollout/impact-preview');
      setImpactPreview(r);
      flash('影响清单已生成');
    } catch (e) {
      flash(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const publishSnapshot = async () => {
    if (!window.confirm('危险操作：将发布当前 Catalog 快照并创建新 Release。确认继续？')) return;
    setBusy(true);
    try {
      await api('/v1/admin/model-catalog/snapshot-publish', { method: 'POST' });
      flash('Snapshot 已发布，新 Release 已创建');
      await Promise.all([loadReleases(), loadCurrentRelease(), loadRolloutStatus()]);
    } catch (e) {
      flash(errMsg(e), true);
    } finally {
      setBusy(false);
    }
  };

  const submitRollout = async (scopeType: RolloutScopeType, tenantIds: string[]) => {
    setBusy(true);
    setFormError('');
    try {
      const body: Record<string, unknown> = { scopeType };
      if (tenantIds.length > 0) body.tenantIds = tenantIds;
      await api('/v1/admin/model-catalog/rollout', { method: 'POST', body });
      setRolloutModalOpen(false);
      flash(`Scoped Rollout (${SCOPE_LABELS[scopeType]}) 已创建`);
      await loadRolloutStatus();
    } catch (e) {
      setFormError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // ── Derived data ──

  const modelRefs = buildModelRefs(providers, modelsByProvider);

  const providerFormInitial: ProviderFormState = providerModal.provider
    ? {
        legacyProviderName: providerModal.provider.legacyProviderName,
        displayName: providerModal.provider.displayName || '',
        templateKey: providerModal.provider.templateKey,
        protocol: providerModal.provider.protocol,
        baseUrl: providerModal.provider.baseUrl,
        apiKey: '',
        enabled: providerModal.provider.enabled,
      }
    : EMPTY_PROVIDER_FORM;

  const modelFormInitial: ModelFormState = modelModal.model
    ? {
        modelId: modelModal.model.modelId,
        displayName: modelModal.model.displayName || '',
        modelType: modelModal.model.modelType,
        runtimeEnabled: modelModal.model.runtimeEnabled,
      }
    : EMPTY_MODEL_FORM;

  const policyInitial: GlobalModelPolicy = policy ?? {
    defaultModel: null,
    imageModel: null,
    compactionModel: null,
    fallbackModels: [],
    revision: 0,
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">模型目录</div>
          <div className="page-sub">
            结构化管理 Provider / Model / Policy / Release / Rollout，替代旧 JSON Editor
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => void loadAll()} disabled={loading}>
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>

      {loading && <div className="page-loading">加载中…</div>}
      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}

      {/* ── Tabs ── */}
      <div className="tabs">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* ── Tab 1: Providers ── */}
      {tab === 'providers' && (
        <div className="form-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>Providers</span>
            <span className="badge">{providers.length} 个</span>
            <button className="btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={openCreateProvider} disabled={busy}>
              <IconPlus /> 新建 Provider
            </button>
          </div>

          {providers.length === 0 ? (
            <div className="empty">暂无 Provider，点击「新建 Provider」创建</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Template</th>
                  <th>Base URL</th>
                  <th>Enabled</th>
                  <th>API Key</th>
                  <th>Rev</th>
                  <th style={{ width: 200 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <Fragment key={p.id}>
                    <tr>
                      <td>
                        <b>{p.displayName || p.legacyProviderName}</b>
                        <div className="mono" style={{ fontSize: 10 }}>{p.legacyProviderName}</div>
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>{p.templateKey}</td>
                      <td className="mono" style={{ fontSize: 11, wordBreak: 'break-all', maxWidth: 200 }}>{p.baseUrl}</td>
                      <td><span className={`badge ${p.enabled ? 'badge-active' : 'badge-dead'}`}>{p.enabled ? 'enabled' : 'disabled'}</span></td>
                      <td><span className={`badge ${p.hasApiKey ? 'badge-active' : 'badge-warn'}`}>{p.hasApiKey ? '已配置' : '未配置'}</span></td>
                      <td className="mono" style={{ fontSize: 11 }}>{p.revision ?? '—'}</td>
                      <td>
                        <button className="btn-secondary btn-sm" disabled={busy} onClick={() => openEditProvider(p)}>
                          <IconEdit /> 编辑
                        </button>{' '}
                        <button className="btn-secondary btn-sm" disabled={busy} onClick={() => setExpandedProviderId(expandedProviderId === p.id ? null : p.id)}>
                          Models
                        </button>{' '}
                        <button className="btn-danger btn-sm" disabled={busy} onClick={() => void disableProvider(p)}>
                          <IconTrash /> 停用
                        </button>
                      </td>
                    </tr>
                    {expandedProviderId === p.id && (
                      <tr key={`${p.id}-models`}>
                        <td colSpan={7} style={{ background: '#f7faff', padding: '12px 16px' }}>
                          <ProviderModelsSection
                            provider={p}
                            models={modelsByProvider[p.id] ?? []}
                            loading={!modelsByProvider[p.id]}
                            onCreate={() => openCreateModel(p.id)}
                            onEdit={(m) => openEditModel(m, p.id)}
                            onDisable={(m) => void disableModel(m, p.id)}
                            busy={busy}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Tab 2: Global Policy ── */}
      {tab === 'policy' && (
        <div className="form-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>Global Model Policy</span>
            {policy && <span className="badge">revision {policy.revision}</span>}
            <button className="btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => { setFormError(''); setPolicyModalOpen(true); }} disabled={busy || !policy}>
              <IconEdit /> 编辑
            </button>
          </div>
          {!policy ? (
            <div className="empty">Global Policy 尚未初始化，请先创建 Provider 和 Model。</div>
          ) : (
            <div style={{ maxWidth: 600 }}>
              <div className="kv-row"><span>Default Model</span><span className="v mono">{policy.defaultModel || '—'}</span></div>
              <div className="kv-row"><span>Image Model</span><span className="v mono">{policy.imageModel || '—'}</span></div>
              <div className="kv-row"><span>Compaction Model</span><span className="v mono">{policy.compactionModel || '—'}</span></div>
              <div className="kv-row"><span>Fallback Models</span><span className="v mono">{policy.fallbackModels.length > 0 ? policy.fallbackModels.join(' → ') : '—'}</span></div>
            </div>
          )}
        </div>
      )}

      {/* ── Tab 3: Release & Rollout ── */}
      {tab === 'release' && (
        <>
          {/* Preview actions */}
          <div className="form-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>Release & Rollout</span>
              {currentRelease && (
                <span className="badge badge-active" title={currentRelease.id}>
                  当前 Release v{currentRelease.version} · {shortId(currentRelease.fingerprint)}
                </span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void loadCatalogPreview()}>Catalog Preview</button>
                <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void loadImpactPreview()}>Impact Preview</button>
                <button className="btn-danger btn-sm" disabled={busy} onClick={() => void publishSnapshot()}>Publish</button>
                <button className="btn-primary btn-sm" disabled={busy} onClick={() => { setFormError(''); setRolloutModalOpen(true); }}>Scoped Rollout</button>
              </div>
            </div>

            {/* Catalog preview */}
            {catalogPreview && (
              <div className="msg msg-warn" style={{ marginBottom: 12 }}>
                <div className="mono" style={{ marginBottom: 6 }}>fingerprint: {catalogPreview.fingerprint}</div>
                <div style={{ fontSize: 12 }}>
                  Providers: {catalogPreview.providers.length} ·
                  Models: {catalogPreview.providers.reduce((sum, p) => sum + p.models.length, 0)} ·
                  Default: {catalogPreview.policy.defaultModel || '—'}
                </div>
              </div>
            )}

            {/* Impact preview */}
            {impactPreview && (
              <div className="msg msg-warn" style={{ marginBottom: 12 }}>
                <div className="mono" style={{ marginBottom: 6 }}>fingerprint: {impactPreview.fingerprint}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                  <span className="badge">总租户 {impactPreview.totalTenants}</span>
                  <span className="badge badge-warn">受影响 {impactPreview.affectedTenants}</span>
                  <span className="badge badge-active">未受影响 {impactPreview.unaffectedTenants}</span>
                  <span className="badge badge-dead">已锁定 {impactPreview.pinnedTenants}</span>
                </div>
                {impactPreview.entries.length > 0 && (
                  <table style={{ fontSize: 12 }}>
                    <thead>
                      <tr><th>Tenant</th><th>受影响</th><th>原因</th><th>Agent 重启</th><th>网关重启</th><th>Delivery</th></tr>
                    </thead>
                    <tbody>
                      {impactPreview.entries.slice(0, 50).map((e) => (
                        <tr key={e.tenantId}>
                          <td className="mono" style={{ fontSize: 11 }}>{shortId(e.tenantId)}{e.tenantName ? ` (${e.tenantName})` : ''}</td>
                          <td>{e.affected ? <span className="badge badge-warn">是</span> : <span className="badge badge-active">否</span>}</td>
                          <td style={{ fontSize: 11 }}>{e.affectedReasons.join(', ') || '—'}</td>
                          <td>{e.agentRestart ? '✓' : '—'}</td>
                          <td>{e.gatewayRestart ? '✓' : '—'}</td>
                          <td>{e.deliveryStatus || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          {/* Release history */}
          <div className="form-card" style={{ marginTop: 16 }}>
            <div style={{ fontSize: 14, color: '#171c2e', fontWeight: 700, marginBottom: 10 }}>Release 历史</div>
            {releases.length === 0 ? (
              <div className="empty">暂无 Release 记录</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Version</th><th>Fingerprint</th><th>Actor</th><th>Status</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {releases.map((r) => (
                    <tr key={r.id}>
                      <td><span className="badge">v{r.version}</span></td>
                      <td className="mono" style={{ fontSize: 11 }}>{shortId(r.fingerprint)}</td>
                      <td style={{ fontSize: 12 }}>{r.actor || '—'}<div className="hint" style={{ margin: 0, fontSize: 10 }}>{r.actorType}</div></td>
                      <td><span className={`badge ${r.status === 'active' ? 'badge-active' : r.status === 'superseded' ? 'badge-dead' : 'badge'}`}>{r.status}</span></td>
                      <td style={{ fontSize: 11 }}>{formatDate(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Rollout status */}
          <div className="form-card" style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>Rollout 状态</span>
              <button className="btn-secondary btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void loadRolloutStatus()}>
                <IconRefresh /> 刷新
              </button>
            </div>
            {rolloutStatus.length === 0 ? (
              <div className="empty">暂无租户 Release 状态</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Tenant</th><th>Desired Release</th><th>Applied Release</th><th>Delivery</th><th>Attempts</th><th>Updated</th></tr>
                </thead>
                <tbody>
                  {rolloutStatus.map((t) => (
                    <tr key={t.tenantId}>
                      <td className="mono" style={{ fontSize: 11 }}>{shortId(t.tenantId)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{t.desiredReleaseId ? shortId(t.desiredReleaseId) : '—'}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{t.appliedReleaseId ? shortId(t.appliedReleaseId) : '—'}</td>
                      <td>
                        {t.deliveryStatus ? (
                          <span className={`badge ${t.deliveryStatus === 'delivered' ? 'badge-active' : t.deliveryStatus === 'failed' ? 'badge-failed' : 'badge-pending'}`}>{t.deliveryStatus}</span>
                        ) : '—'}
                      </td>
                      <td>{t.attempts}</td>
                      <td style={{ fontSize: 11 }}>{formatDate(t.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── Tab 4: Migration ── */}
      {tab === 'migration' && (
        <div className="form-card">
          <div style={{ fontSize: 14, color: '#171c2e', fontWeight: 700, marginBottom: 10 }}>迁移说明</div>
          <div className="msg msg-warn" style={{ marginBottom: 12 }}>
            此页面将替代旧供应商管理页面（<Link to="/llm-providers" style={{ color: '#b45309', textDecoration: 'underline' }}>模型供应商</Link>）。
            过渡期内两个页面并存，旧页面顶部已添加迁移横幅。完成迁移后旧页面将被移除。
          </div>
          <div className="hint">
            <b>新管理 UI 优势：</b>
            <ul style={{ margin: '6px 0 0 18px', lineHeight: 1.9 }}>
              <li>结构化 Provider/Model 管理，不再依赖 JSON 编辑</li>
              <li>CAS 乐观并发控制，避免多人编辑冲突</li>
              <li>Immutable Release 历史，支持回滚</li>
              <li>Scoped Rollout，按租户/受影响范围灰度发布</li>
              <li>影响清单预览，发布前查看受影响租户</li>
            </ul>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      <ProviderFormModal
        open={providerModal.open}
        mode={providerModal.mode}
        initial={providerFormInitial}
        expectedRevision={providerModal.provider?.revision}
        onClose={() => setProviderModal({ open: false, mode: 'create', provider: null })}
        onSubmit={submitProvider}
        busy={busy}
        formError={formError}
      />

      <ModelFormModal
        open={modelModal.open}
        mode={modelModal.mode}
        initial={modelFormInitial}
        expectedRevision={modelModal.model?.revision}
        providerLabel={providers.find((p) => p.id === modelModal.providerId)?.displayName || providers.find((p) => p.id === modelModal.providerId)?.legacyProviderName || modelModal.providerId}
        onClose={() => setModelModal({ open: false, mode: 'create', model: null, providerId: '' })}
        onSubmit={submitModel}
        busy={busy}
        formError={formError}
      />

      {policy && (
        <PolicyFormModal
          open={policyModalOpen}
          initial={policyInitial}
          expectedRevision={policy.revision}
          modelRefs={modelRefs}
          onClose={() => setPolicyModalOpen(false)}
          onSubmit={submitPolicy}
          busy={busy}
          formError={formError}
        />
      )}

      <RolloutFormModal
        open={rolloutModalOpen}
        onClose={() => setRolloutModalOpen(false)}
        onSubmit={submitRollout}
        busy={busy}
        formError={formError}
        releaseId={currentRelease?.id ?? null}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// ProviderModelsSection — inline expandable model list
// ─────────────────────────────────────────────────────────────

function ProviderModelsSection({
  provider,
  models,
  loading,
  onCreate,
  onEdit,
  onDisable,
  busy,
}: {
  provider: CatalogProvider;
  models: CatalogModel[];
  loading: boolean;
  onCreate: () => void;
  onEdit: (m: CatalogModel) => void;
  onDisable: (m: CatalogModel) => void;
  busy: boolean;
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{provider.displayName || provider.legacyProviderName} 的模型</span>
        <span className="badge">{models.length}</span>
        <button className="btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={onCreate} disabled={busy}>
          <IconPlus /> 新建 Model
        </button>
      </div>
      {loading ? (
        <div className="hint">加载中…</div>
      ) : models.length === 0 ? (
        <div className="empty">暂无 Model，点击「新建 Model」创建</div>
      ) : (
        <table>
          <thead>
            <tr><th>Model ID</th><th>Display Name</th><th>Type</th><th>Runtime</th><th>Params</th><th>Rev</th><th style={{ width: 140 }}>操作</th></tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td className="mono" style={{ fontSize: 11 }}>{m.modelId}</td>
                <td style={{ fontSize: 12 }}>{m.displayName || '—'}</td>
                <td><span className="badge">{m.modelType}</span></td>
                <td><span className={`badge ${m.runtimeEnabled ? 'badge-active' : 'badge-dead'}`}>{m.runtimeEnabled ? 'enabled' : 'disabled'}</span></td>
                <td><span className={`badge ${m.paramsStatus === 'complete' ? 'badge-active' : m.paramsStatus === 'invalid' ? 'badge-failed' : 'badge-warn'}`}>{m.paramsStatus}</span></td>
                <td className="mono" style={{ fontSize: 11 }}>{m.revision ?? '—'}</td>
                <td>
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => onEdit(m)}>
                    <IconEdit /> 编辑
                  </button>{' '}
                  <button className="btn-danger btn-sm" disabled={busy} onClick={() => onDisable(m)}>
                    <IconTrash /> 停用
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
