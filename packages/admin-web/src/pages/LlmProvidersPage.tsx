// 模型供应商 — 集中管理全局大模型供应商库。
// Data: provisioning-service /v1/admin/llm-providers（全局库，解密回显编辑）。
// 租户不做库覆盖，只在 Agent 详情页从库中选择模型（LLM_MODEL_SELECTION）。
// 附「LLM 用量汇总」卡片：/v1/admin/llm-usage（credits-ledger 聚合，
// nexus-gateway LLM 出口代理上报的 token 记账）。
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { IconAlert, IconRefresh, IconSave } from '../components/icons';

interface PushSummary {
  status?: 'ok' | 'failed' | 'skipped';
  hint: string;
}

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

export default function LlmProvidersPage() {
  const [llmDoc, setLlmDoc] = useState<LlmDoc>({ providers: [], defaultModel: null });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [msgErr, setMsgErr] = useState(false);
  const [opLogs, setOpLogs] = useState<{ t: string; text: string; err?: boolean }[]>([]);
  const [lpEditing, setLpEditing] = useState<string | null>(null);
  const [lpName, setLpName] = useState('');
  const [lpBaseUrl, setLpBaseUrl] = useState('');
  const [lpApiKey, setLpApiKey] = useState('');
  const [lpModels, setLpModels] = useState('');
  const [lpMsg, setLpMsg] = useState('');
  const [lpMsgErr, setLpMsgErr] = useState(false);
  const [usage, setUsage] = useState<LlmUsageTenant[] | null>(null);
  const [usageDays, setUsageDays] = useState(7);

  const fmtNum = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);

  const flash = (text: string, isErr = false) => {
    setMsg(text);
    setMsgErr(isErr);
    window.setTimeout(() => {
      setMsg('');
      setMsgErr(false);
    }, 8000);
  };

  const flashLp = (text: string, isErr = false) => {
    setLpMsg(text);
    setLpMsgErr(isErr);
    window.setTimeout(() => {
      setLpMsg('');
      setLpMsgErr(false);
    }, 6000);
  };

  const log = (text: string, err = false) => {
    setOpLogs((prev) => [{ t: new Date().toLocaleTimeString(), text, err }, ...prev]);
  };

  const load = useCallback(async () => {
    try {
      const r = await api<{ config: LlmDoc | null }>('/v1/admin/llm-providers');
      setLlmDoc(r.config || { providers: [], defaultModel: null });
      setError('');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const r = await api<{ tenants: LlmUsageTenant[] }>(`/v1/admin/llm-usage?days=${usageDays}`);
      setUsage(r.tenants || []);
    } catch {
      setUsage([]); // ledger 未发布/不可达时不阻塞本页
    }
  }, [usageDays]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

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
      flashLp('供应商 ID 不合法：需小写字母开头，仅小写字母/数字/_/-（最长 32 位），如 qwen、glm、kimi', true);
      return;
    }
    if (!/^https?:\/\/.+/.test(lpBaseUrl.trim())) {
      flashLp('Base URL 需以 http:// 或 https:// 开头，如 https://dashscope.aliyuncs.com/compatible-mode/v1', true);
      return;
    }
    if (!lpApiKey.trim()) {
      flashLp('API Key 不能为空', true);
      return;
    }
    const models = parseModelLines(lpModels);
    if (models.length === 0) {
      flashLp('至少填写一个模型 ID（模型列表输入框，一行一个）', true);
      return;
    }
    if (models.some((m) => !/^[A-Za-z0-9._-]{1,100}$/.test(m.id))) {
      flashLp('模型 ID 只能含字母/数字/./_/-（:reasoner 后缀除外）', true);
      return;
    }
    const exists = llmDoc.providers.some((p) => p.name === name);
    if (exists && lpEditing !== name) {
      flashLp(`供应商 ${name} 已存在，请换一个 ID 或用列表中的「编辑」`, true);
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
    flashLp(lpEditing ? `已更新供应商 ${name}（尚未保存，请点「保存供应商库」）` : `已添加供应商 ${name}（尚未保存，请点「保存供应商库」）`);
  };

  const editProvider = (p: LlmProvider) => {
    setLpEditing(p.name);
    setLpName(p.name);
    setLpBaseUrl(p.baseUrl);
    setLpApiKey(p.apiKey);
    setLpModels(p.models.map((m) => (m.reasoning ? `${m.id}:reasoner` : m.id)).join('\n'));
  };

  const removeProvider = (name: string) => {
    if (!window.confirm(`确认从列表移除供应商 ${name}？（需保存后生效）`)) return;
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

  const save = async () => {
    if (llmDoc.providers.length === 0) {
      flashLp('未配置任何供应商；如需清空整个库请用「清空供应商库」', true);
      return;
    }
    if (!llmDoc.defaultModel) {
      flashLp('请选择系统默认模型（未单独选择的租户 agent 将使用它）', true);
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ push?: PushSummary }>('/v1/admin/llm-providers', {
        method: 'PUT',
        body: { providers: llmDoc.providers, defaultModel: llmDoc.defaultModel },
      });
      flash(`已保存供应商库。${r.push?.hint || ''}`);
      log(`保存供应商库${r.push?.hint ? ` — ${r.push.hint}` : ''}`);
      await load();
    } catch (e) {
      flashLp(`保存失败：${errMsg(e)}`, true);
      log(`保存供应商库失败：${errMsg(e)}`, true);
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (!window.confirm('确认清空整个供应商库？所有租户 agent 将在重启后无可用模型（对话会失败），直到重新添加供应商。')) return;
    setBusy(true);
    try {
      const r = await api<{ push?: PushSummary }>('/v1/admin/llm-providers', { method: 'DELETE' });
      flash(`已清空供应商库。${r.push?.hint || ''}`);
      log(`清空供应商库${r.push?.hint ? ` — ${r.push.hint}` : ''}`);
      await load();
    } catch (e) {
      const m = errMsg(e);
      flash(`清空失败：${m}`, true);
      log(`清空供应商库失败：${m}`, true);
    } finally {
      setBusy(false);
    }
  };

  const libraryEmpty = llmDoc.providers.length === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">模型供应商</div>
          <div className="page-sub">集中管理大模型供应商库（全局）；租户 Agent 在其详情页从库中选择模型</div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => void load()}>
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>
      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className={`msg ${msgErr ? 'msg-err' : 'msg-ok'}`}>{msg}</div>}
      {loaded && libraryEmpty && (
        <div className="msg msg-warn" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ marginTop: 2 }}>
            <IconAlert size={15} />
          </span>
          <span>
            系统未配置任何大模型供应商（无内置默认）。<b>所有 agent 将以「无模型」状态启动，对话不可用</b>——
            请先在下方添加供应商并设置系统默认模型。
          </span>
        </div>
      )}

      {/* ── 供应商库 ── */}
      <div className="form-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>供应商库</span>
          {!libraryEmpty && <span className="badge badge-active">{llmDoc.providers.length} 个供应商</span>}
          {llmDoc.defaultModel && <span className="badge badge-warn">系统默认：{llmDoc.defaultModel}</span>}
        </div>
        <div className="hint" style={{ marginBottom: 10 }}>
          OpenAI 兼容接口（DeepSeek / 通义千问 / 智谱 GLM / Kimi / 豆包等）。保存后写入各租户{' '}
          <span className="mono">tenant-config</span> Secret 并滚动重启 agent，<b>约 1–2 分钟生效</b>
          （模型配置在容器启动时应用，不支持热更新）。系统不设内置默认供应商——未配置时 agent 无可用模型。
          租户级模型选择请到「Agents 管理」的 Agent 详情页设置。
        </div>

        {llmDoc.providers.length > 0 && (
          <table style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>供应商 ID</th>
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
                    <button className="btn-secondary btn-sm" disabled={busy} onClick={() => editProvider(p)}>
                      编辑
                    </button>{' '}
                    <button className="btn-danger btn-sm" disabled={busy} onClick={() => removeProvider(p.name)}>
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="form-row">
          <label className="field-label">{lpEditing ? `编辑（${lpEditing}）` : '添加供应商'}</label>
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
          <button className="btn-secondary" disabled={busy} onClick={addOrUpdateProvider}>
            {lpEditing ? '更新到列表' : '加入列表'}
          </button>
        </div>
        {lpMsg && (
          <div className={`msg ${lpMsgErr ? 'msg-err' : 'msg-ok'}`} style={{ marginTop: -4 }}>{lpMsg}</div>
        )}
        <div className="form-row">
          <label className="field-label">系统默认模型</label>
          <select
            value={llmDoc.defaultModel || ''}
            onChange={(e) => setLlmDoc((d) => ({ ...d, defaultModel: e.target.value || null }))}
            style={{ flex: '0 1 280px' }}
          >
            <option value="">— 选择系统默认模型（必选） —</option>
            {llmDoc.providers.flatMap((p) =>
              p.models.map((m) => (
                <option key={`${p.name}/${m.id}`} value={`${p.name}/${m.id}`}>
                  {p.name}/{m.id}
                </option>
              )),
            )}
          </select>
          <button className="btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? '处理中…' : (<><IconSave /> 保存供应商库</>)}
          </button>
          {llmDoc.providers.length > 0 && (
            <button className="btn-danger" disabled={busy} onClick={() => void clearAll()}>
              清空供应商库
            </button>
          )}
        </div>
      </div>

      {/* ── LLM 用量汇总（出口代理记账） ── */}
      <div className="form-card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>LLM 用量汇总</span>
          <span className="badge">网关出口代理记账（shadow，不扣 credits）</span>
          <select
            value={usageDays}
            onChange={(e) => setUsageDays(Number(e.target.value))}
            style={{ marginLeft: 'auto', width: 110 }}
          >
            <option value={1}>近 1 天</option>
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
          </select>
          <button className="btn-secondary btn-sm" onClick={() => void loadUsage()}>
            <IconRefresh /> 刷新
          </button>
        </div>
        {usage === null ? (
          <span className="hint" style={{ margin: 0 }}>加载中…</span>
        ) : usage.length === 0 ? (
          <div className="hint" style={{ margin: 0 }}>
            近 {usageDays} 天没有大模型调用记录（或记账服务暂不可达）。
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>租户</th>
                <th>调用次数</th>
                <th>输入 tokens</th>
                <th>输出 tokens</th>
                <th>合计</th>
                <th>拦截/合成</th>
                <th>最近调用</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((t) => (
                <tr key={t.tenantId}>
                  <td className="mono">{t.tenantId}</td>
                  <td>{t.calls}</td>
                  <td>{fmtNum(t.inputTokens)}</td>
                  <td>{fmtNum(t.outputTokens)}</td>
                  <td>{fmtNum(t.totalTokens)}</td>
                  <td style={{ fontSize: 11 }}>
                    {t.blocked > 0 && <span className="badge badge-warn" style={{ marginRight: 4 }}>拦截 {t.blocked}</span>}
                    {t.synthesized > 0 && <span className="badge badge-active">合成 {t.synthesized}</span>}
                    {t.blocked === 0 && t.synthesized === 0 && <span className="hint" style={{ margin: 0 }}>—</span>}
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {t.lastCallAt ? new Date(t.lastCallAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
