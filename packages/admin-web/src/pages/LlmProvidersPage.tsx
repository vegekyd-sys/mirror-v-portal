// 旧模型供应商入口 — 冻结后的只读兼容诊断页。
// Catalog 是 Provider / Model / Global Policy / Release 的唯一编辑入口。
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconAlert, IconRefresh } from '../components/icons';
import { api, errMsg } from '../lib/api';
import type { CatalogRelease } from '../lib/modelCatalogTypes';

interface LlmUsageTenant {
  tenantId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  blocked: number;
  synthesized: number;
  lastCallAt: string | null;
}

interface LlmModel {
  id: string;
  reasoning?: boolean;
  vision?: boolean;
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
  imageModel: string | null;
  compactionModel: string | null;
  fallbackModels: string[];
}

const EMPTY_DOC: LlmDoc = {
  providers: [],
  defaultModel: null,
  imageModel: null,
  compactionModel: null,
  fallbackModels: [],
};

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function maskApiKey(value: string): string {
  if (!value) return '未配置';
  if (value.includes('•') || value.includes('*')) return value;
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export default function LlmProvidersPage() {
  const [llmDoc, setLlmDoc] = useState<LlmDoc>(EMPTY_DOC);
  const [currentRelease, setCurrentRelease] = useState<CatalogRelease | null>(null);
  const [usage, setUsage] = useState<LlmUsageTenant[] | null>(null);
  const [usageDays, setUsageDays] = useState<number>(7);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const loadDiagnostics = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [providerResult, releaseResult] = await Promise.all([
        api<{ config: LlmDoc | null }>('/v1/admin/llm-providers'),
        api<CatalogRelease | null>('/v1/admin/model-catalog/releases/current'),
      ]);
      const config = providerResult.config;
      setLlmDoc(config ? {
        providers: config.providers ?? [],
        defaultModel: config.defaultModel ?? null,
        imageModel: config.imageModel ?? null,
        compactionModel: config.compactionModel ?? null,
        fallbackModels: config.fallbackModels ?? [],
      } : EMPTY_DOC);
      setCurrentRelease(releaseResult);
      setError('');
    } catch (loadError) {
      setError(errMsg(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUsage = useCallback(async (): Promise<void> => {
    try {
      const result = await api<{ tenants: LlmUsageTenant[] }>(
        `/v1/admin/llm-usage?days=${usageDays}`,
      );
      setUsage(result.tenants ?? []);
    } catch {
      setUsage([]);
    }
  }, [usageDays]);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">模型供应商 · 只读诊断</div>
          <div className="page-sub">兼容旧链接，仅展示当前运行时投影、Release 与用量信息</div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" disabled={loading} onClick={() => void loadDiagnostics()}>
            <IconRefresh /> 刷新诊断
          </button>
        </div>
      </div>

      <div className="msg msg-warn" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <IconAlert size={16} />
        <span>
          <b>旧入口已冻结。</b> Provider、Model、Global Policy、Release 与 Rollout 只能在模型目录中编辑。
        </span>
        <Link to="/catalog" style={{ marginLeft: 'auto', color: '#b45309', fontWeight: 700, textDecoration: 'underline', whiteSpace: 'nowrap' }}>
          前往模型目录 →
        </Link>
      </div>

      {error && <div className="msg msg-err">{error}</div>}

      <div className="form-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>当前 Release</span>
          {currentRelease ? (
            <>
              <span className="badge badge-active">v{currentRelease.version}</span>
              <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{currentRelease.fingerprint}</span>
            </>
          ) : (
            <span className="badge badge-warn">未发布</span>
          )}
        </div>
        <div className="hint" style={{ margin: 0 }}>
          此处展示已发布 Release 与旧运行时投影的诊断视图，不代表可在本页修改。
        </div>
      </div>

      <div className="form-card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>Provider / Model 运行时投影</span>
          <span className="badge">{llmDoc.providers.length} 个 Provider</span>
          <span className="badge">{llmDoc.providers.reduce((sum, provider) => sum + provider.models.length, 0)} 个 Model</span>
        </div>
        {llmDoc.providers.length === 0 ? (
          <div className="empty">当前运行时投影中没有 Provider。</div>
        ) : (
          <table>
            <thead>
              <tr><th>Provider</th><th>Base URL</th><th>API Key</th><th>Models</th></tr>
            </thead>
            <tbody>
              {llmDoc.providers.map((provider) => (
                <tr key={provider.name}>
                  <td><b>{provider.label || provider.name}</b><div className="mono" style={{ fontSize: 10 }}>{provider.name}</div></td>
                  <td className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{provider.baseUrl}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{maskApiKey(provider.apiKey)}</td>
                  <td>
                    {provider.models.map((model) => (
                      <span key={model.id} className="badge" style={{ marginRight: 4 }}>
                        {model.id}{model.reasoning ? ' · reasoning' : ''}{model.vision ? ' · vision' : ''}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="form-card" style={{ marginTop: 16 }}>
        <div style={{ fontSize: 14, color: '#171c2e', fontWeight: 700, marginBottom: 10 }}>Global Policy 运行时投影</div>
        <div style={{ maxWidth: 720 }}>
          <div className="kv-row"><span>Default Model</span><span className="v mono">{llmDoc.defaultModel || '—'}</span></div>
          <div className="kv-row"><span>Image Model</span><span className="v mono">{llmDoc.imageModel || '—'}</span></div>
          <div className="kv-row"><span>Compaction Model</span><span className="v mono">{llmDoc.compactionModel || '—'}</span></div>
          <div className="kv-row"><span>Fallback Models</span><span className="v mono">{llmDoc.fallbackModels.length > 0 ? llmDoc.fallbackModels.join(' → ') : '—'}</span></div>
        </div>
      </div>

      <div className="form-card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>LLM 用量汇总</span>
          <span className="badge">网关出口代理记账</span>
          <select value={usageDays} onChange={(event) => setUsageDays(Number(event.target.value))} style={{ marginLeft: 'auto', width: 110 }}>
            <option value={1}>近 1 天</option>
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
          </select>
          <button className="btn-secondary btn-sm" onClick={() => void loadUsage()}><IconRefresh /> 刷新</button>
        </div>
        {usage === null ? (
          <div className="hint">加载中…</div>
        ) : usage.length === 0 ? (
          <div className="empty">近 {usageDays} 天没有调用记录，或记账服务暂不可达。</div>
        ) : (
          <table>
            <thead><tr><th>租户</th><th>调用</th><th>输入 tokens</th><th>输出 tokens</th><th>合计</th><th>拦截/合成</th><th>最近调用</th></tr></thead>
            <tbody>
              {usage.map((tenant) => (
                <tr key={tenant.tenantId}>
                  <td className="mono">{tenant.tenantId}</td>
                  <td>{tenant.calls}</td>
                  <td>{formatNumber(tenant.inputTokens)}</td>
                  <td>{formatNumber(tenant.outputTokens)}</td>
                  <td>{formatNumber(tenant.totalTokens)}</td>
                  <td>{tenant.blocked} / {tenant.synthesized}</td>
                  <td style={{ fontSize: 11 }}>{tenant.lastCallAt ? new Date(tenant.lastCallAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
