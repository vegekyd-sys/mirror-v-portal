// 外部 API Key 管理 — 供第三方（米奥）调用 token 计费接口鉴权。
// Data: provisioning-service /v1/admin/external-api-keys (GET/POST/DELETE).
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import Modal from '../components/Modal';
import { IconRefresh, IconPlus, IconTrash, IconCopy } from '../components/icons';

interface ExternalApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  supplierId: string | null;
  status: string;
  createdAt: string;
}

export default function ExternalApiKeysPage() {
  const [keys, setKeys] = useState<ExternalApiKey[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [createErr, setCreateErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealKey, setRevealKey] = useState<string | null>(null);

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 6000);
  };

  const load = useCallback(async () => {
    try {
      const r = await api<{ ok: boolean; keys: ExternalApiKey[] }>('/v1/admin/external-api-keys');
      setKeys(r.keys || []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setName('');
    setSupplierId('');
    setCreateErr('');
    setRevealKey(null);
    setCreateOpen(true);
  };

  const doCreate = async () => {
    if (!name.trim()) {
      setCreateErr('名称必填');
      return;
    }
    setBusy(true);
    setCreateErr('');
    try {
      const r = await api<{ key: string }>('/v1/admin/external-api-keys', {
        method: 'POST',
        body: { name: name.trim(), supplierId: supplierId.trim() || null },
      });
      setRevealKey(r.key);
      await load();
    } catch (e) {
      setCreateErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async (k: ExternalApiKey) => {
    if (!window.confirm(`确认吊销「${k.name}」（${k.keyPrefix}…）？吊销后立即失效。`)) return;
    try {
      await api(`/v1/admin/external-api-keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
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
          <div className="section-title">外部 API Key</div>
          <div className="page-sub">供第三方（米奥）调用 token 计费接口鉴权 · 共 {keys.length} 个</div>
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
        第三方调用 <code>/api/external/llm-usage/supplier-summary</code> 时用{' '}
        <code>Authorization: Bearer &lt;key&gt;</code> 鉴权。Key 明文只在创建时显示一次。
      </p>

      {keys.length === 0 ? (
        <div className="empty">暂无外部 API Key</div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>Key</th>
                <th>Supplier 范围</th>
                <th>状态</th>
                <th>创建时间</th>
                <th style={{ width: 100 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{k.keyPrefix}…</td>
                  <td>{k.supplierId ?? '全部供应商'}</td>
                  <td>
                    {k.status === 'active'
                      ? <span className="badge badge-active">生效</span>
                      : <span className="badge badge-dead">已吊销</span>}
                  </td>
                  <td>{k.createdAt ? new Date(k.createdAt).toLocaleString() : '-'}</td>
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

      <Modal title="新建外部 API Key" open={createOpen} onClose={() => setCreateOpen(false)}>
        {revealKey ? (
          <div>
            <p>Key 已创建，<b>明文只显示这一次</b>，请立即保存：</p>
            <div className="form-row">
              <code style={{ wordBreak: 'break-all', flex: 1 }}>{revealKey}</code>
            </div>
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
              <label className="field-label">名称</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：米奥-生产" />
            </div>
            <div className="form-row">
              <label className="field-label">Supplier 范围</label>
              <input type="text" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} placeholder="留空=全部供应商" />
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
