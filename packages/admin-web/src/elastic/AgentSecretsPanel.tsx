import { useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { fmtTime } from '../components/badges';

interface SecretStatus { templateId: string; required: string[]; bound: boolean; names: string[]; updatedAt: string | null }

const LABELS: Record<string, { label: string; secret: boolean }> = {
  XINGQING_USERNAME: { label: '星擎账号', secret: false },
  XINGQING_PASSWORD: { label: '星擎密码', secret: true },
};

/** Operator binding for templates that need a customer's own account. Values are write-only. */
export default function AgentSecretsPanel({ tenantId }: { tenantId: string }) {
  const path = `/v1/admin/elastic/agents/${encodeURIComponent(tenantId)}/secrets`;
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api<SecretStatus>(path).then(setStatus).catch(() => setStatus(null));
  useEffect(() => { load(); }, [path]);
  if (!status?.required?.length) return null;
  const submit = async () => {
    setBusy(true); setMessage(null);
    try {
      await api(path, { method: 'PUT', body: { secrets: values } });
      setValues({});
      setMessage({ ok: true, text: '已绑定。实例下次休眠唤醒后生效。' });
      await load();
    } catch (cause) { setMessage({ ok: false, text: `绑定失败：${errMsg(cause)}` }); }
    finally { setBusy(false); }
  };
  const unbind = async () => {
    if (!window.confirm('解除后该实例将无法查询企业数据，确定解除？')) return;
    setBusy(true); setMessage(null);
    try { await api(path, { method: 'DELETE' }); setMessage({ ok: true, text: '已解除绑定。' }); await load(); }
    catch (cause) { setMessage({ ok: false, text: `解除失败：${errMsg(cause)}` }); }
    finally { setBusy(false); }
  };
  const complete = status.required.every((name) => values[name]?.trim());
  return <div className="panel">
    <div className="panel-title">企业账号绑定</div>
    <div className="panel-sub">{status.bound ? `后台已绑定 · 更新于 ${status.updatedAt ? fmtTime(status.updatedAt) : '—'}` : '后台未绑定：客户也可以在对话里自己提供账号完成绑定'}</div>
    <div className="panel-body">
      {status.required.map((name) => {
        const meta = LABELS[name] ?? { label: name, secret: true };
        return <div className="form-row" key={name}>
          <label className="field-label" htmlFor={`secret-${name}`}>{meta.label}</label>
          <input id={`secret-${name}`} type={meta.secret ? 'password' : 'text'} autoComplete="off"
            value={values[name] ?? ''} onChange={(event) => setValues({ ...values, [name]: event.target.value })} />
        </div>;
      })}
      <div className="hint">只能绑定该客户企业自己的账号，禁止绑定 admin 或其他企业账号。后台绑定优先于客户在对话里的绑定；保存后不会再显示账号密码。</div>
      {message && <div className={message.ok ? 'msg msg-ok' : 'msg msg-err'}>{message.text}</div>}
      <div className="page-actions">
        <button className="btn-primary btn-sm" disabled={busy || !complete} onClick={submit}>{status.bound ? '更新绑定' : '保存绑定'}</button>
        {status.bound && <button className="btn-danger btn-sm" disabled={busy} onClick={unbind}>解除绑定</button>}
      </div>
    </div>
  </div>;
}
