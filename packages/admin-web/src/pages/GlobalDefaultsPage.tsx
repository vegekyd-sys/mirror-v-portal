// 默认配置 — 所有 Agent 的共性默认项（全局默认配置）。
//
// 决策（工单 5 / v3）：
//   1. 首次由运维写 K8s Secret → 服务启动幂等种子入库；之后一律在本页改。
//   2. 改值只影响「此后新建的 Agent」；存量 Agent 走
//      「同步到存量 Agent」= dryRun 报告 → 人工确认 → 逐个下发 + 每租户回执。
//   3. 仅超管：后端 403，本页也据此提示。
//   4. 列表只显示「已配置/未配置 + 长度 + 更新时间/人」，**永不回显明文**。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { isSuperAdmin } from '../lib/roles';
import type {
  GlobalDefaultApplyResponse,
  GlobalDefaultDryRunResponse,
  GlobalDefaultItem,
  GlobalDefaultListResponse,
  GlobalDefaultSaveResponse,
} from '../lib/types';
import { IconAlert, IconRefresh, IconSave } from '../components/icons';

const GROUP_LABEL: Record<string, string> = {
  secret: '密钥（全 Agent 同值）',
  group: '群与绑定',
  skill: 'skill 默认（预留）',
};
const GROUP_ORDER = ['secret', 'group', 'skill'];

export default function GlobalDefaultsPage() {
  const { user } = useAuth();
  const superAdmin = isSuperAdmin(user);

  const [items, setItems] = useState<GlobalDefaultItem[]>([]);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(true);
  /** 待保存的草稿值（key → 明文；仅存在内存，保存后立刻清空）。 */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [dryRun, setDryRun] = useState<GlobalDefaultDryRunResponse | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [dryRunning, setDryRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<GlobalDefaultApplyResponse | null>(null);
  const [opLogs, setOpLogs] = useState<{ t: string; text: string; err?: boolean }[]>([]);

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 8000);
  };
  const log = (text: string, err = false) => {
    setOpLogs((prev) => [{ t: new Date().toLocaleTimeString(), text, err }, ...prev]);
  };

  const load = useCallback(async () => {
    try {
      const r = await api<GlobalDefaultListResponse>('/v1/admin/global-defaults');
      setItems(r.items || []);
      setKeyConfigured(r.keyConfigured !== false);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const m = new Map<string, GlobalDefaultItem[]>();
    for (const g of GROUP_ORDER) m.set(g, []);
    for (const it of items) {
      const g = it.group || (it.isSecret ? 'secret' : 'skill');
      if (!m.has(g)) m.set(g, []);
      (m.get(g) as GlobalDefaultItem[]).push(it);
    }
    // 固定三组顺序（密钥 / 群与绑定 / skill 默认），未启用的分组显示占位。
    return [...m.entries()].sort(
      (a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]),
    );
  }, [items]);

  const dirtyKeys = useMemo(
    () => Object.keys(draft).filter((k) => (draft[k] ?? '').length > 0),
    [draft],
  );

  const save = async () => {
    if (dirtyKeys.length === 0) {
      flash('没有要保存的改动（密钥框留空 = 不修改；主群规则请选择后再保存）');
      return;
    }
    if (
      !window.confirm(
        `确认保存 ${dirtyKeys.length} 项默认值？\n\n只会影响此后新建的 Agent；存量 Agent 需要再点「同步到存量 Agent」。`,
      )
    )
      return;
    setSaving(true);
    const saved: string[] = [];
    const failed: string[] = [];
    for (const key of dirtyKeys) {
      try {
        const r = await api<GlobalDefaultSaveResponse>('/v1/admin/global-defaults', {
          method: 'PUT',
          body: { key, value: draft[key] },
        });
        saved.push(`${key}(长度 ${r.length ?? '-'})`);
      } catch (e) {
        failed.push(`${key}: ${errMsg(e)}`);
      }
    }
    setSaving(false);
    // 明文立刻从内存清掉，列表中只保留「已配置」状态。
    setDraft({});
    await load();
    if (failed.length) {
      flash(`保存完成：成功 ${saved.length} 项，失败 ${failed.length} 项`);
      log(`保存失败：${failed.join('；')}`, true);
    } else {
      flash(`已保存 ${saved.length} 项默认值。新建 Agent 将自动继承；存量 Agent 请点「同步到存量 Agent」。`);
      log(`保存默认值：${saved.join('、')}`);
    }
  };

  const runDryRun = async () => {
    setDryRunning(true);
    setApplyResult(null);
    try {
      const r = await api<GlobalDefaultDryRunResponse>('/v1/admin/global-defaults/dry-run', {
        method: 'POST',
        body: {},
      });
      setDryRun(r);
      // 默认勾选「需要更新」的 Agent（可全选/取消）。
      setSelected(
        Object.fromEntries(
          (r.tenants || []).filter((t) => t.state === 'needs_update').map((t) => [t.tenantId, true]),
        ),
      );
      log(
        `dryRun：共 ${r.summary.total} 个 Agent，需更新 ${r.summary.needsUpdate}、已最新 ${r.summary.upToDate}、跳过 ${r.summary.skipped}`,
      );
    } catch (e) {
      flash(`dryRun 失败：${errMsg(e)}`);
      log(`dryRun 失败：${errMsg(e)}`, true);
    } finally {
      setDryRunning(false);
    }
  };

  const apply = async () => {
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (ids.length === 0) {
      flash('请先勾选要下发的 Agent（可重新 dryRun 后选择）');
      return;
    }
    if (
      !window.confirm(
        `确认向 ${ids.length} 个存量 Agent 下发默认值？\n\n将重写各自 skill-env Secret（约 1 分钟内热生效，首次挂载会滚动重启一次），失败项会在回执里列出、可重试。`,
      )
    )
      return;
    setApplying(true);
    try {
      const r = await api<GlobalDefaultApplyResponse>('/v1/admin/global-defaults/apply', {
        method: 'POST',
        body: { tenantIds: ids },
      });
      setApplyResult(r);
      flash(`下发完成：成功 ${r.succeeded} / 尝试 ${r.attempted}，失败 ${r.failed}`);
      log(`下发：成功 ${r.succeeded} / 尝试 ${r.attempted}`);
      await runDryRun();
    } catch (e) {
      flash(`下发失败：${errMsg(e)}`);
      log(`下发失败：${errMsg(e)}`, true);
    } finally {
      setApplying(false);
    }
  };

  const toggleAllNeedsUpdate = () => {
    if (!dryRun) return;
    const next: Record<string, boolean> = {};
    for (const t of dryRun.tenants) next[t.tenantId] = t.state === 'needs_update';
    setSelected(next);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">默认配置</div>
          <div className="page-sub">
            所有 Agent 的共性默认项：改一处 → 新建 Agent 自动继承；存量 Agent 走「dryRun → 人工确认 → 逐个下发」
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-secondary" onClick={() => void load()}>
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>

      {!superAdmin && (        <div className="msg msg-warn" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ marginTop: 2 }}>
            <IconAlert size={15} />
          </span>
          <span>
            当前账号（{user?.username || '未知'}）不是超管角色：本页所有接口仅超管可调用（后端返回 403）。
            如确需查看/修改，请在「用户管理」里使用 admin 角色账号。
          </span>
        </div>
      )}
      {error && <div className="msg msg-err">加载失败：{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}
      {!keyConfigured && (
        <div className="msg msg-warn" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <span style={{ marginTop: 2 }}>
            <IconAlert size={15} />
          </span>
          <span>
            RUNTIME_CONFIG_KEY 未在服务端配置：列表无法判定「已配置/未配置」，保存与下发也会失败。
            请先在 provisioning-service 配置主密钥（与「运行时配置」同一把）。
          </span>
        </div>
      )}

      <div className="hint">
        安全约定：密钥保存后**不回显**（列表只显示「已配置/未配置 + 长度」），库里存的是 AES-256-GCM 密文（与「运行时配置」同一套密钥机制）。
        每次修改与每次下发都会写审计日志（谁 / 何时 / 改了哪个 key / 影响范围 / 结果，<b>不含值</b>）。
      </div>

      {/* ── 默认值编辑 ── */}
      {loading ? (
        <div className="panel">
          <div className="empty">加载中…</div>
        </div>
      ) : (
        grouped.map(([group, list]) => (
          <div className="panel" key={group}>
            <div className="panel-head">
              <div>
                <div className="panel-title">{GROUP_LABEL[group] || group}</div>
                <div className="panel-sub">
                  {group === 'secret'
                    ? '所有 Agent 同值；留空表示不修改，保存后不可查看原值'
                    : group === 'group'
                      ? '多群时第一个群自动设为主群'
                      : '预留分组（本期暂无已启用的默认项）'}
                </div>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 240 }}>Key</th>
                  <th style={{ width: 110 }}>状态</th>
                  <th>新值（保存后不回显）</th>
                  <th style={{ width: 190 }}>最近更新</th>
                </tr>
              </thead>
              <tbody>
                {list.map((it) => (
                  <tr key={it.key}>
                    <td>
                      <div className="cell-main mono" style={{ fontSize: 12 }}>
                        {it.key}
                      </div>
                      <div className="cell-sub" style={{ fontSize: 11 }}>{it.description || '-'}</div>
                    </td>
                    <td>
                      {it.configured ? (
                        <span className="badge badge-active">
                          已配置{it.length !== null ? ` · ${it.length} 字符` : ''}
                        </span>
                      ) : (
                        <span className="badge badge-failed">未配置</span>
                      )}
                    </td>
                    <td>
                      {it.group === 'group' ? (
                        <select
                          value={draft[it.key] ?? ''}
                          onChange={(e) => setDraft({ ...draft, [it.key]: e.target.value })}
                        >
                          <option value="">不修改（保持现值）</option>
                          <option value="first_group">first_group — 第一个群自动设为主群</option>
                          <option value="manual">manual — 不自动设主群（人工确认）</option>
                        </select>
                      ) : (
                        <input
                          type="password"
                          className="mono"
                          autoComplete="new-password"
                          value={draft[it.key] ?? ''}
                          placeholder="留空 = 不修改（新值保存后不可查看）"
                          onChange={(e) => setDraft({ ...draft, [it.key]: e.target.value })}
                        />
                      )}
                    </td>
                    <td style={{ fontSize: 11, color: '#777' }}>
                      {it.updatedAt ? new Date(it.updatedAt).toLocaleString() : '—'}
                      <div className="cell-sub">{it.updatedBy || '—'}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.length === 0 && <div className="empty">该分组暂无默认项（预留）</div>}
          </div>
        ))
      )}

      <div className="form-row" style={{ marginTop: 4 }}>
        <button className="btn-primary" onClick={() => void save()} disabled={saving || !superAdmin}>
          {saving ? '保存中…' : (<><IconSave /> 保存默认值（只影响新建 Agent）</>)}
        </button>
        <span className="hint" style={{ margin: 0 }}>
          待保存 {dirtyKeys.length} 项
        </span>
      </div>

      {/* ── 同步到存量 Agent ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        同步到存量 Agent（先 dryRun → 确认 → 下发）
      </div>
      <div className="form-row">
        <button className="btn-secondary" onClick={() => void runDryRun()} disabled={dryRunning || !superAdmin}>
          {dryRunning ? '计算中…' : '① 生成 dryRun 报告（只算不改）'}
        </button>
        <button className="btn-primary" onClick={() => void apply()} disabled={applying || !dryRun}>
          {applying ? '下发中…' : '③ 下发到勾选的 Agent'}
        </button>
        <button className="btn-secondary" onClick={toggleAllNeedsUpdate} disabled={!dryRun}>
          全选「需更新」
        </button>
      </div>

      {dryRun && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">② dryRun 报告（未做任何修改）</div>
              <div className="panel-sub">
                共 {dryRun.summary.total} 个 · 需更新 {dryRun.summary.needsUpdate} · 已最新 {dryRun.summary.upToDate} · 跳过 {dryRun.summary.skipped}
                {dryRun.summary.unconfiguredKeys.length > 0 && (
                  <> · 未配置（无法下发）：{dryRun.summary.unconfiguredKeys.join('、')}</>
                )}
              </div>
            </div>
            <div className="panel-meta">勾选 {Object.values(selected).filter(Boolean).length} 个</div>
          </div>
          {dryRun.tenants.length === 0 ? (
            <div className="empty">没有可下发的 Agent</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 46 }}>下发</th>
                  <th>Agent / 租户</th>
                  <th style={{ width: 110 }}>状态</th>
                  <th>差异 key</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {dryRun.tenants.map((t) => (
                  <tr key={t.tenantId}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={t.state !== 'needs_update'}
                        checked={Boolean(selected[t.tenantId])}
                        onChange={(e) => setSelected({ ...selected, [t.tenantId]: e.target.checked })}
                      />
                    </td>
                    <td>
                      <div className="cell-main">{t.companyName || '-'}</div>
                      <div className="cell-sub mono">{t.tenantId}</div>
                    </td>
                    <td>
                      {t.state === 'needs_update' ? (
                        <span className="badge badge-warn">需要更新</span>
                      ) : t.state === 'up_to_date' ? (
                        <span className="badge badge-active">已是最新</span>
                      ) : (
                        <span className="badge badge-dead">跳过</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {t.changedKeys.length ? t.changedKeys.join('、') : '—'}
                    </td>
                    <td style={{ fontSize: 12 }}>{t.detail || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {applyResult && (
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">下发回执</div>
              <div className="panel-sub">
                成功 {applyResult.succeeded} · 失败 {applyResult.failed} · 尝试 {applyResult.attempted}
              </div>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Agent / 租户</th>
                <th style={{ width: 100 }}>结果</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {applyResult.receipts.map((r) => (
                <tr key={r.tenantId}>
                  <td>
                    <div className="cell-main">{r.companyName || '-'}</div>
                    <div className="cell-sub mono">{r.tenantId}</div>
                  </td>
                  <td>
                    {r.ok ? (
                      <span className="badge badge-active">成功</span>
                    ) : (
                      <span className="badge badge-failed">失败</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.ok ? `已下发（rollout=${r.rollout || 'none'}）：约 1 分钟内生效` : r.error || '未知错误'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
