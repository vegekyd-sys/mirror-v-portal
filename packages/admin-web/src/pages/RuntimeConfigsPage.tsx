// 运行时配置 — migrated from legacy admin-dashboard/public/admin-runtime-configs.html.
// Data: provisioning-service /v1/admin/runtime-configs (+ presets) with the
// tenant scope list from /v1/tenants.
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import type { Tenant } from '../lib/types';

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

  useEffect(() => {
    void loadConfigs(scope);
  }, [scope, loadConfigs]);

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
      await api('/v1/admin/runtime-configs', {
        method: 'PUT',
        body: {
          tenantId: scope || null,
          key,
          value,
          isSecret: formSecret,
          description: formDesc.trim() || undefined,
        },
      });
      flash(`已保存 ${key}（作用域：${scopeLabel}）`);
      log(`保存 ${key} @ ${scopeLabel}`);
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
      await api('/v1/admin/runtime-configs', {
        method: 'PUT',
        body: { tenantId: scope || null, key: item.key, value },
      });
      flash(`已更新 ${item.key}`);
      log(`更新 ${item.key} @ ${scope || '全局默认'}`);
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
      await api(`/v1/admin/runtime-configs/${encodeURIComponent(item.key)}${qs}`, {
        method: 'DELETE',
      });
      flash(`已删除 ${item.key}`);
      log(`删除 ${item.key} @ ${scopeLabel}`);
      await loadConfigs(scope);
    } catch (e) {
      flash(`删除失败：${errMsg(e)}`);
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
      <div className="section-title">运行时配置</div>
      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}
      {!keyConfigured && (
        <div className="msg msg-warn">
          ⚠️ RUNTIME_CONFIG_KEY 未在服务端配置：可以查看列表，但无法保存新值，创建租户也会失败。
          请先在 provisioning-service 设置主密钥。
        </div>
      )}

      <div className="action-bar">
        <label className="field-label" style={{ minWidth: 'auto' }}>
          作用域：
        </label>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">🌐 全局默认</option>
          {tenants.map((t) => (
            <option key={t.tenantId} value={t.tenantId}>
              🏢 {t.companyName || t.tenantId}（{t.status}）
            </option>
          ))}
        </select>
        <button className="btn-secondary" onClick={() => void loadConfigs(scope)}>
          🔄 刷新
        </button>
      </div>

      {/* ── 表单 ── */}
      <div className="form-card">
        <div style={{ fontSize: 14, color: '#fff', marginBottom: 10 }}>➕ 添加 / 更新配置</div>
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
          <label style={{ fontSize: 13, color: '#ccc', display: 'flex', gap: 6, alignItems: 'center' }}>
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
            {saving ? '保存中…' : '💾 保存（当前作用域）'}
          </button>
        </div>
      </div>

      {/* ── 列表 ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        配置列表 — {scope ? `租户覆盖 (${scope})` : '全局默认'}
      </div>
      {items.length === 0 ? (
        <div className="empty">
          {scope ? '未覆盖的 key 将使用全局默认值' : '暂无配置，请先添加 DEEPSEEK_API_KEY 等必需项'}
        </div>
      ) : (
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
                    ✏️ 改值
                  </button>{' '}
                  <button className="btn-danger btn-sm" onClick={() => void remove(i)}>
                    🗑 删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="hint">
        创建租户时，全局默认与租户覆盖合并生成 tenant-config Secret（envFrom 注入）。
        敏感值保存后无法回显，只能通过「改值」覆盖。
      </div>

      <div className="section-title" style={{ fontSize: 14 }}>
        📜 操作日志
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
