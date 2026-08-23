// 运行时配置 — migrated from legacy admin-dashboard/public/admin-runtime-configs.html.
// Data: provisioning-service /v1/admin/runtime-configs (+ presets) with the
// tenant scope list from /v1/tenants.
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import type { Tenant } from '../lib/types';
import { IconAlert, IconRefresh, IconSave } from '../components/icons';

interface ConfigItem {
  key: string;
  tenantId?: string | null;
  isSecret?: boolean;
  description?: string | null;
  updatedAt?: string;
  displayValue?: string;
}

interface Preset {
  key: string;
  description?: string;
  isSecret?: boolean;
}

interface PushSummary {
  status?: 'ok' | 'failed' | 'skipped';
  rollout?: string;
  detail?: string;
  hint: string;
}

interface LlmModel {
  id: string;
  reasoning?: boolean;
}

interface LlmProvider {
  name: string;
  label?: string;
  baseUrl: string;
  apiKey: string;
  models: LlmModel[];
}

interface LlmDoc {
  providers: LlmProvider[];
  defaultModel: string | null;
}

export default function RuntimeConfigsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [scope, setScope] = useState('');
  const [items, setItems] = useState<ConfigItem[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [opLogs, setOpLogs] = useState<{ t: string; text: string; err?: boolean }[]>([]);

  const [formKey, setFormKey] = useState('');
  const [formValue, setFormValue] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formSecret, setFormSecret] = useState(true);
  const [saving, setSaving] = useState(false);

  // ── 大模型提供商 ──
  const [llmDoc, setLlmDoc] = useState<LlmDoc>({ providers: [], defaultModel: null });
  const [llmSource, setLlmSource] = useState<'tenant' | 'global' | 'none'>('none');
  const [llmBusy, setLlmBusy] = useState(false);
  const [lpEditing, setLpEditing] = useState<string | null>(null);
  const [lpName, setLpName] = useState('');
  const [lpBaseUrl, setLpBaseUrl] = useState('');
  const [lpApiKey, setLpApiKey] = useState('');
  const [lpModels, setLpModels] = useState('');

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 6000);
  };

  const log = (text: string, err = false) => {
    setOpLogs((prev) => [{ t: new Date().toLocaleTimeString(), text, err }, ...prev]);
  };

  const loadConfigs = useCallback(async (tenantId: string) => {
    try {
      const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
      const r = await api<{ items: ConfigItem[]; keyConfigured?: boolean }>(
        `/v1/admin/runtime-configs${qs}`,
      );
      setItems(r.items || []);
      setKeyConfigured(r.keyConfigured !== false);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    api<{ tenants: Tenant[] }>('/v1/tenants')
      .then((r) => setTenants(r.tenants || []))
      .catch(() => {});
    api<{ presets: Preset[] }>('/v1/admin/runtime-configs/presets')
      .then((r) => setPresets(r.presets || []))
      .catch(() => {});
  }, []);

  const loadLlm = useCallback(async (tenantId: string) => {
    try {
      const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
      const r = await api<{ source: 'tenant' | 'global' | 'none'; config: LlmDoc | null }>(
        `/v1/admin/llm-providers${qs}`,
      );
      setLlmSource(r.source || 'none');
      setLlmDoc(r.config || { providers: [], defaultModel: null });
    } catch {
      setLlmSource('none');
      setLlmDoc({ providers: [], defaultModel: null });
    }
  }, []);

  useEffect(() => {
    void loadConfigs(scope);
    void loadLlm(scope);
  }, [scope, loadConfigs, loadLlm]);

  const save = async () => {
    const key = formKey.trim();
    const value = formValue;
    if (!key || !value) {
      flash('Key 与 Value 为必填');
      return;
    }
    const scopeLabel = scope || '全局默认';
    if (scope && !window.confirm(`确认为租户 ${scope} 设置覆盖值？`)) return;
    setSaving(true);
    try {
      const r = await api<{ push?: PushSummary }>('/v1/admin/runtime-configs', {
        method: 'PUT',
        body: {
          tenantId: scope || null,
          key,
          value,
          isSecret: formSecret,
          description: formDesc.trim() || undefined,
        },
      });
      // 生效时间提示（热生效约 1 分钟 / 首次挂载滚动重启 / 推送失败重试）
      flash(`已保存 ${key}（作用域：${scopeLabel}）。${r.push?.hint || ''}`);
      log(`保存 ${key} @ ${scopeLabel}${r.push?.hint ? ` — ${r.push.hint}` : ''}`);
      setFormValue('');
      await loadConfigs(scope);
    } catch (e) {
      flash(`保存失败：${errMsg(e)}`);
      log(`保存失败 ${key}: ${errMsg(e)}`, true);
    } finally {
      setSaving(false);
    }
  };

  const editValue = async (item: ConfigItem) => {
    const value = window.prompt(
      `为「${item.key}」输入新值（原值已加密，无法回显）：`,
      '',
    );
    if (value === null || value === '') return;
    try {
      const r = await api<{ push?: PushSummary }>('/v1/admin/runtime-configs', {
        method: 'PUT',
        body: { tenantId: scope || null, key: item.key, value },
      });
      flash(`已更新 ${item.key}。${r.push?.hint || ''}`);
      log(`更新 ${item.key} @ ${scope || '全局默认'}${r.push?.hint ? ` — ${r.push.hint}` : ''}`);
      await loadConfigs(scope);
    } catch (e) {
      flash(`更新失败：${errMsg(e)}`);
    }
  };

  const remove = async (item: ConfigItem) => {
    const scopeLabel = scope || '全局默认';
    if (!window.confirm(`确认删除 ${scopeLabel} 作用域下的「${item.key}」？已存在的租户不受影响。`))
      return;
    try {
      const qs = scope ? `?tenantId=${encodeURIComponent(scope)}` : '';
      const r = await api<{ push?: PushSummary }>(
        `/v1/admin/runtime-configs/${encodeURIComponent(item.key)}${qs}`,
        { method: 'DELETE' },
      );
      flash(`已删除 ${item.key}。${r.push?.hint || ''}`);
      log(`删除 ${item.key} @ ${scopeLabel}${r.push?.hint ? ` — ${r.push.hint}` : ''}`);
      await loadConfigs(scope);
    } catch (e) {
      flash(`删除失败：${errMsg(e)}`);
    }
  };

  // ── 大模型提供商：本地增删改 + 整体保存 ──

  const parseModelLines = (text: string): LlmModel[] => {
    const models: LlmModel[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(.+):reasoner$/i);
      if (m) {
        models.push({ id: m[1].trim(), reasoning: true });
      } else {
        models.push({ id: line });
      }
    }
    return models;
  };

  const addOrUpdateProvider = () => {
    const name = lpName.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
      flash('提供商 ID 不合法：小写字母开头，仅小写字母/数字/_/-（最长 32 位）');
      return;
    }
    if (!/^https?:\/\/.+/.test(lpBaseUrl.trim())) {
      flash('Base URL 需以 http(s):// 开头');
      return;
    }
    if (!lpApiKey.trim()) {
      flash('API Key 不能为空');
      return;
    }
    const models = parseModelLines(lpModels);
    if (models.length === 0) {
      flash('至少填写一个模型 ID');
      return;
    }
    if (models.some((m) => !/^[A-Za-z0-9._-]{1,100}$/.test(m.id))) {
      flash('模型 ID 只能含字母/数字/./_/-');
      return;
    }
    const exists = llmDoc.providers.some((p) => p.name === name);
    if (exists && lpEditing !== name) {
      flash(`提供商 ${name} 已存在`);
      return;
    }
    const next: LlmProvider = {
      name,
      baseUrl: lpBaseUrl.trim().replace(/\/+$/, ''),
      apiKey: lpApiKey,
      models,
    };
    const providers = exists
      ? llmDoc.providers.map((p) => (p.name === name ? next : p))
      : [...llmDoc.providers, next];
    // 默认模型若已不在列表中则清空，交由保存前的必选校验兜底
    const defaultModel =
      llmDoc.defaultModel && providers.some((p) => llmDoc.defaultModel!.startsWith(`${p.name}/`))
        ? llmDoc.defaultModel
        : null;
    setLlmDoc({ providers, defaultModel });
    setLpEditing(null);
    setLpName('');
    setLpBaseUrl('');
    setLpApiKey('');
    setLpModels('');
    flash(lpEditing ? `已更新提供商 ${name}（尚未保存，请点「保存提供商配置」）` : `已添加提供商 ${name}（尚未保存，请点「保存提供商配置」）`);
  };

  const editProvider = (p: LlmProvider) => {
    setLpEditing(p.name);
    setLpName(p.name);
    setLpBaseUrl(p.baseUrl);
    setLpApiKey(p.apiKey);
    setLpModels(p.models.map((m) => (m.reasoning ? `${m.id}:reasoner` : m.id)).join('\n'));
  };

  const removeProvider = (name: string) => {
    if (!window.confirm(`确认从列表移除提供商 ${name}？（需保存后生效）`)) return;
    const providers = llmDoc.providers.filter((p) => p.name !== name);
    const defaultModel =
      llmDoc.defaultModel && llmDoc.defaultModel.startsWith(`${name}/`) ? null : llmDoc.defaultModel;
    setLlmDoc({ providers, defaultModel });
    if (lpEditing === name) {
      setLpEditing(null);
      setLpName('');
      setLpBaseUrl('');
      setLpApiKey('');
      setLpModels('');
    }
  };

  const saveLlm = async () => {
    if (llmDoc.providers.length === 0) {
      flash('未配置任何提供商；如需清除请用「清除本作用域覆盖/配置」');
      return;
    }
    if (!llmDoc.defaultModel) {
      flash('请选择默认模型');
      return;
    }
    const scopeLabel = scope || '全局默认';
    if (scope && llmSource !== 'tenant' && !window.confirm(`确认为租户 ${scope} 创建提供商配置覆盖？`)) return;
    setLlmBusy(true);
    try {
      const r = await api<{ push?: PushSummary }>('/v1/admin/llm-providers', {
        method: 'PUT',
        body: { tenantId: scope || null, providers: llmDoc.providers, defaultModel: llmDoc.defaultModel },
      });
      flash(`已保存大模型提供商（${scopeLabel}）。${r.push?.hint || ''}`);
      log(`保存 LLM 提供商 @ ${scopeLabel}${r.push?.hint ? ` — ${r.push.hint}` : ''}`);
      await loadLlm(scope);
    } catch (e) {
      flash(`保存失败：${errMsg(e)}`);
      log(`保存 LLM 提供商失败：${errMsg(e)}`, true);
    } finally {
      setLlmBusy(false);
    }
  };

  const clearLlm = async () => {
    const scopeLabel = scope || '全局默认';
    if (!window.confirm(`确认清除 ${scopeLabel} 的大模型提供商配置？清除后 agent 回退到默认 DeepSeek 配置。`)) return;
    setLlmBusy(true);
    try {
      const qs = scope ? `?tenantId=${encodeURIComponent(scope)}` : '';
      const r = await api<{ push?: PushSummary }>(`/v1/admin/llm-providers${qs}`, { method: 'DELETE' });
      flash(`已清除（${scopeLabel}）。${r.push?.hint || ''}`);
      log(`清除 LLM 提供商 @ ${scopeLabel}${r.push?.hint ? ` — ${r.push.hint}` : ''}`);
      await loadLlm(scope);
    } catch (e) {
      flash(`清除失败：${errMsg(e)}`);
    } finally {
      setLlmBusy(false);
    }
  };

  const fillPreset = (p: Preset) => {
    setFormKey(p.key);
    setFormDesc(p.description || '');
    setFormSecret(p.isSecret !== false);
  };

  const configuredKeys = new Set(items.map((i) => i.key));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">运行时配置</div>
          <div className="page-sub">租户 Pod 的环境变量来源，敏感值加密入库</div>
        </div>
        <div className="page-actions">
          <select
            aria-label="作用域"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">全局默认</option>
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.companyName || t.tenantId}（{t.status}）
              </option>
            ))}
          </select>
          <button className="btn-secondary" onClick={() => void loadConfigs(scope)}>
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>
      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}
      {!keyConfigured && (
        <div className="msg msg-warn" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ marginTop: 2 }}>
            <IconAlert size={15} />
          </span>
          <span>
            RUNTIME_CONFIG_KEY 未在服务端配置：可以查看列表，但无法保存新值，创建租户也会失败。
            请先在 provisioning-service 设置主密钥。
          </span>
        </div>
      )}

      {/* ── 表单 ── */}
      <div className="form-card">
        <div style={{ fontSize: 14, color: '#171c2e', fontWeight: 700, marginBottom: 10 }}>添加 / 更新配置</div>
        {presets.length > 0 && (
          <div className="preset-row">
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`chip ${configuredKeys.has(p.key) ? 'chip-done' : ''}`}
                disabled={configuredKeys.has(p.key)}
                title={p.description}
                onClick={() => fillPreset(p)}
              >
                {p.key}
              </button>
            ))}
          </div>
        )}
        <div className="form-row">
          <label className="field-label">Key</label>
          <input
            type="text"
            className="mono"
            value={formKey}
            onChange={(e) => setFormKey(e.target.value)}
            placeholder="如 DEEPSEEK_API_KEY（合法环境变量名）"
          />
        </div>
        <div className="form-row">
          <label className="field-label">Value</label>
          <input
            type="text"
            className="mono"
            value={formValue}
            onChange={(e) => setFormValue(e.target.value)}
            placeholder="配置值（保存时加密入库）"
          />
        </div>
        <div className="form-row">
          <label className="field-label">说明</label>
          <input
            type="text"
            value={formDesc}
            onChange={(e) => setFormDesc(e.target.value)}
            placeholder="可选"
          />
        </div>
        <div className="form-row">
          <label className="field-label" />
          <label style={{ fontSize: 13, color: '#5b5f75', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={formSecret}
              onChange={(e) => setFormSecret(e.target.checked)}
            />
            敏感值（列表中掩码显示；取消勾选则明文可见）
          </label>
        </div>
        <div className="form-row">
          <label className="field-label" />
          <button className="btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : (<><IconSave /> 保存（当前作用域）</>)}
          </button>
        </div>
      </div>

      {/* ── 大模型提供商 ── */}
      <div className="form-card" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>大模型提供商</span>
          {llmSource === 'tenant' && <span className="badge badge-warn">租户覆盖</span>}
          {llmSource === 'global' && <span className="badge badge-active">全局默认</span>}
          {llmSource === 'none' && <span className="badge">未配置（使用内置 DeepSeek）</span>}
        </div>
        <div className="hint" style={{ marginBottom: 10 }}>
          为 agent 配置大模型提供商（OpenAI 兼容接口，如 DeepSeek / 通义千问 / 智谱 GLM / Kimi / 豆包等）。
          保存后写入租户 <span className="mono">tenant-config</span> Secret 并滚动重启 agent，
          <b>约 1–2 分钟生效</b>（模型配置在容器启动时应用，不支持热更新）。未配置时使用内置 DeepSeek。
        </div>

        {llmDoc.providers.length > 0 && (
          <table style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>提供商 ID</th>
                <th>Base URL</th>
                <th>API Key</th>
                <th>模型</th>
                <th style={{ width: 130 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {llmDoc.providers.map((p) => (
                <tr key={p.name}>
                  <td className="mono">
                    {p.name}
                    {llmDoc.defaultModel?.startsWith(`${p.name}/`) && (
                      <> <span className="badge badge-active">默认</span></>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 11, maxWidth: 260, wordBreak: 'break-all' }}>
                    {p.baseUrl}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {p.apiKey.slice(0, 4)}••••{p.apiKey.slice(-4)}
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {p.models.map((m) => (
                      <span key={m.id} className="badge" style={{ marginRight: 4 }}>
                        {m.id}
                        {m.reasoning ? ' (r)' : ''}
                      </span>
                    ))}
                  </td>
                  <td>
                    <button className="btn-secondary btn-sm" disabled={llmBusy} onClick={() => editProvider(p)}>
                      编辑
                    </button>{' '}
                    <button className="btn-danger btn-sm" disabled={llmBusy} onClick={() => removeProvider(p.name)}>
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="form-row">
          <label className="field-label">{lpEditing ? `编辑（${lpEditing}）` : '添加提供商'}</label>
          <input
            type="text"
            className="mono"
            style={{ flex: '0 1 150px' }}
            value={lpName}
            onChange={(e) => setLpName(e.target.value)}
            placeholder="ID，如 qwen"
            disabled={lpEditing !== null}
          />
          <input
            type="text"
            className="mono"
            style={{ flex: '1 1 260px' }}
            value={lpBaseUrl}
            onChange={(e) => setLpBaseUrl(e.target.value)}
            placeholder="Base URL（OpenAI 兼容），如 https://dashscope.aliyuncs.com/compatible-mode/v1"
          />
          <input
            type="text"
            className="mono"
            style={{ flex: '1 1 180px' }}
            value={lpApiKey}
            onChange={(e) => setLpApiKey(e.target.value)}
            placeholder="API Key"
          />
        </div>
        <div className="form-row">
          <label className="field-label" />
          <input
            type="text"
            className="mono"
            style={{ flex: 1 }}
            value={lpModels}
            onChange={(e) => setLpModels(e.target.value)}
            placeholder="模型列表：一行一个 ID，推理模型加后缀 :reasoner（如 qwq-plus:reasoner）"
          />
          <button className="btn-secondary" disabled={llmBusy} onClick={addOrUpdateProvider}>
            {lpEditing ? '更新到列表' : '加入列表'}
          </button>
        </div>
        <div className="form-row">
          <label className="field-label">默认模型</label>
          <select
            value={llmDoc.defaultModel || ''}
            onChange={(e) => setLlmDoc((d) => ({ ...d, defaultModel: e.target.value || null }))}
            style={{ flex: '0 1 280px' }}
          >
            <option value="">— 选择 agent 主模型 —</option>
            {llmDoc.providers.flatMap((p) =>
              p.models.map((m) => (
                <option key={`${p.name}/${m.id}`} value={`${p.name}/${m.id}`}>
                  {p.name}/{m.id}
                </option>
              )),
            )}
          </select>
          <button className="btn-primary" disabled={llmBusy} onClick={() => void saveLlm()}>
            {llmBusy ? '处理中…' : (<><IconSave /> 保存提供商配置（{scope ? '租户覆盖' : '全局默认'}）</>)}
          </button>
          {(llmSource !== 'none' || llmDoc.providers.length > 0) && (
            <button className="btn-danger" disabled={llmBusy} onClick={() => void clearLlm()}>
              清除本作用域{llmSource === 'tenant' ? '覆盖' : '配置'}
            </button>
          )}
        </div>
      </div>

      {/* ── 列表 ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        配置列表 — {scope ? `租户覆盖 (${scope})` : '全局默认'}
      </div>
      {items.length === 0 ? (
        <div className="panel">
          <div className="empty">
            {scope ? '未覆盖的 key 将使用全局默认值' : '暂无配置，请先添加 DEEPSEEK_API_KEY 等必需项'}
          </div>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>值</th>
                <th>类型</th>
                <th>说明</th>
                <th>更新时间</th>
                <th style={{ width: 150 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.key}>
                  <td className="mono">{i.key}</td>
                  <td className="mono">{i.displayValue ?? '••••••••'}</td>
                  <td>
                    {i.isSecret ? (
                      <span className="badge badge-warn">敏感</span>
                    ) : (
                      <span className="badge badge-active">明文</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>{i.description || '-'}</td>
                  <td style={{ fontSize: 11, color: '#777' }}>
                    {i.updatedAt ? new Date(i.updatedAt).toLocaleString() : '-'}
                  </td>
                  <td>
                    <button className="btn-secondary btn-sm" onClick={() => void editValue(i)}>
                      改值
                    </button>{' '}
                    <button className="btn-danger btn-sm" onClick={() => void remove(i)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">
        保存后自动推送到租户 agent：skill 专用 Key 以 work/mio-api/.env 热下发（免重启，约 1 分钟内生效）；
        DEEPSEEK_API_KEY 等模型 Key 仅在开通/重启时经 tenant-config Secret（envFrom）注入。
        敏感值保存后无法回显，只能通过「改值」覆盖。
      </div>

      <div className="section-title" style={{ fontSize: 14 }}>
        操作日志
      </div>
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
