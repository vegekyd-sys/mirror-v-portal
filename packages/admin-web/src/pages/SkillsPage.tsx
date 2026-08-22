// Skill 管理 — migrated from legacy admin-dashboard/public/admin-skills.html.
// Data: credits-ledger /v1/admin/skills (list/pending/sync/activate/launch/reject).
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { fmtNum } from '../components/badges';
import { IconRefresh, IconSearch } from '../components/icons';

interface Skill {
  skillId: string;
  skillName?: string;
  description?: string | null;
  category?: string | null;
  creditPerUnit?: number;
  cost?: number;
  activationStatus?: 'pending' | 'approved' | 'rejected' | string;
  responsiblePerson?: string | null;
  approvedBy?: string | null;
  status?: 'live' | 'shadow' | 'disabled' | string;
}

interface SyncResult {
  ok?: boolean;
  totalScanned?: number;
  registered?: { skillId: string }[];
  skipped?: number;
  errors?: string[];
}

export default function SkillsPage() {
  const [pending, setPending] = useState<Skill[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [opLogs, setOpLogs] = useState<{ t: string; text: string; err?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 6000);
  };

  const log = (text: string, err = false) => {
    setOpLogs((prev) => [{ t: new Date().toLocaleTimeString(), text, err }, ...prev]);
  };

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        api<{ skills: Skill[] }>('/v1/admin/skills/pending'),
        api<{ skills: Skill[] }>('/v1/admin/skills'),
      ]);
      setPending(p.skills || []);
      setSkills(a.skills || []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setBusy(true);
    try {
      const r = await api<SyncResult>('/v1/admin/skills/sync', { method: 'POST', body: {} });
      const created = r.registered?.length ?? 0;
      flash(
        `扫描完成：共 ${r.totalScanned ?? 0} 个，新注册 ${created}，跳过 ${r.skipped ?? 0}${
          r.errors?.length ? `，错误 ${r.errors.length}` : ''
        }`,
      );
      log(`扫描注册：新 ${created}，跳过 ${r.skipped ?? 0}`);
      if (r.errors?.length) log(`扫描错误：${r.errors.join('; ')}`, true);
      await load();
    } catch (e) {
      flash(`扫描失败：${errMsg(e)}`);
      log(`扫描失败：${errMsg(e)}`, true);
    } finally {
      setBusy(false);
    }
  };

  const act = async (skill: Skill, action: 'activate' | 'launch' | 'reject') => {
    const name = skill.skillName || skill.skillId;
    const prompts: Record<typeof action, string> = {
      activate: `确认审核通过「${name}」？（转为影子计费，只记录不扣费）`,
      launch: `确认正式上线「${name}」并开始正式计费（扣费）？`,
      reject: `确认停用「${name}」？`,
    };
    if (!window.confirm(prompts[action])) return;
    try {
      await api(`/v1/admin/skills/${encodeURIComponent(skill.skillId)}/${action}`, {
        method: 'POST',
        body: {},
      });
      const done: Record<typeof action, string> = {
        activate: `已审核通过「${name}」（影子计费）`,
        launch: `「${name}」已上线，开始计费`,
        reject: `已停用「${name}」`,
      };
      flash(done[action]);
      log(done[action]);
      await load();
    } catch (e) {
      flash(`操作失败：${errMsg(e)}`);
      log(`操作失败 ${action} ${skill.skillId}: ${errMsg(e)}`, true);
    }
  };

  const activationBadge = (s?: string) => {
    if (s === 'pending') return <span className="badge badge-pending">待审核</span>;
    if (s === 'approved') return <span className="badge badge-active">已审核</span>;
    if (s === 'rejected') return <span className="badge badge-failed">已拒绝</span>;
    return <span className="badge badge-dead">{s || '-'}</span>;
  };

  const statusBadge = (s?: string) => {
    if (s === 'live') return <span className="badge badge-active">正式计费</span>;
    if (s === 'shadow') return <span className="badge badge-pending">影子计费</span>;
    return <span className="badge badge-dead">{s || '-'}</span>;
  };

  return (
    <>
      <div className="section-title">Skill 管理</div>
      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}

      <div className="action-bar">
        <button className="btn-secondary" onClick={() => void load()}>
          <IconRefresh /> 刷新
        </button>
        <button className="btn-primary" onClick={() => void sync()} disabled={busy}>
          {busy ? '扫描中…' : (<><IconSearch /> 扫描 SKILL.md 注册新 Skill</>)}
        </button>
      </div>

      {/* ── 待审核 ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        待审核 Skill（新注册）{pending.length > 0 ? ` — ${pending.length} 个` : ''}
      </div>
      {pending.length === 0 ? (
        <div className="empty">暂无待审核 Skill</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Skill ID</th>
              <th>名称</th>
              <th>分类</th>
              <th>单价(credits)</th>
              <th>负责人</th>
              <th style={{ width: 180 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((s) => (
              <tr key={s.skillId}>
                <td className="mono" style={{ fontSize: 11 }}>
                  {s.skillId}
                </td>
                <td>{s.skillName || '-'}</td>
                <td>{s.category || '-'}</td>
                <td className="mono">{fmtNum(s.creditPerUnit)}</td>
                <td>{s.responsiblePerson || '-'}</td>
                <td>
                  <button className="btn-primary btn-sm" onClick={() => void act(s, 'activate')}>
                    审核通过
                  </button>{' '}
                  <button className="btn-danger btn-sm" onClick={() => void act(s, 'reject')}>
                    拒绝
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ── 全部 ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        全部 Skill — {skills.length} 个
      </div>
      {skills.length === 0 ? (
        <div className="empty">暂无已注册 Skill</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Skill ID</th>
              <th>名称</th>
              <th>分类</th>
              <th>单价(credits)</th>
              <th>审核状态</th>
              <th>计费状态</th>
              <th>负责人</th>
              <th>审批人</th>
              <th style={{ width: 200 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.skillId}>
                <td className="mono" style={{ fontSize: 11 }}>
                  {s.skillId}
                </td>
                <td>{s.skillName || '-'}</td>
                <td>{s.category || '-'}</td>
                <td className="mono">{fmtNum(s.creditPerUnit)}</td>
                <td>{activationBadge(s.activationStatus)}</td>
                <td>{statusBadge(s.status)}</td>
                <td>{s.responsiblePerson || '-'}</td>
                <td>{s.approvedBy || '-'}</td>
                <td>
                  {s.activationStatus === 'approved' && s.status !== 'live' && (
                    <button className="btn-primary btn-sm" onClick={() => void act(s, 'launch')}>
                      上线计费
                    </button>
                  )}{' '}
                  {s.activationStatus === 'rejected' && (
                    <button className="btn-secondary btn-sm" onClick={() => void act(s, 'activate')}>
                      重新审核
                    </button>
                  )}{' '}
                  {s.activationStatus === 'approved' && (
                    <button className="btn-danger btn-sm" onClick={() => void act(s, 'reject')}>
                      停用
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
