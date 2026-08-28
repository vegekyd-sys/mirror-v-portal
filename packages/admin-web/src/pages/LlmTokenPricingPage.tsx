// LLM Token 定价 — 按 provider + model 配置 token 单价（元/百万 token，峰/闲分档）。
// Data: credits-ledger /v1/billing/llm-token-pricing（GET / PUT）。
// 用途：llm-usage/range 成本核算按此表折算，provider|model 精确匹配，缺价格则 cost=0。
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { IconAlert, IconRefresh } from '../components/icons';

interface PricingRow {
  provider: string;
  model: string;
  inputCacheHitPeak: number;
  inputCacheHitOffpeak: number;
  inputCacheMissPeak: number;
  inputCacheMissOffpeak: number;
  outputPeak: number;
  outputOffpeak: number;
  currency: string;
  updatedAt: string;
}

const EMPTY_FORM = {
  provider: '',
  model: '',
  inputCacheHitPeak: '',
  inputCacheHitOffpeak: '',
  inputCacheMissPeak: '',
  inputCacheMissOffpeak: '',
  outputPeak: '',
  outputOffpeak: '',
};

/** 峰/闲 成对展示："9.00 / 4.50" */
const pair = (peak: number, off: number): string => `${peak} / ${off}`;

export default function LlmTokenPricingPage() {
  const [rows, setRows] = useState<PricingRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgErr, setMsgErr] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null); // "provider|model"
  const [form, setForm] = useState(EMPTY_FORM);

  const flash = (text: string, isErr = false) => {
    setMsg(text);
    setMsgErr(isErr);
    window.setTimeout(() => {
      setMsg('');
      setMsgErr(false);
    }, 6000);
  };

  const load = useCallback(async () => {
    try {
      const r = await api<{ pricing: PricingRow[] }>('/v1/billing/llm-token-pricing');
      setRows(r.pricing || []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
      setRows([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (k: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const startAdd = () => {
    setEditingKey(null);
    setForm(EMPTY_FORM);
  };

  const startEdit = (r: PricingRow) => {
    setEditingKey(`${r.provider}|${r.model}`);
    setForm({
      provider: r.provider,
      model: r.model,
      inputCacheHitPeak: String(r.inputCacheHitPeak),
      inputCacheHitOffpeak: String(r.inputCacheHitOffpeak),
      inputCacheMissPeak: String(r.inputCacheMissPeak),
      inputCacheMissOffpeak: String(r.inputCacheMissOffpeak),
      outputPeak: String(r.outputPeak),
      outputOffpeak: String(r.outputOffpeak),
    });
  };

  const save = async () => {
    const provider = form.provider.trim();
    const model = form.model.trim();
    if (!provider || !model) {
      flash('供应商和模型名必填', true);
      return;
    }
    const fields = [
      'inputCacheHitPeak',
      'inputCacheHitOffpeak',
      'inputCacheMissPeak',
      'inputCacheMissOffpeak',
      'outputPeak',
      'outputOffpeak',
    ] as const;
    const nums: Record<string, number> = {};
    for (const f of fields) {
      const v = form[f].trim();
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || n < 0) {
        flash('六个价格字段都必须是 ≥0 的数字', true);
        return;
      }
      nums[f] = n;
    }
    setBusy(true);
    try {
      await api('/v1/billing/llm-token-pricing', {
        method: 'PUT',
        body: { provider, model, ...nums },
      });
      flash(`「${provider}/${model}」定价已保存`);
      setEditingKey(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      flash(`保存失败：${errMsg(e)}`, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">LLM Token 定价</div>
          <div className="page-sub">
            按「供应商 / 模型」配置 token 单价（元 / 百万 token，高峰 / 闲时分档），用于成本核算折算
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => void load()}>
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>

      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className={`msg ${msgErr ? 'msg-err' : 'msg-ok'}`}>{msg}</div>}

      <div className="form-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 14, color: '#171c2e', fontWeight: 700 }}>定价表</span>
          {loaded && <span className="badge badge-active">{rows.length} 条</span>}
        </div>
        <div className="hint" style={{ marginBottom: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <IconAlert size={13} />
          </span>{' '}
          成本核算按 <span className="mono">provider|model</span> 精确匹配本表——<b>未配置的供应商/模型，成本按 0 计</b>。
          峰谷规则：工作日 09:00–12:00、14:00–18:00 为高峰，其余时段（含夜间）与周末为闲时。
        </div>

        {rows.length === 0 ? (
          <div className="hint" style={{ margin: '8px 0' }}>
            {loaded ? '暂无定价记录，请在下方添加。' : '加载中…'}
          </div>
        ) : (
          <table style={{ marginBottom: 14 }}>
            <thead>
              <tr>
                <th>供应商</th>
                <th>模型</th>
                <th>输入·缓存命中（峰/闲）</th>
                <th>输入·缓存未命中（峰/闲）</th>
                <th>输出（峰/闲）</th>
                <th style={{ width: 120 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.provider}|${r.model}`}>
                  <td className="mono">{r.provider}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.model}</td>
                  <td className="mono">{pair(r.inputCacheHitPeak, r.inputCacheHitOffpeak)}</td>
                  <td className="mono">{pair(r.inputCacheMissPeak, r.inputCacheMissOffpeak)}</td>
                  <td className="mono">{pair(r.outputPeak, r.outputOffpeak)}</td>
                  <td>
                    <button className="btn-secondary btn-sm" disabled={busy} onClick={() => startEdit(r)}>
                      编辑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid #eef1f6', paddingTop: 12, marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: '#171c2e', fontWeight: 700 }}>
              {editingKey ? `编辑（${editingKey}）` : '添加定价'}
            </span>
            {editingKey && (
              <button className="btn-secondary btn-sm" onClick={startAdd} disabled={busy}>
                取消，改添加
              </button>
            )}
          </div>

          <div className="form-row">
            <label className="field-label">供应商</label>
            <input
              type="text"
              className="mono"
              style={{ flex: '0 1 150px' }}
              value={form.provider}
              onChange={set('provider')}
              placeholder="如 deepseek / foldin-xiaoyuan"
              disabled={editingKey !== null}
            />
            <label className="field-label" style={{ marginLeft: 12 }}>模型</label>
            <input
              type="text"
              className="mono"
              style={{ flex: '1 1 220px' }}
              value={form.model}
              onChange={set('model')}
              placeholder="如 deepseek-v4-pro-0813（需与实际用量模型名一致）"
              disabled={editingKey !== null}
            />
          </div>

          <div className="form-row" style={{ marginTop: 8 }}>
            <label className="field-label">输入·命中峰</label>
            <input type="text" className="mono" style={{ flex: 1 }} value={form.inputCacheHitPeak} onChange={set('inputCacheHitPeak')} placeholder="0.30" />
            <label className="field-label" style={{ marginLeft: 8 }}>输入·命中闲</label>
            <input type="text" className="mono" style={{ flex: 1 }} value={form.inputCacheHitOffpeak} onChange={set('inputCacheHitOffpeak')} placeholder="0.15" />
            <label className="field-label" style={{ marginLeft: 8 }}>输入·未命中峰</label>
            <input type="text" className="mono" style={{ flex: 1 }} value={form.inputCacheMissPeak} onChange={set('inputCacheMissPeak')} placeholder="9.00" />
          </div>

          <div className="form-row" style={{ marginTop: 8 }}>
            <label className="field-label">输入·未命中闲</label>
            <input type="text" className="mono" style={{ flex: 1 }} value={form.inputCacheMissOffpeak} onChange={set('inputCacheMissOffpeak')} placeholder="4.50" />
            <label className="field-label" style={{ marginLeft: 8 }}>输出·峰</label>
            <input type="text" className="mono" style={{ flex: 1 }} value={form.outputPeak} onChange={set('outputPeak')} placeholder="27.00" />
            <label className="field-label" style={{ marginLeft: 8 }}>输出·闲</label>
            <input type="text" className="mono" style={{ flex: 1 }} value={form.outputOffpeak} onChange={set('outputOffpeak')} placeholder="13.50" />
          </div>

          <div className="form-row" style={{ marginTop: 10 }}>
            <span className="hint" style={{ margin: 0 }}>
              单位：元 / 百万 token（CNY）。示例为 DeepSeek V4-Pro 官方价。
            </span>
            <button
              className="btn-primary"
              style={{ marginLeft: 'auto' }}
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? '保存中…' : '保存定价'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
