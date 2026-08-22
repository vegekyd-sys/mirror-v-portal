// 套餐模板 — migrated from the legacy prebuilt SPA (view: plans).
// Data: credits-ledger /v1/admin/plans (GET / POST upsert / DELETE).
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { fmtNum } from '../components/badges';
import Modal from '../components/Modal';

interface Plan {
  planId: string;
  planName: string;
  tier?: string;
  annualFeeYuan?: number;
  initialCredit?: number;
  seatsMin?: number;
  seatsMax?: number;
  renewalDiscount?: number;
  renewalPricePer100k?: number;
  monthlyAllowance?: number;
  features?: string[] | string | null;
}

const emptyForm = {
  planId: '',
  planName: '',
  tier: 'starter',
  annualFeeYuan: '0',
  initialCredit: '0',
  renewalPricePer100k: '0',
  renewalDiscount: '1',
  monthlyAllowance: '0',
  seatsMin: '1',
  seatsMax: '1',
};

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ plans: Plan[] }>('/v1/admin/plans');
      setPlans(r.plans || []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setForm({ ...emptyForm });
    setEditing(false);
    setFormErr('');
    setShowForm(true);
  };

  const openEdit = (p: Plan) => {
    setForm({
      planId: p.planId,
      planName: p.planName,
      tier: p.tier || 'starter',
      annualFeeYuan: String(p.annualFeeYuan ?? 0),
      initialCredit: String(p.initialCredit ?? 0),
      renewalPricePer100k: String(p.renewalPricePer100k ?? 0),
      renewalDiscount: String(p.renewalDiscount ?? 1),
      monthlyAllowance: String(p.monthlyAllowance ?? 0),
      seatsMin: String(p.seatsMin ?? 1),
      seatsMax: String(p.seatsMax ?? 1),
    });
    setEditing(true);
    setFormErr('');
    setShowForm(true);
  };

  const save = async () => {
    const body = {
      planId: form.planId.trim(),
      planName: form.planName.trim(),
      tier: form.tier.trim(),
      annualFeeYuan: Number(form.annualFeeYuan),
      initialCredit: Number(form.initialCredit),
      renewalPricePer100k: Number(form.renewalPricePer100k),
      renewalDiscount: Number(form.renewalDiscount),
      monthlyAllowance: Number(form.monthlyAllowance),
      seatsMin: Number(form.seatsMin),
      seatsMax: Number(form.seatsMax),
    };
    if (!body.planId || !body.planName || !body.tier) {
      setFormErr('planId / 名称 / 档位为必填');
      return;
    }
    setBusy(true);
    setFormErr('');
    try {
      await api('/v1/admin/plans', { method: 'POST', body });
      setShowForm(false);
      setMsg(`套餐「${body.planName}」已保存`);
      window.setTimeout(() => setMsg(''), 5000);
      await load();
    } catch (e) {
      setFormErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Plan) => {
    if (!window.confirm(`确认删除「${p.planName}」？此操作不可撤销。`)) return;
    try {
      await api(`/v1/admin/plans/${encodeURIComponent(p.planId)}`, { method: 'DELETE' });
      setMsg(`套餐「${p.planName}」已删除`);
      window.setTimeout(() => setMsg(''), 5000);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <>
      <div className="section-title">套餐模板</div>
      {error && <div className="msg msg-err">加载失败：{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}

      <div className="action-bar">
        <button className="btn-secondary" onClick={() => void load()}>
          🔄 刷新
        </button>
        <button className="btn-primary" onClick={openCreate}>
          ➕ 新建套餐
        </button>
        <span style={{ fontSize: 12, color: '#666' }}>{plans.length} 个套餐</span>
      </div>

      <div className="plan-grid">
        {plans.map((p) => (
          <div className="plan-card" key={p.planId}>
            <span className="badge badge-plan-pro">{p.tier || '-'}</span>
            <h3>{p.planName}</h3>
            <div className="plan-price">¥{fmtNum(p.annualFeeYuan)} / 年</div>
            <ul className="plan-feats">
              <li>✓ 初始 {fmtNum(p.initialCredit)} Credits</li>
              <li>
                ✓ {p.seatsMin ?? '-'}–{p.seatsMax ?? '-'} 个席位
              </li>
              <li>✓ 续费 ¥{fmtNum(p.renewalPricePer100k)} / 10万</li>
              <li>✓ {Math.round(((p.renewalDiscount ?? 1) || 1) * 100)}% 续费系数</li>
            </ul>
            <div className="form-row">
              <button className="btn-secondary btn-sm" onClick={() => openEdit(p)}>
                编辑套餐
              </button>
              <button className="btn-danger btn-sm" onClick={() => void remove(p)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {plans.length > 0 && (
        <>
          <div className="section-title" style={{ fontSize: 14 }}>
            套餐参数总览（plan_templates）
          </div>
          <table>
            <thead>
              <tr>
                <th>planId</th>
                <th>名称</th>
                <th>档位</th>
                <th>年费(¥)</th>
                <th>初始 Credits</th>
                <th>席位</th>
                <th>续费价/10万</th>
                <th>续费系数</th>
                <th>月度配额</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.planId}>
                  <td className="mono">{p.planId}</td>
                  <td>{p.planName}</td>
                  <td>{p.tier}</td>
                  <td className="mono">{fmtNum(p.annualFeeYuan)}</td>
                  <td className="mono">{fmtNum(p.initialCredit)}</td>
                  <td className="mono">
                    {p.seatsMin}–{p.seatsMax}
                  </td>
                  <td className="mono">{fmtNum(p.renewalPricePer100k)}</td>
                  <td className="mono">{p.renewalDiscount}</td>
                  <td className="mono">{fmtNum(p.monthlyAllowance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <Modal
        title={editing ? `编辑套餐 — ${form.planId}` : '新建套餐'}
        open={showForm}
        onClose={() => setShowForm(false)}
      >
        {formErr && <div className="msg msg-err">{formErr}</div>}
        <div className="form-row">
          <label className="field-label">planId</label>
          <input
            type="text"
            value={form.planId}
            disabled={editing}
            onChange={(e) => setForm({ ...form, planId: e.target.value })}
            placeholder="如 starter-2026"
          />
        </div>
        <div className="form-row">
          <label className="field-label">套餐名称</label>
          <input
            type="text"
            value={form.planName}
            onChange={(e) => setForm({ ...form, planName: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="field-label">档位</label>
          <input
            type="text"
            value={form.tier}
            onChange={(e) => setForm({ ...form, tier: e.target.value })}
            placeholder="starter / pro / enterprise"
          />
        </div>
        <div className="form-row">
          <label className="field-label">年费（¥）</label>
          <input
            type="number"
            value={form.annualFeeYuan}
            onChange={(e) => setForm({ ...form, annualFeeYuan: e.target.value })}
          />
          <label className="field-label" style={{ minWidth: 100 }}>
            初始 Credits
          </label>
          <input
            type="number"
            value={form.initialCredit}
            onChange={(e) => setForm({ ...form, initialCredit: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="field-label">续费价/10万</label>
          <input
            type="number"
            value={form.renewalPricePer100k}
            onChange={(e) => setForm({ ...form, renewalPricePer100k: e.target.value })}
          />
          <label className="field-label" style={{ minWidth: 100 }}>
            续费系数
          </label>
          <input
            type="number"
            step="0.01"
            value={form.renewalDiscount}
            onChange={(e) => setForm({ ...form, renewalDiscount: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="field-label">席位最小</label>
          <input
            type="number"
            style={{ flex: 0, minWidth: 80 }}
            value={form.seatsMin}
            onChange={(e) => setForm({ ...form, seatsMin: e.target.value })}
          />
          <label className="field-label" style={{ minWidth: 70 }}>
            席位最大
          </label>
          <input
            type="number"
            style={{ flex: 0, minWidth: 80 }}
            value={form.seatsMax}
            onChange={(e) => setForm({ ...form, seatsMax: e.target.value })}
          />
          <label className="field-label" style={{ minWidth: 90 }}>
            月度配额
          </label>
          <input
            type="number"
            value={form.monthlyAllowance}
            onChange={(e) => setForm({ ...form, monthlyAllowance: e.target.value })}
          />
        </div>
        <div className="form-row" style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button className="btn-secondary" onClick={() => setShowForm(false)}>
            取消
          </button>
        </div>
      </Modal>
    </>
  );
}
