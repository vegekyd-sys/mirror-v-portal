// 用户管理 — new page (the legacy console never exposed /v1/admin/users).
// Data: credits-ledger /v1/admin/users (list/create/regenerate-token/activate/deactivate).
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import Modal from '../components/Modal';
import { IconCopy, IconPlus, IconRefresh } from '../components/icons';

interface AdminUserRow {
  id: string;
  username: string;
  displayName?: string | null;
  role?: string;
  isActive?: boolean;
  createdAt?: string;
  lastLoginAt?: string | null;
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', role: 'admin' });
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [tokenReveal, setTokenReveal] = useState<{ username: string; token: string } | null>(
    null,
  );

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 6000);
  };

  const load = useCallback(async () => {
    try {
      const r = await api<{ users: AdminUserRow[] }>('/v1/admin/users');
      setUsers(r.users || []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!form.username.trim() || !form.displayName.trim()) {
      setFormErr('用户名与显示名称为必填');
      return;
    }
    setBusy(true);
    setFormErr('');
    try {
      const r = await api<{ user: AdminUserRow; loginToken: string }>('/v1/admin/users', {
        method: 'POST',
        body: {
          username: form.username.trim(),
          displayName: form.displayName.trim(),
          role: form.role,
        },
      });
      setShowCreate(false);
      setForm({ username: '', displayName: '', role: 'admin' });
      setTokenReveal({ username: r.user.username, token: r.loginToken });
      await load();
    } catch (e) {
      setFormErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (u: AdminUserRow) => {
    if (
      !window.confirm(
        `确认为「${u.displayName || u.username}」重新生成登录口令？原口令立即失效。`,
      )
    )
      return;
    try {
      const r = await api<{ loginToken: string }>(
        `/v1/admin/users/${encodeURIComponent(u.id)}/regenerate-token`,
        { method: 'POST', body: {} },
      );
      setTokenReveal({ username: u.username, token: r.loginToken });
    } catch (e) {
      flash(`重置失败：${errMsg(e)}`);
    }
  };

  const toggleActive = async (u: AdminUserRow) => {
    const action = u.isActive ? 'deactivate' : 'activate';
    const verb = u.isActive ? '禁用' : '启用';
    if (!window.confirm(`确认${verb}用户「${u.displayName || u.username}」？`)) return;
    try {
      await api(`/v1/admin/users/${encodeURIComponent(u.id)}/${action}`, {
        method: 'POST',
        body: {},
      });
      flash(`已${verb} ${u.username}`);
      await load();
    } catch (e) {
      flash(`操作失败：${errMsg(e)}`);
    }
  };

  const copyToken = () => {
    if (!tokenReveal) return;
    navigator.clipboard?.writeText(tokenReveal.token).then(
      () => flash('口令已复制到剪贴板'),
      () => flash('复制失败，请手动选择复制'),
    );
  };

  return (
    <>
      <div className="section-title">用户管理</div>
      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}

      <div className="action-bar">
        <button className="btn-secondary" onClick={() => void load()}>
          <IconRefresh /> 刷新
        </button>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <IconPlus /> 新建管理员
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>用户名</th>
            <th>显示名称</th>
            <th>角色</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>最近登录</th>
            <th style={{ width: 220 }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td className="mono">{u.username}</td>
              <td>{u.displayName || '-'}</td>
              <td>
                <span className={`badge ${u.role === 'admin' ? 'badge-plan-pro' : 'badge-dead'}`}>
                  {u.role || '-'}
                </span>
              </td>
              <td>
                {u.isActive ? (
                  <span className="badge badge-active">启用</span>
                ) : (
                  <span className="badge badge-failed">禁用</span>
                )}
              </td>
              <td style={{ fontSize: 11, color: '#777' }}>
                {u.createdAt ? new Date(u.createdAt).toLocaleString() : '-'}
              </td>
              <td style={{ fontSize: 11, color: '#777' }}>
                {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '从未'}
              </td>
              <td>
                <button className="btn-secondary btn-sm" onClick={() => void regenerate(u)}>
                  重置口令
                </button>{' '}
                <button
                  className={u.isActive ? 'btn-danger btn-sm' : 'btn-primary btn-sm'}
                  onClick={() => void toggleActive(u)}
                >
                  {u.isActive ? '禁用' : '启用'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hint">
        登录口令仅在新建 / 重置时显示一次，服务端只保存其 HMAC 哈希，无法找回。
        重置口令使用 ledger <code>POST /v1/admin/users/:id/regenerate-token</code>。
      </div>

      {/* ── 新建 ── */}
      <Modal title="新建管理员" open={showCreate} onClose={() => setShowCreate(false)}>
        {formErr && <div className="msg msg-err">{formErr}</div>}
        <div className="form-row">
          <label className="field-label">用户名</label>
          <input
            type="text"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            placeholder="登录用户名"
          />
        </div>
        <div className="form-row">
          <label className="field-label">显示名称</label>
          <input
            type="text"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="field-label">角色</label>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="admin">admin</option>
            <option value="operator">operator</option>
          </select>
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={() => void create()} disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </button>
          <button className="btn-secondary" onClick={() => setShowCreate(false)}>
            取消
          </button>
        </div>
      </Modal>

      {/* ── 口令展示（一次性） ── */}
      <Modal
        title={`登录口令 — ${tokenReveal?.username || ''}`}
        open={!!tokenReveal}
        onClose={() => setTokenReveal(null)}
      >
        <div className="msg msg-warn">
          此口令仅显示这一次，请立即复制保存。关闭后无法再次查看，只能重置。
        </div>
        <textarea
          readOnly
          value={tokenReveal?.token || ''}
          onFocus={(e) => e.currentTarget.select()}
          style={{ width: '100%', height: 84, fontFamily: 'monospace', fontSize: 12 }}
        />
        <div className="form-row" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={copyToken}>
            <IconCopy /> 复制口令
          </button>
          <button className="btn-secondary" onClick={() => setTokenReveal(null)}>
            我已保存，关闭
          </button>
        </div>
      </Modal>
    </>
  );
}
