// 对话 — 通过 provisioning-service 聊天代理与租户的 dealclaw-agent 对话。
// 仅 active 租户可聊。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg } from '../lib/api';
import type { Tenant } from '../lib/types';
import { IconAlert, IconChat, IconSend } from '../components/icons';

interface ChatMsg {
  role: 'user' | 'agent' | 'err';
  text: string;
  at: string;
}

export default function ChatPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ tenants: Tenant[] }>('/v1/tenants')
      .then((r) => {
        const list = r.tenants || [];
        // Active tenants first.
        const sorted = [...list].sort((a, b) => {
          const aa = a.status === 'active' ? 0 : 1;
          const bb = b.status === 'active' ? 0 : 1;
          return aa - bb;
        });
        setTenants(sorted);
        const firstActive = sorted.find((t) => t.status === 'active');
        setTenantId((cur) => cur || firstActive?.tenantId || '');
      })
      .catch((e) => setError(errMsg(e)));
  }, []);

  useEffect(() => {
    // New tenant selected → start a fresh conversation view.
    setMessages([]);
  }, [tenantId]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [messages, busy]);

  const selected = tenants.find((t) => t.tenantId === tenantId);
  const activeTenants = tenants.filter((t) => t.status === 'active');

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !tenantId) return;
    setBusy(true);
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text, at: new Date().toLocaleTimeString() }]);
    try {
      const r = await api<{ ok: boolean; reply?: string }>(
        `/v1/admin/tenants/${encodeURIComponent(tenantId)}/chat`,
        { method: 'POST', body: { message: text } },
      );
      setMessages((prev) => [
        ...prev,
        { role: 'agent', text: r.reply || '（无回复内容）', at: new Date().toLocaleTimeString() },
      ]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: 'err', text: `对话失败：${errMsg(e)}`, at: new Date().toLocaleTimeString() },
      ]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, tenantId]);

  // ── 无任何可对话租户：引导配置大模型 Key ──
  if (activeTenants.length === 0) {
    return (
      <>
        <div className="page-head">
          <div>
            <div className="section-title">对话</div>
            <div className="page-sub">与租户 Agent 直接对话</div>
          </div>
        </div>
        {error && <div className="msg msg-err">{error}</div>}
        <div className="panel">
          <div className="panel-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ marginTop: 2, color: '#d97706' }}>
              <IconAlert size={16} />
            </span>
            <div style={{ fontSize: 13.5, color: '#52627e', lineHeight: 1.9 }}>
              当前没有可对话的租户（需状态为 active）。
              <br />
              请先创建租户，并在<Link to="/catalog">「模型目录」</Link>配置 Provider、Model 与 Global Policy、发布 Release，租户部署完成后即可对话。
              <br />
              <Link to="/customers">前往客户管理 →</Link>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">对话</div>
          <div className="page-sub">与租户 Agent 直接对话（同步执行，最长约 2 分钟）</div>
        </div>
        <div className="page-actions">
          <select
            aria-label="选择租户"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            style={{ minWidth: 260 }}
          >
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId} disabled={t.status !== 'active'}>
                {(t.companyName || t.tenantId) +
                  (t.status !== 'active' ? `（${t.status}）` : '')}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <div className="msg msg-err">{error}</div>}

      <div className="chat-shell">
        <div className="chat-head">
          <IconChat size={15} />
          <span style={{ fontWeight: 600, fontSize: 13.5 }}>
            {selected?.companyName || tenantId}
          </span>
          <span style={{ fontSize: 12, color: '#8494ad' }}>
            web 频道 · 会话按登录用户自动保持
          </span>
        </div>
        <div className="chat-body" ref={bodyRef}>
          {messages.length === 0 && !busy && (
            <div className="empty">发送一条消息开始对话</div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`chat-row ${m.role}`}>
              <div>
                <div className="chat-bubble">{m.text}</div>
                <div className="chat-meta" style={{ textAlign: m.role === 'user' ? 'right' : 'left', marginTop: 3 }}>
                  {m.role === 'user' ? '我' : m.role === 'err' ? '系统' : 'Agent'} · {m.at}
                </div>
              </div>
            </div>
          ))}
          {busy && <div className="chat-typing">Agent 正在执行，请稍候（复杂任务可能需要 1–2 分钟）…</div>}
        </div>
        <div className="chat-input">
          <textarea
            value={input}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={2}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn-primary" onClick={() => void send()} disabled={busy || !input.trim()}>
            <IconSend /> 发送
          </button>
        </div>
      </div>
      <div className="hint">
        对话经由 provisioning-service 代理到租户的 dealclaw-agent（/execute 同步执行）。
        需先在「运行时配置」中配置大模型 API Key 与模型 ID，Agent 才能正常回复。
      </div>
    </>
  );
}
