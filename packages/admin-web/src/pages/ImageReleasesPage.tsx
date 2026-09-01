// 镜像版本 — 从镜像仓库自动同步的镜像清单，可提升（promote）为滚动发布目标。
// Data: provisioning-service /v1/admin/image-releases (+ sync / promote / rollout-targets).
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

interface SyncServiceResult {
  service: string;
  ok: boolean;
  discovered: number;
  inserted: number;
  error?: string;
}

const SERVICES = ['dealclaw-agent', 'nexus-gateway'] as const;

export default function ImageReleasesPage() {
  const [releases, setReleases] = useState<ImageRelease[]>([]);
  const [targets, setTargets] = useState<RolloutTarget[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busyTag, setBusyTag] = useState('');
  const [syncing, setSyncing] = useState(false);

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

  const sync = useCallback(async (quiet = false): Promise<boolean> => {
    setSyncing(true);
    try {
      const r = await api<{ ok: boolean; results: SyncServiceResult[] }>(
        '/v1/admin/image-releases/sync',
        { method: 'POST' },
      );
      const summary = (r.results || [])
        .map((s) => `${s.service}: ${s.ok ? `发现 ${s.discovered} 个 tag，新增 ${s.inserted}` : `失败（${s.error}）`}`)
        .join('；');
      if (!quiet) flash(r.ok ? `同步完成 — ${summary}` : `部分失败 — ${summary}`);
      return r.ok;
    } catch (e) {
      if (!quiet) flash(`同步失败：${errMsg(e)}`);
      return false;
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    // 打开页面时后台自动同步一次（quiet），然后加载列表；失败不打扰用户。
    void (async () => {
      await sync(true);
      await load();
    })();
  }, [sync, load]);

  const promote = async (rel: ImageRelease) => {
    const down = isDowngrade(rel);
    const cur = currentBuildOf(rel.service);
    const next = buildNum(rel.buildNumber);
    const confirmMsg = down
      ? [
          '⚠️ 警告：这是一次版本回退操作！',
          '',
          `${rel.service} 当前滚动目标为 build #${cur}，将回退到 build #${next}（落后 ${cur! - next!} 个构建）。`,
          `旧版本可能缺少后续修复（如 /v1/llm 路由、安全补丁），回退后可能导致全部租户服务故障。`,
          '',
          '如非有意回滚，请点「取消」并选择列表顶部的最新版本。',
          '确认继续回退？',
        ].join('\n')
      : `确认将 ${rel.service} 的滚动发布目标提升为 ${rel.tag}？\n\nops-agent 会在下一个周期（约 10 分钟）把「所有租户」的该服务镜像更新到此版本。`;
    if (!window.confirm(confirmMsg)) return;
    setBusyTag(`${rel.service}:${rel.tag}`);
    try {
      await api('/v1/admin/image-releases/promote', {
        method: 'POST',
        body: { service: rel.service, tag: rel.tag },
      });
      flash(
        down
          ? `⚠ 已回退 ${rel.service} → ${rel.tag}（build #${cur} → #${next}），ops-agent 将滚动更新全部租户，请留意服务状态`
          : `已提升 ${rel.service} → ${rel.tag}，ops-agent 将自动滚动更新全部租户`,
      );
      await load();
    } catch (e) {
      flash(`提升失败：${errMsg(e)}`);
    } finally {
      setBusyTag('');
    }
  };

  const syncAndReload = async () => {
    const ok = await sync(false);
    if (ok) await load();
  };

  const visible = filter ? releases.filter((r) => r.service === filter) : releases;
  const targetOf = (service: string) => targets.find((t) => t.service === service)?.tag;

  // ── build 号比较：数值化 buildNumber（CI tag 格式 master.<sha>.<build>）──
  const buildNum = (n?: string | null): number | null =>
    n && /^\d+$/.test(n) ? Number(n) : null;

  /** 当前滚动目标的 build 号（从 release 列表里找 target tag 对应的行）。 */
  const currentBuildOf = (service: string): number | null => {
    const tag = targetOf(service);
    if (!tag) return null;
    const rel = releases.find((r) => r.service === service && r.tag === tag);
    return buildNum(rel?.buildNumber);
  };

  /** 该 release 是否为版本回退（build 号低于当前滚动目标）。 */
  const isDowngrade = (r: ImageRelease): boolean => {
    const cur = currentBuildOf(r.service);
    const next = buildNum(r.buildNumber);
    return cur !== null && next !== null && next < cur;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">镜像版本</div>
          <div className="page-sub">镜像 Tag 自动从镜像仓库同步入库；提升后由 ops-agent 滚动更新全部租户</div>
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
          <button className="btn-secondary" onClick={() => void load()} disabled={syncing}>
            <IconRefresh /> 刷新列表
          </button>
          <button className="btn-primary" onClick={() => void syncAndReload()} disabled={syncing}>
            <IconRefresh /> {syncing ? '同步中…' : '从镜像仓库同步'}
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

      {/* ── 版本列表 ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        版本列表（{visible.length}）
      </div>
      {visible.length === 0 ? (
        <div className="panel">
          <div className="empty">
            <IconBox size={18} /> 暂无镜像版本记录 — 点击「从镜像仓库同步」拉取已构建的镜像 Tag
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
                <th>来源</th>
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
                    {r.buildNumber ? `#${r.buildNumber}` : ''}{' '}
                    {r.gitCommit ? <span className="mono" style={{ color: '#888' }}>{r.gitCommit.slice(0, 8)}</span> : ''}
                  </td>
                  <td style={{ fontSize: 12 }}>{r.createdBy || '-'}</td>
                  <td style={{ fontSize: 11, color: '#777' }}>{fmtTime(r.createdAt)}</td>
                  <td>
                    {r.promoted || targetOf(r.service) === r.tag ? (
                      <span className="badge badge-active">滚动发布中</span>
                    ) : isDowngrade(r) ? (
                      <span className="badge badge-failed" title="此版本低于当前滚动目标，提升将回退全部租户">
                        回退旧版
                      </span>
                    ) : (
                      <span className="badge">已入库</span>
                    )}
                  </td>
                  <td>
                    {r.promoted ? (
                      <span style={{ fontSize: 12, color: '#999' }}>当前目标</span>
                    ) : (
                      <button
                        className={isDowngrade(r) ? 'btn-danger btn-sm' : 'btn-secondary btn-sm'}
                        disabled={busyTag === `${r.service}:${r.tag}`}
                        onClick={() => void promote(r)}
                        title={
                          isDowngrade(r)
                            ? `警告：build #${buildNum(r.buildNumber)} 低于当前目标 #${currentBuildOf(r.service)}，提升将导致全部租户回退到旧版本`
                            : undefined
                        }
                      >
                        <IconRocket size={12} /> {isDowngrade(r) ? '回退发布' : '提升发布'}
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
        流程：Jenkins 构建推送镜像 → 镜像 Tag 自动从镜像仓库同步入库（每 30
        分钟，或手动点击「从镜像仓库同步」）→ 在此页「提升发布」→ ops-agent 每 10
        分钟巡检，把全部租户的对应服务滚动更新到目标版本。单个租户可在其客户详情页单独更新。
      </div>
    </>
  );
}
