// 对话 API Key 管理 — 供第三方系统通过 HTTP 调用 agent 对话接口鉴权。
// 与 ExternalApiKeysPage（dlk_ 只读拉取）不同：此处是 dlck_ 写入 key，tenant 维度，触发 agent 执行 + LLM 计费。
// Data: provisioning-service /v1/admin/chat-api-keys (GET/POST/DELETE).
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import type { Tenant } from '../lib/types';
import Modal from '../components/Modal';
import { IconRefresh, IconPlus, IconTrash, IconCopy } from '../components/icons';

interface ChatApiKey {
  id: string;
  tenantId: string;
  agentId: string | null;
  name: string;
  keyPrefix: string;
  status: string;
  ipAllowlist: string[] | null;
  rateLimitRpm: number;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export default function ChatApiKeysPage() {
  const [keys, setKeys] = useState<ChatApiKey[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  // 列表可选按 tenant 过滤
  const [filterTenant, setFilterTenant] = useState('');
  // 租户列表（创建时下拉选择，避免手填 32 位 hex 出错）
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  // 创建表单字段
  const [name, setName] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [ipAllowlist, setIpAllowlist] = useState('');
  const [rateLimitRpm, setRateLimitRpm] = useState('60');
  const [createErr, setCreateErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealKey, setRevealKey] = useState<string | null>(null);

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 6000);
  };

  const load = useCallback(async () => {
    try {
      const q = filterTenant.trim() ? `?tenantId=${encodeURIComponent(filterTenant.trim())}` : '';
      const r = await api<{ ok: boolean; keys: ChatApiKey[] }>(`/v1/admin/chat-api-keys${q}`);
      setKeys(r.keys || []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, [filterTenant]);

  useEffect(() => {
    void load();
  }, [load]);

  // 拉取租户列表用于创建 Modal 下拉（非 active 禁选，与 ChatPage 一致）
  useEffect(() => {
    api<{ tenants: Tenant[] }>('/v1/tenants')
      .then((r) => {
        const list = r.tenants || [];
        // active 在前，便于默认选中
        setTenants([...list].sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)));
      })
      .catch(() => {});
  }, []);

  const openCreate = () => {
    setName('');
    // 优先沿用列表过滤框的租户，否则默认选第一个 active 租户
    setTenantId(filterTenant.trim() || tenants.find((t) => t.status === 'active')?.tenantId || '');
    setAgentId('');
    setIpAllowlist('');
    setRateLimitRpm('60');
    setCreateErr('');
    setRevealKey(null);
    setCreateOpen(true);
  };

  const doCreate = async () => {
    if (!name.trim()) {
      setCreateErr('名称必填');
      return;
    }
    if (!tenantId.trim()) {
      setCreateErr('请选择租户');
      return;
    }
    const rpm = Number(rateLimitRpm);
    if (!Number.isFinite(rpm) || rpm < 1 || rpm > 600) {
      setCreateErr('RPM 限速须为 1-600 的整数');
      return;
    }
    const ipList = ipAllowlist
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(true);
    setCreateErr('');
    try {
      const r = await api<{ key: string }>('/v1/admin/chat-api-keys', {
        method: 'POST',
        body: {
          tenantId: tenantId.trim(),
          name: name.trim(),
          agentId: agentId.trim() || null,
          ipAllowlist: ipList.length ? ipList : null,
          rateLimitRpm: rpm,
        },
      });
      setRevealKey(r.key);
      await load();
    } catch (e) {
      setCreateErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async (k: ChatApiKey) => {
    if (!window.confirm(`确认吊销「${k.name}」（${k.keyPrefix}…）？吊销后该 key 立即失效，外部调用方将收到 401。`)) return;
    try {
      await api(`/v1/admin/chat-api-keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
      flash(`已吊销「${k.name}」`);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const copyKey = async () => {
    if (!revealKey) return;
    try {
      await navigator.clipboard.writeText(revealKey);
      flash('已复制到剪贴板');
    } catch {
      flash('复制失败，请手动复制');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">对话 API Key</div>
          <div className="page-sub">供第三方系统通过 HTTP 调用 agent 对话接口鉴权 · 共 {keys.length} 个</div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => void load()}>
            <IconRefresh /> 刷新
          </button>
          <button className="btn-primary" onClick={openCreate}>
            <IconPlus /> 新建 Key
          </button>
        </div>
      </div>
      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}

      <p style={{ fontSize: 12, color: '#777' }}>
        第三方调用 <code>POST /api/external/chat</code>（非流式）或{' '}
        <code>POST /api/external/chat/stream</code>（SSE 流式）时用{' '}
        <code>Authorization: Bearer &lt;key&gt;</code> 鉴权。Key 明文只在创建时显示一次。
        与「外部 API Key」（<code>dlk_</code>，只读拉取）不同，此处是写入 key（
        <code>dlck_</code>，触发 agent 执行 + LLM 计费）。
      </p>

      <div className="form-row" style={{ marginBottom: 12 }}>
        <input
          type="text"
          value={filterTenant}
          onChange={(e) => setFilterTenant(e.target.value)}
          placeholder="按 Tenant ID 过滤（留空=全部）"
          style={{ maxWidth: 360 }}
        />
        <button className="btn-secondary" onClick={() => void load()}>筛选</button>
      </div>

      {keys.length === 0 ? (
        <div className="empty">暂无对话 API Key</div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>Key</th>
                <th>Tenant</th>
                <th>Agent 范围</th>
                <th>IP 白名单</th>
                <th>RPM</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>最后使用</th>
                <th style={{ width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{k.keyPrefix}…</td>
                  <td style={{ fontSize: 11 }}>
                    {tenants.find((t) => t.tenantId === k.tenantId)?.companyName || <span className="mono">{k.tenantId}</span>}
                  </td>
                  <td>{k.agentId ?? <span style={{ color: '#999' }}>全部 agent</span>}</td>
                  <td style={{ fontSize: 11 }}>
                    {k.ipAllowlist && k.ipAllowlist.length
                      ? k.ipAllowlist.join(', ')
                      : <span style={{ color: '#999' }}>不限</span>}
                  </td>
                  <td>{k.rateLimitRpm}</td>
                  <td>
                    {k.status === 'active'
                      ? <span className="badge badge-active">生效</span>
                      : <span className="badge badge-dead">已吊销</span>}
                  </td>
                  <td>{k.createdAt ? new Date(k.createdAt).toLocaleString() : '-'}</td>
                  <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '-'}</td>
                  <td>
                    {k.status === 'active' && (
                      <button className="btn-danger btn-sm" onClick={() => void doRevoke(k)}>
                        <IconTrash /> 吊销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal title="新建对话 API Key" open={createOpen} onClose={() => setCreateOpen(false)}>
        {revealKey ? (
          <div>
            <p>Key 已创建，<b>明文只显示这一次</b>，请立即保存：</p>
            <div className="form-row">
              <code style={{ wordBreak: 'break-all', flex: 1 }}>{revealKey}</code>
            </div>
            <p style={{ fontSize: 12, color: '#777' }}>
              调用示例：<code>curl -X POST https://dealclaw.datathink.com/api/external/chat \\<br />
              -H &quot;Authorization: Bearer {revealKey.slice(0, 8)}…&quot; \\<br />
              -H &quot;Content-Type: application/json&quot; \\<br />
              -d &#39;&#123;&quot;message&quot;:&quot;你好&quot;&#125;&#39;</code>
            </p>
            <div className="form-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn-primary" onClick={() => void copyKey()}>
                <IconCopy /> 复制
              </button>
              <button className="btn-secondary" onClick={() => setCreateOpen(false)}>完成</button>
            </div>
          </div>
        ) : (
          <div>
            <div className="form-row">
              <label className="field-label">名称 *</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：CRM 集成" />
            </div>
            <div className="form-row">
              <label className="field-label">租户 *</label>
              <select
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                style={{ minWidth: 280 }}
              >
                <option value="">— 选择租户 —</option>
                {tenants.map((t) => (
                  <option key={t.tenantId} value={t.tenantId} disabled={t.status !== 'active'}>
                    {(t.companyName || t.tenantId) + (t.status !== 'active' ? `（${t.status}）` : '')}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label className="field-label">Agent 范围</label>
              <input type="text" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="留空=该租户全部 agent" />
            </div>
            <div className="form-row">
              <label className="field-label">IP 白名单</label>
              <input type="text" value={ipAllowlist} onChange={(e) => setIpAllowlist(e.target.value)} placeholder="CIDR，逗号或空格分隔，如 1.2.3.0/24,5.6.7.8" />
            </div>
            <div className="form-row">
              <label className="field-label">RPM 限速</label>
              <input type="number" min={1} max={600} value={rateLimitRpm} onChange={(e) => setRateLimitRpm(e.target.value)} placeholder="1-600，默认 60" style={{ maxWidth: 160 }} />
            </div>
            {createErr && <div className="msg msg-err">{createErr}</div>}
            <div className="form-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn-primary" disabled={busy} onClick={() => void doCreate()}>创建</button>
              <button className="btn-secondary" onClick={() => setCreateOpen(false)}>取消</button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
