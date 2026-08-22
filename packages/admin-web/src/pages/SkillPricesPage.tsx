// Skill 定价 — migrated from the legacy prebuilt SPA (view: pricing).
// Data: credits-ledger /v1/skill-prices (GET / PUT / history) plus
// /v1/admin/skills/:id/activate|launch for state transitions.
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { fmtNum } from '../components/badges';
import Modal from '../components/Modal';
import { IconRefresh } from '../components/icons';

interface SkillPrice {
  skillId: string;
  skillName?: string;
  description?: string | null;
  category?: string | null;
  creditPerUnit?: number;
  cost?: number;
  billingUnit?: string;
  status?: 'live' | 'shadow' | 'disabled' | string;
  activationStatus?: 'approved' | 'pending' | 'rejected' | string;
  responsiblePerson?: string | null;
  serviceLine?: string | null;
}

interface CategorySummary {
  category: string;
  skillCount?: number;
  minPrice?: number;
  maxPrice?: number;
  liveCount?: number;
  shadowCount?: number;
}

interface HistoryEntry {
  id?: string | number;
  oldCredit?: number;
  newCredit?: number;
  changedBy?: string | null;
  reason?: string | null;
  createdAt?: string;
}

const emptyEdit = {
  skillId: '',
  skillName: '',
  category: '',
  creditPerUnit: '0',
  cost: '0',
  billingUnit: 'per_item',
  status: 'shadow',
  description: '',
  responsiblePerson: '',
  serviceLine: '',
};

export default function SkillPricesPage() {
  const [prices, setPrices] = useState<SkillPrice[]>([]);
  const [summary, setSummary] = useState<CategorySummary[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const [edit, setEdit] = useState<typeof emptyEdit | null>(null);
  const [editErr, setEditErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [historyFor, setHistoryFor] = useState<SkillPrice | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyErr, setHistoryErr] = useState('');

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 6000);
  };

  const load = useCallback(async () => {
    try {
      const r = await api<{ prices: SkillPrice[]; summary?: CategorySummary[] }>(
        '/v1/skill-prices',
      );
      setPrices(r.prices || []);
      setSummary(r.summary || []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (p: SkillPrice) => {
    setEdit({
      skillId: p.skillId,
      skillName: p.skillName || '',
      category: p.category || '',
      creditPerUnit: String(p.creditPerUnit ?? 0),
      cost: String(p.cost ?? 0),
      billingUnit: p.billingUnit || 'per_item',
      status: p.status || 'shadow',
      description: p.description || '',
      responsiblePerson: p.responsiblePerson || '',
      serviceLine: p.serviceLine || '',
    });
    setEditErr('');
  };

  const saveEdit = async () => {
    if (!edit) return;
    const body = {
      skillName: edit.skillName.trim(),
      category: edit.category.trim(),
      creditPerUnit: Number(edit.creditPerUnit),
      cost: Number(edit.cost) || undefined,
      billingUnit: edit.billingUnit,
      status: edit.status,
      description: edit.description || undefined,
      responsiblePerson: edit.responsiblePerson || undefined,
      serviceLine: edit.serviceLine || undefined,
    };
    if (!body.skillName || !body.category) {
      setEditErr('名称与分类为必填');
      return;
    }
    setBusy(true);
    setEditErr('');
    try {
      await api(`/v1/skill-prices/${encodeURIComponent(edit.skillId)}`, {
        method: 'PUT',
        body,
      });
      setEdit(null);
      flash(`「${body.skillName}」定价已保存（变更记录入库）`);
      await load();
    } catch (e) {
      setEditErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async (p: SkillPrice) => {
    setHistoryFor(p);
    setHistory([]);
    setHistoryErr('');
    try {
      const r = await api<{ history: HistoryEntry[] }>(
        `/v1/skill-prices/${encodeURIComponent(p.skillId)}/history`,
      );
      setHistory(r.history || []);
    } catch (e) {
      setHistoryErr(errMsg(e));
    }
  };

  const activate = async (p: SkillPrice) => {
    if (!window.confirm(`确认审核通过「${p.skillName || p.skillId}」？（转为影子计费，只记录不扣费）`))
      return;
    try {
      await api(`/v1/admin/skills/${encodeURIComponent(p.skillId)}/activate`, {
        method: 'POST',
        body: {},
      });
      flash(`已审核通过「${p.skillName || p.skillId}」`);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const launch = async (p: SkillPrice) => {
    if (!window.confirm(`确认正式上线「${p.skillName || p.skillId}」？上线后开始计费扣费。`)) return;
    try {
      await api(`/v1/admin/skills/${encodeURIComponent(p.skillId)}/launch`, {
        method: 'POST',
        body: {},
      });
      flash(`「${p.skillName || p.skillId}」已上线计费`);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const margin = (p: SkillPrice): string => {
    const unit = p.creditPerUnit || 0;
    const cost = p.cost || 0;
    if (!unit) return '-';
    const m = 1 - cost / (unit * 0.01);
    return `${(m * 100).toFixed(0)}%`;
  };

  const statusBadge = (p: SkillPrice) => {
    if (p.status === 'live') return <span className="badge badge-active">正式计费</span>;
    if (p.status === 'shadow') return <span className="badge badge-pending">影子计费</span>;
    return <span className="badge badge-dead">已停用</span>;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">Skill 定价</div>
          <div className="page-sub">按分类维护 Skill 单价、成本与计费状态 · 共 {prices.length} 个</div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => void load()}>
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>
      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}

      {summary.length > 0 && (
        <div className="stat-grid">
          {summary.map((s) => (
            <div className="stat-card" key={s.category}>
              <div className="num" style={{ fontSize: 20 }}>
                {s.category || '未分类'}
              </div>
              <div className="label">
                {s.skillCount ?? 0} 个 Skill · 正式 {s.liveCount ?? 0} / 影子 {s.shadowCount ?? 0} ·{' '}
                {fmtNum(s.minPrice)}–{fmtNum(s.maxPrice)} credits
              </div>
            </div>
          ))}
        </div>
      )}

      {prices.length === 0 ? (
        <div className="empty">暂无已注册 Skill</div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>Skill ID</th>
                <th>名称</th>
                <th>分类 / 服务线</th>
                <th>负责人</th>
                <th>Credit/单位</th>
                <th>成本</th>
                <th>毛利率</th>
                <th>计费单位</th>
                <th>状态</th>
                <th style={{ width: 220 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr key={p.skillId}>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {p.skillId}
                  </td>
                  <td>{p.skillName || '-'}</td>
                  <td>
                    {p.category || '-'}
                    <br />
                    <span style={{ fontSize: 11, color: '#777' }}>{p.serviceLine || ''}</span>
                  </td>
                  <td>{p.responsiblePerson || '-'}</td>
                  <td className="mono">{fmtNum(p.creditPerUnit)}</td>
                  <td className="mono">{p.cost != null ? fmtNum(p.cost) : '-'}</td>
                  <td className="mono">{margin(p)}</td>
                  <td>{p.billingUnit || '-'}</td>
                  <td>{statusBadge(p)}</td>
                  <td>
                    <button className="btn-secondary btn-sm" onClick={() => void openHistory(p)}>
                      历史
                    </button>{' '}
                    {p.activationStatus !== 'approved' && (
                      <button className="btn-secondary btn-sm" onClick={() => void activate(p)}>
                        审核通过
                      </button>
                    )}{' '}
                    {p.activationStatus === 'approved' && p.status === 'shadow' && (
                      <button className="btn-primary btn-sm" onClick={() => void launch(p)}>
                        正式上线
                      </button>
                    )}{' '}
                    <button className="btn-secondary btn-sm" onClick={() => openEdit(p)}>
                      编辑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 编辑定价 ── */}
      <Modal
        title={`编辑定价 — ${edit?.skillId || ''}`}
        open={!!edit}
        onClose={() => setEdit(null)}
      >
        {edit && (
          <>
            {editErr && <div className="msg msg-err">{editErr}</div>}
            <div className="form-row">
              <label className="field-label">名称</label>
              <input
                type="text"
                value={edit.skillName}
                onChange={(e) => setEdit({ ...edit, skillName: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="field-label">分类</label>
              <input
                type="text"
                value={edit.category}
                onChange={(e) => setEdit({ ...edit, category: e.target.value })}
              />
              <label className="field-label" style={{ minWidth: 60 }}>
                服务线
              </label>
              <input
                type="text"
                value={edit.serviceLine}
                onChange={(e) => setEdit({ ...edit, serviceLine: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="field-label">Credit/单位</label>
              <input
                type="number"
                style={{ flex: 0, minWidth: 110 }}
                value={edit.creditPerUnit}
                onChange={(e) => setEdit({ ...edit, creditPerUnit: e.target.value })}
              />
              <label className="field-label" style={{ minWidth: 60 }}>
                成本
              </label>
              <input
                type="number"
                style={{ flex: 0, minWidth: 110 }}
                value={edit.cost}
                onChange={(e) => setEdit({ ...edit, cost: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="field-label">计费单位</label>
              <input
                type="text"
                value={edit.billingUnit}
                onChange={(e) => setEdit({ ...edit, billingUnit: e.target.value })}
              />
              <label className="field-label" style={{ minWidth: 60 }}>
                状态
              </label>
              <select
                value={edit.status}
                onChange={(e) => setEdit({ ...edit, status: e.target.value })}
              >
                <option value="shadow">shadow（影子计费）</option>
                <option value="live">live（正式计费）</option>
                <option value="disabled">disabled（停用）</option>
              </select>
            </div>
            <div className="form-row">
              <label className="field-label">负责人</label>
              <input
                type="text"
                value={edit.responsiblePerson}
                onChange={(e) => setEdit({ ...edit, responsiblePerson: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label className="field-label">说明</label>
              <input
                type="text"
                value={edit.description}
                onChange={(e) => setEdit({ ...edit, description: e.target.value })}
              />
            </div>
            <div className="form-row" style={{ marginTop: 12 }}>
              <button className="btn-primary" onClick={() => void saveEdit()} disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
              <button className="btn-secondary" onClick={() => setEdit(null)}>
                取消
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* ── 调价历史 ── */}
      <Modal
        title={`调价历史 — ${historyFor?.skillName || historyFor?.skillId || ''}`}
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
      >
        {historyErr && <div className="msg msg-err">{historyErr}</div>}
        {history.length === 0 && !historyErr ? (
          <div className="empty">暂无调价记录</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>变更</th>
                <th>操作人</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={h.id ?? i}>
                  <td style={{ fontSize: 11, color: '#777' }}>
                    {h.createdAt ? new Date(h.createdAt).toLocaleString() : '-'}
                  </td>
                  <td className="mono">
                    {fmtNum(h.oldCredit)} → {fmtNum(h.newCredit)}
                  </td>
                  <td>{h.changedBy || '-'}</td>
                  <td>{h.reason || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </>
  );
}
