// 镜像版本 — Jenkins 构建入库的镜像清单，可提升（promote）为滚动发布目标。
// Data: provisioning-service /v1/admin/image-releases (+ promote / rollout-targets).
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import type { ImageRelease } from '../lib/types';
import { fmtTime } from '../components/badges';
import { IconBox, IconRefresh, IconRocket } from '../components/icons';

interface RolloutTarget {
  service: string;
  tag: string;
  updatedBy?: string | null;
  updatedAt?: string;
}

const SERVICES = ['dealclaw-agent', 'nexus-gateway'] as const;

export default function ImageReleasesPage() {
  const [releases, setReleases] = useState<ImageRelease[]>([]);
  const [targets, setTargets] = useState<RolloutTarget[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busyTag, setBusyTag] = useState('');

  // 手动登记表单
  const [formService, setFormService] = useState<string>('dealclaw-agent');
  const [formTag, setFormTag] = useState('');
  const [formCommit, setFormCommit] = useState('');
  const [saving, setSaving] = useState(false);

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 6000);
  };

  const load = useCallback(async () => {
    try {
      const r = await api<{ releases: ImageRelease[]; rolloutTargets: RolloutTarget[] }>(
        '/v1/admin/image-releases?limit=100',
      );
      setReleases(r.releases || []);
      setTargets(r.rolloutTargets || []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const promote = async (rel: ImageRelease) => {
    if (
      !window.confirm(
        `确认将 ${rel.service} 的滚动发布目标提升为 ${rel.tag}？\n\nops-agent 会在下一个周期（约 10 分钟）把「所有租户」的该服务镜像更新到此版本。`,
      )
    )
      return;
    setBusyTag(`${rel.service}:${rel.tag}`);
    try {
      await api('/v1/admin/image-releases/promote', {
        method: 'POST',
        body: { service: rel.service, tag: rel.tag },
      });
      flash(`已提升 ${rel.service} → ${rel.tag}，ops-agent 将自动滚动更新全部租户`);
      await load();
    } catch (e) {
      flash(`提升失败：${errMsg(e)}`);
    } finally {
      setBusyTag('');
    }
  };

  const recordManual = async () => {
    const tag = formTag.trim();
    if (!tag) {
      flash('镜像 Tag 为必填');
      return;
    }
    setSaving(true);
    try {
      const r = await api<{ created: boolean; image: string }>('/v1/admin/image-releases', {
        method: 'POST',
        body: {
          service: formService,
          tag,
          gitCommit: formCommit.trim() || undefined,
          createdBy: 'admin-manual',
        },
      });
      flash(r.created ? `已登记 ${r.image}` : `${formService}:${tag} 已存在，无需重复登记`);
      setFormTag('');
      setFormCommit('');
      await load();
    } catch (e) {
      flash(`登记失败：${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const visible = filter ? releases.filter((r) => r.service === filter) : releases;
  const targetOf = (service: string) => targets.find((t) => t.service === service)?.tag;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">镜像版本</div>
          <div className="page-sub">Jenkins 构建自动入库；提升后由 ops-agent 滚动更新全部租户</div>
        </div>
        <div className="page-actions">
          <select aria-label="服务筛选" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">全部服务</option>
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button className="btn-secondary" onClick={() => void load()}>
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>
      {error && <div className="msg msg-err">{error}</div>}
      {msg && <div className="msg msg-ok">{msg}</div>}

      {/* ── 当前滚动发布目标 ── */}
      <div className="stat-grid">
        {SERVICES.map((s) => (
          <div className="stat-card" key={s}>
            <div className="num mono" style={{ fontSize: 15 }}>
              {targetOf(s) || <span style={{ color: '#999' }}>未设置（使用环境变量）</span>}
            </div>
            <div className="label">{s} 滚动发布目标</div>
          </div>
        ))}
      </div>

      {/* ── 手动登记 ── */}
      <div className="form-card">
        <div style={{ fontSize: 14, color: '#171c2e', fontWeight: 700, marginBottom: 10 }}>
          手动登记镜像（Jenkins 构建会自动登记，此处仅作补录）
        </div>
        <div className="form-row">
          <label className="field-label">服务</label>
          <select value={formService} onChange={(e) => setFormService(e.target.value)}>
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="text"
            className="mono"
            style={{ flex: 1, minWidth: 200 }}
            value={formTag}
            onChange={(e) => setFormTag(e.target.value)}
            placeholder="镜像 Tag，如 master.e3d43339.12"
          />
          <input
            type="text"
            className="mono"
            style={{ width: 160 }}
            value={formCommit}
            onChange={(e) => setFormCommit(e.target.value)}
            placeholder="Git Commit（可选）"
          />
          <button className="btn-primary" onClick={() => void recordManual()} disabled={saving}>
            {saving ? '登记中…' : '登记入库'}
          </button>
        </div>
      </div>

      {/* ── 版本列表 ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        版本列表（{visible.length}）
      </div>
      {visible.length === 0 ? (
        <div className="panel">
          <div className="empty">
            <IconBox size={18} /> 暂无镜像版本记录 — Jenkins 构建推送后将自动出现在这里
          </div>
        </div>
      ) : (
        <div className="panel">
          <table>
            <thead>
              <tr>
                <th>服务</th>
                <th>Tag</th>
                <th>构建信息</th>
                <th>登记方</th>
                <th>入库时间</th>
                <th>状态</th>
                <th style={{ width: 130 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {r.service}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }} title={r.image}>
                    {r.tag}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.buildEnv ? <span className="badge badge-pending">{r.buildEnv}</span> : null}{' '}
                    {r.buildNumber ? `#${r.buildNumber}` : ''}{' '}
                    {r.gitCommit ? <span className="mono" style={{ color: '#888' }}>{r.gitCommit.slice(0, 8)}</span> : ''}
                  </td>
                  <td style={{ fontSize: 12 }}>{r.createdBy || '-'}</td>
                  <td style={{ fontSize: 11, color: '#777' }}>{fmtTime(r.createdAt)}</td>
                  <td>
                    {r.promoted ? (
                      <span className="badge badge-active">滚动发布中</span>
                    ) : targetOf(r.service) === r.tag ? (
                      <span className="badge badge-active">滚动发布中</span>
                    ) : (
                      <span className="badge">已入库</span>
                    )}
                  </td>
                  <td>
                    {r.promoted ? (
                      <span style={{ fontSize: 12, color: '#999' }}>当前目标</span>
                    ) : (
                      <button
                        className="btn-secondary btn-sm"
                        disabled={busyTag === `${r.service}:${r.tag}`}
                        onClick={() => void promote(r)}
                      >
                        <IconRocket size={12} /> 提升发布
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">
        流程：Jenkins 构建推送镜像 → 自动登记入库 → 在此页「提升发布」→ ops-agent 每 10
        分钟巡检，把全部租户的对应服务滚动更新到目标版本。单个租户可在其客户详情页单独更新。
      </div>
    </>
  );
}
