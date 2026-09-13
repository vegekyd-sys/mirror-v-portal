import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errMsg } from '../lib/api';
import type {
  CatalogImportReport,
  CatalogModel,
  CatalogProvider,
  CatalogStatus,
  ParamsStatus,
  SnapshotMutationResponse,
  SnapshotPreview,
} from '../lib/modelCatalogTypes';
import { IconRefresh } from './icons';

interface ModelCatalogPanelProps {
  onPushTask: (taskId: string) => void;
}

const STATUS_LABELS: Record<ParamsStatus, string> = {
  complete: '完整',
  incomplete: '不完整',
  fallback: '回退',
  invalid: '无效',
};

function isDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503 && error.code === 'DISABLED';
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ') || '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

function ChangeList({ title, values }: { title: string; values: string[] }) {
  return (
    <div style={{ minWidth: 170 }}>
      <b>{title}</b> <span className="badge">{values.length}</span>
      <div className="hint" style={{ margin: '4px 0 0', wordBreak: 'break-all' }}>
        {values.length > 0 ? values.join('、') : '无'}
      </div>
    </div>
  );
}

/** Read-only P1 catalog preview plus explicit import/publish operations. */
export default function ModelCatalogPanel({ onPushTask }: ModelCatalogPanelProps) {
  const [disabled, setDisabled] = useState(false);
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [preview, setPreview] = useState<SnapshotPreview | null>(null);
  const [report, setReport] = useState<CatalogImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadCatalog = useCallback(async () => {
    try {
      const [nextStatus, providerResult] = await Promise.all([
        api<CatalogStatus>('/v1/admin/model-catalog/status?limit=5'),
        api<{ providers: CatalogProvider[] }>('/v1/admin/model-catalog/providers'),
      ]);
      setStatus(nextStatus);
      setProviders(providerResult.providers ?? []);
      setDisabled(false);
      setError('');
      setSelectedProviderId((current) =>
        current && providerResult.providers.some((provider) => provider.id === current) ? current : '',
      );
    } catch (caught) {
      if (isDisabled(caught)) {
        setDisabled(true);
        setStatus(null);
        setProviders([]);
        setModels([]);
        setError('');
      } else {
        setError(errMsg(caught));
      }
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (!selectedProviderId) {
      setModels([]);
      return;
    }
    let active = true;
    void api<{ models: CatalogModel[] }>(
      `/v1/admin/model-catalog/providers/${encodeURIComponent(selectedProviderId)}/models`,
    ).then((result) => {
      if (active) setModels(result.models ?? []);
    }).catch((caught: unknown) => {
      if (active) setError(errMsg(caught));
    });
    return () => { active = false; };
  }, [selectedProviderId]);

  const runImport = async (dryRun: boolean): Promise<void> => {
    if (!dryRun && !window.confirm('正式导入会把当前 LLM_PROVIDERS 写入结构化 shadow 目录。确认继续？')) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await api<CatalogImportReport>('/v1/admin/model-catalog/import', {
        method: 'POST', body: { dryRun },
      });
      setReport(result);
      setMessage(dryRun ? 'Dry-run 完成，未写入数据。' : '正式导入完成。');
      if (!dryRun) await loadCatalog();
    } catch (caught) {
      if (isDisabled(caught)) {
        setDisabled(true);
        setError('');
      } else {
        setError(errMsg(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  const loadPreview = async (): Promise<void> => {
    setBusy(true);
    setPreview(null);
    try {
      const result = await api<SnapshotPreview>('/v1/admin/model-catalog/snapshot-preview');
      setPreview(result);
      setError('');
    } catch (caught) {
      if (isDisabled(caught)) setDisabled(true);
      else setError(errMsg(caught));
    } finally {
      setBusy(false);
    }
  };

  const publish = async (): Promise<void> => {
    if (!preview) return;
    if (!window.confirm('危险操作：将按当前预览覆盖旧权威 LLM_PROVIDERS，并推送所有租户。确认发布？')) return;
    setBusy(true);
    try {
      const result = await api<SnapshotMutationResponse>('/v1/admin/model-catalog/snapshot-publish', {
        method: 'POST', body: { fingerprint: preview.fingerprint },
      });
      setMessage('结构化目录快照已发布，正在推送租户。');
      setPreview(null);
      onPushTask(result.taskId);
      await loadCatalog();
    } catch (caught) {
      setError(errMsg(caught));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (backupId: string): Promise<void> => {
    if (!window.confirm('危险操作：将用所选备份覆盖当前 LLM_PROVIDERS，并推送所有租户。确认恢复？')) return;
    setBusy(true);
    try {
      const result = await api<SnapshotMutationResponse>('/v1/admin/model-catalog/snapshot-restore', {
        method: 'POST', body: { backupId },
      });
      setMessage('历史快照已恢复，正在推送租户。');
      setPreview(null);
      onPushTask(result.taskId);
      await loadCatalog();
    } catch (caught) {
      setError(errMsg(caught));
    } finally {
      setBusy(false);
    }
  };

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);

  return (
    <div className="form-card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>结构化目录（P1 预览）</span>
        <span className="badge badge-warn">shadow / 非权威</span>
        <button className="btn-secondary btn-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void loadCatalog()}>
          <IconRefresh /> 刷新
        </button>
      </div>
      <div className="hint" style={{ marginBottom: 10 }}>
        此区域用于核对结构化目录；上方 LLM_PROVIDERS 仍是权威编辑入口。页面不会展示 API Key、密文或导入报告原始秘密字段。
      </div>
      {disabled ? (
        <div className="msg msg-warn">Model catalog feature disabled（功能开关未启用），旧权威页面仍可正常使用。</div>
      ) : (
        <>
          {error && <div className="msg msg-err">结构化目录请求失败：{error}</div>}
          {message && <div className="msg msg-ok">{message}</div>}
          {status && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              <span className="badge">Providers {status.totals.providers}</span>
              <span className="badge">Models {status.totals.models}</span>
              {(Object.keys(STATUS_LABELS) as ParamsStatus[]).map((key) => (
                <span key={key} className={`badge ${key === 'invalid' ? 'badge-warn' : key === 'complete' ? 'badge-active' : ''}`}>
                  {STATUS_LABELS[key]} {status.modelStatuses[key]}
                </span>
              ))}
            </div>
          )}
          <div className="form-row">
            <button className="btn-secondary" disabled={busy} onClick={() => void runImport(true)}>Dry-run import</button>
            <button className="btn-danger" disabled={busy} onClick={() => void runImport(false)}>正式 import…</button>
            <span className="hint">正式导入需要二次确认；仅写 shadow 目录，不替代旧权威配置。</span>
          </div>
          {report && (
            <div className={`msg ${report.errorCount > 0 ? 'msg-warn' : 'msg-ok'}`}>
              {report.dryRun ? 'Dry-run' : 'Import'}：总计 {report.totalCount}，成功 {report.succeededCount}，跳过 {report.skippedCount}，错误 {report.errorCount}。
              {report.items.filter((item) => item.status !== 'imported').slice(0, 5).map((item, index) => (
                <div key={`${item.provider}-${item.model ?? ''}-${index}`} className="mono" style={{ fontSize: 11 }}>
                  {item.provider}{item.model ? `/${item.model}` : ''}: {item.status}{item.reason ? ` — ${item.reason}` : ''}
                </div>
              ))}
            </div>
          )}

          <div style={{ fontWeight: 700, margin: '14px 0 6px' }}>最近 import run</div>
          {!status || status.recentImportRuns.length === 0 ? <div className="hint">暂无正式导入记录。</div> : (
            <table>
              <thead><tr><th>开始时间</th><th>状态</th><th>来源</th><th>总计 / 成功 / 跳过 / 错误</th><th>Fingerprint</th></tr></thead>
              <tbody>{status.recentImportRuns.map((run) => (
                <tr key={run.id}>
                  <td>{formatDate(run.startedAt)}</td><td><span className="badge">{run.status}</span></td>
                  <td>{run.sourceKind}</td><td>{run.totalCount} / {run.succeededCount} / {run.skippedCount} / {run.errorCount}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{run.sourceFingerprint.slice(0, 16)}…</td>
                </tr>
              ))}</tbody>
            </table>
          )}

          <div style={{ fontWeight: 700, margin: '14px 0 6px' }}>Providers / Models</div>
          {providers.length === 0 ? <div className="hint">结构化目录暂无 provider，请先执行 import。</div> : (
            <>
              <table>
                <thead><tr><th>Provider</th><th>协议 / 模板</th><th>Base URL</th><th>来源</th><th>运行状态</th></tr></thead>
                <tbody>{providers.map((provider) => (
                  <tr key={provider.id} onClick={() => setSelectedProviderId(provider.id)} style={{ cursor: 'pointer', background: selectedProviderId === provider.id ? '#f4f7ff' : undefined }}>
                    <td><b>{provider.displayName || provider.legacyProviderName}</b><div className="mono" style={{ fontSize: 10 }}>{provider.id}</div></td>
                    <td>{provider.protocol}<div className="hint">{provider.templateKey}</div></td>
                    <td className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{provider.baseUrl}</td>
                    <td>{provider.source}</td><td><span className={`badge ${provider.enabled ? 'badge-active' : 'badge-warn'}`}>{provider.enabled ? 'enabled' : 'disabled'}</span></td>
                  </tr>
                ))}</tbody>
              </table>
              {selectedProvider && (
                <div style={{ marginTop: 8 }}>
                  <div className="hint">{selectedProvider.legacyProviderName} 的模型（仅展示运行参数，不展示凭据）</div>
                  {models.length === 0 ? <div className="hint">无模型。</div> : (
                    <table>
                      <thead><tr><th>Model</th><th>类型</th><th>参数状态</th><th>Runtime</th><th>Effective params（关键字段）</th></tr></thead>
                      <tbody>{models.map((model) => {
                        const params = model.effectiveParams;
                        return (
                          <tr key={model.id}>
                            <td className="mono">{model.modelId}</td><td>{model.modelType}</td>
                            <td><span className={`badge ${model.paramsStatus === 'complete' ? 'badge-active' : model.paramsStatus === 'invalid' ? 'badge-warn' : ''}`}>{model.paramsStatus}</span></td>
                            <td>{model.runtimeEnabled ? 'enabled' : 'disabled'}</td>
                            <td style={{ fontSize: 11 }}>
                              context {formatValue(params.contextWindow)} · input {formatValue(params.maxInputTokens)} · output {formatValue(params.maxOutputTokens)} · modalities {formatValue(params.inputModalities)} → {formatValue(params.outputModalities)} · reasoning {formatValue(params.reasoning)} · vision {formatValue(params.vision)} · tools {formatValue(params.toolCalling)}
                            </td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}

          <div style={{ fontWeight: 700, margin: '14px 0 6px' }}>Snapshot preview / publish</div>
          <div className="form-row">
            <button className="btn-secondary" disabled={busy} onClick={() => void loadPreview()}>生成 snapshot preview</button>
            {preview && <button className="btn-danger" disabled={busy} onClick={() => void publish()}>发布此 fingerprint…</button>}
            <span className="hint">只有预览成功后才可发布；发布会覆盖旧权威配置并推送所有租户。</span>
          </div>
          {preview && (
            <div className="msg msg-warn">
              <div className="mono" style={{ marginBottom: 8 }}>fingerprint: {preview.fingerprint}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <ChangeList title="新增 providers" values={preview.diff.addedProviders} />
                <ChangeList title="移除 providers" values={preview.diff.removedProviders} />
                <ChangeList title="变更 providers" values={preview.diff.changedProviders} />
                <ChangeList title="新增 models" values={preview.diff.addedModels} />
                <ChangeList title="移除 models" values={preview.diff.removedModels} />
                <ChangeList title="变更 models" values={preview.diff.changedModels} />
              </div>
              <div style={{ marginTop: 8 }}><b>引用变化</b></div>
              {preview.diff.changedReferences.length === 0 ? <div className="hint">default / image / compaction / fallback 无变化。</div> : preview.diff.changedReferences.map((change) => (
                <div key={change.reference} className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {change.reference}: {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
                </div>
              ))}
            </div>
          )}

          <div style={{ fontWeight: 700, margin: '14px 0 6px' }}>Snapshot backups / restore</div>
          {!status || status.recentSnapshotBackups.length === 0 ? <div className="hint">暂无可恢复备份。</div> : (
            <table>
              <thead><tr><th>创建时间</th><th>操作者</th><th>来源 fingerprint</th><th>危险操作</th></tr></thead>
              <tbody>{status.recentSnapshotBackups.map((backup) => (
                <tr key={backup.id}>
                  <td>{formatDate(backup.createdAt)}</td><td>{backup.actor || '—'}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{backup.sourceFingerprint.slice(0, 16)}…</td>
                  <td><button className="btn-danger btn-sm" disabled={busy} onClick={() => void restore(backup.id)}>恢复此备份…</button></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
