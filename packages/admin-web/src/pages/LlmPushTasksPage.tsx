// LLM 推送异步任务 — 历史任务列表页。
//
// 模型供应商配置的保存/删除/单租户选择在后端都是异步任务（逐租户物化 +
// 滚动重启），本页集中展示这些任务的执行状态。Data:
// provisioning-service GET /v1/admin/llm-push-tasks。
//
// 列表接口没有 SSE，改用轻量轮询：默认每 4 秒刷新当前页。点击某任务打开
// 复用 LlmPushProgressModal 的实时 SSE 详情（含逐租户 items + 失败重试）。
// 终态任务支持「重试失败租户」，运行中/排队中任务支持「取消」。

import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../lib/api';
import { fmtTime, shortId } from '../components/badges';
import { IconBox, IconRefresh } from '../components/icons';
import LlmPushProgressModal from '../components/LlmPushProgressModal';
import type { LlmPushTaskStatus } from '../hooks/useLlmPushTask';

interface LlmPushTaskView {
  id: string;
  kind: 'global_push' | 'tenant_push';
  scope: string | null;
  trigger: 'save' | 'delete' | 'selection' | 'retry';
  status: LlmPushTaskStatus;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const PAGE_SIZE = 50;
const AUTO_REFRESH_MS = 4000;

const TASK_LABEL: Record<LlmPushTaskStatus, string> = {
  pending: '排队中',
  running: '推送中',
  succeeded: '已完成',
  partial: '部分失败',
  failed: '失败',
  cancelled: '已取消',
};

const TASK_BADGE: Record<LlmPushTaskStatus, string> = {
  pending: 'badge-pending',
  running: 'badge-provisioning',
  succeeded: 'badge-active',
  partial: 'badge-warn',
  failed: 'badge-failed',
  cancelled: 'badge-dead',
};

const KIND_LABEL: Record<LlmPushTaskView['kind'], string> = {
  global_push: '全局推送',
  tenant_push: '单租户推送',
};

const TRIGGER_LABEL: Record<LlmPushTaskView['trigger'], string> = {
  save: '保存配置',
  delete: '删除配置',
  selection: '单租户选择',
  retry: '重试',
};

const TERMINAL: readonly LlmPushTaskStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];
const isTerminal = (s: LlmPushTaskStatus) => (TERMINAL as readonly string[]).includes(s);

/** 从 startedAt/finishedAt 计算耗时（无 startedAt 用 createdAt）。 */
function duration(t: LlmPushTaskView): string {
  const start = t.startedAt ? new Date(t.startedAt).getTime() : new Date(t.createdAt).getTime();
  const end = t.finishedAt ? new Date(t.finishedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '-';
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h${Math.round((ms % 3_600_000) / 60_000)}m`;
}

function barColor(status: LlmPushTaskStatus): string {
  if (status === 'failed') return '#c0392b';
  if (status === 'partial') return '#d68910';
  if (status === 'succeeded') return '#27ae60';
  if (status === 'cancelled') return '#8494ad';
  return '#3498db';
}

export default function LlmPushTasksPage() {
  const [tasks, setTasks] = useState<LlmPushTaskView[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState('');

  const load = useCallback(
    async (pageOffset: number) => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(pageOffset) });
        if (statusFilter) q.set('status', statusFilter);
        const r = await api<{ tasks: LlmPushTaskView[]; total: number }>(
          `/v1/admin/llm-push-tasks?${q.toString()}`,
        );
        setTasks(r.tasks || []);
        setTotal(r.total || 0);
        setOffset(pageOffset);
        setError('');
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动轮询：仅在开启开关时按固定间隔刷新当前页（列表接口轻量）。
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => void load(offset), AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, offset, load]);

  const retryTask = async (id: string) => {
    setBusyId(id);
    setActionMsg('');
    try {
      const r = await api<{ ok: boolean; resetCount: number }>(
        `/v1/admin/llm-push-tasks/${encodeURIComponent(id)}/retry`,
        { method: 'POST' },
      );
      setActionMsg(`已重新入队 ${r.resetCount} 个失败租户，继续推送中…`);
      await load(offset);
    } catch (e) {
      setActionMsg(`重试失败：${errMsg(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const cancelTask = async (id: string) => {
    if (!window.confirm('确定取消该任务？运行中的任务会在当前租户完成后停止。')) return;
    setBusyId(id);
    setActionMsg('');
    try {
      await api(`/v1/admin/llm-push-tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      setActionMsg('已提交取消请求');
      await load(offset);
    } catch (e) {
      setActionMsg(`取消失败：${errMsg(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = tasks.filter((t) => !isTerminal(t.status)).length;
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="section-title">异步任务</div>
          <div className="page-sub">
            模型供应商配置的保存 / 删除 / 单租户选择均为异步任务，逐租户物化并滚动重启。此处集中展示执行状态
          </div>
        </div>
        <div className="page-actions">
          <label style={{ fontSize: 12, color: '#666', display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            自动刷新（4s）
          </label>
          <button className="btn-secondary" onClick={() => void load(offset)} disabled={loading}>
            <IconRefresh /> 刷新
          </button>
        </div>
      </div>
      {error && <div className="msg msg-err">{error}</div>}
      {actionMsg && <div className="msg msg-ok">{actionMsg}</div>}

      {/* ── 过滤器 ── */}
      <div className="panel" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 12 }}>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setOffset(0);
            void load(0);
          }}
          style={{ minWidth: 160 }}
        >
          <option value="">全部状态</option>
          <option value="pending">排队中</option>
          <option value="running">推送中</option>
          <option value="succeeded">已完成</option>
          <option value="partial">部分失败</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
        </select>
        <span className="hint" style={{ margin: 0 }}>
          {activeCount > 0 ? `当前 ${activeCount} 个任务正在排队或执行中` : '无进行中的任务'}
        </span>
      </div>

      {/* ── 列表 ── */}
      <div className="section-title" style={{ fontSize: 14 }}>
        任务（共 {total.toLocaleString()} 条 · 第 {page}/{pageCount} 页）
      </div>
      {loading && <div className="page-loading">加载中…</div>}
      {!loading && tasks.length === 0 ? (
        <div className="panel">
          <div className="empty">
            <IconBox size={18} /> 暂无异步任务
          </div>
        </div>
      ) : (
        !loading && (
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 150 }}>任务</th>
                  <th style={{ width: 110 }}>类型</th>
                  <th style={{ width: 100 }}>触发</th>
                  <th style={{ width: 110 }}>状态</th>
                  <th style={{ minWidth: 200 }}>进度</th>
                  <th style={{ width: 150 }}>创建时间</th>
                  <th style={{ width: 80 }}>耗时</th>
                  <th style={{ width: 160 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => {
                  const completed = t.succeededCount + t.skippedCount + t.failedCount;
                  const percent = t.totalCount > 0 ? Math.round((completed / t.totalCount) * 100) : (isTerminal(t.status) ? 100 : 0);
                  return (
                    <tr key={t.id}>
                      <td>
                        <a
                          href="#"
                          className="mono"
                          style={{ fontSize: 12 }}
                          title={t.id}
                          onClick={(e) => {
                            e.preventDefault();
                            setDetailId(t.id);
                          }}
                        >
                          {shortId(t.id)}
                        </a>
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {KIND_LABEL[t.kind]}
                        {t.kind === 'tenant_push' && t.scope && (
                          <div className="hint" style={{ margin: 0, fontSize: 10 }} title={t.scope}>
                            {shortId(t.scope)}
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>{TRIGGER_LABEL[t.trigger]}</td>
                      <td>
                        <span className={`badge ${TASK_BADGE[t.status]}`}>{TASK_LABEL[t.status]}</span>
                        {t.error && (
                          <div
                            className="hint"
                            style={{ margin: 0, fontSize: 10, color: '#c0392b', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={t.error}
                          >
                            {t.error}
                          </div>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 8, background: '#eef1f6', borderRadius: 5, overflow: 'hidden' }}>
                            <div
                              style={{
                                width: `${percent}%`,
                                height: '100%',
                                background: barColor(t.status),
                                transition: 'width 0.3s ease',
                              }}
                            />
                          </div>
                          <span className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                            {completed}/{t.totalCount}
                          </span>
                        </div>
                        <div style={{ fontSize: 10, color: '#8494ad', marginTop: 3 }}>
                          成功 {t.succeededCount} · 跳过 {t.skippedCount}
                          {t.failedCount > 0 && <span style={{ color: '#c0392b' }}> · 失败 {t.failedCount}</span>}
                        </div>
                      </td>
                      <td style={{ fontSize: 11, color: '#555' }}>{fmtTime(t.createdAt)}</td>
                      <td style={{ fontSize: 11, color: '#555' }}>{duration(t)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button className="btn-secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setDetailId(t.id)}>
                            详情
                          </button>
                          {(t.status === 'partial' || t.status === 'failed') && (
                            <button
                              className="btn-secondary"
                              style={{ padding: '2px 8px', fontSize: 11 }}
                              disabled={busyId === t.id}
                              onClick={() => void retryTask(t.id)}
                            >
                              重试
                            </button>
                          )}
                          {(t.status === 'pending' || t.status === 'running') && (
                            <button
                              className="btn-secondary"
                              style={{ padding: '2px 8px', fontSize: 11, color: '#c0392b' }}
                              disabled={busyId === t.id}
                              onClick={() => void cancelTask(t.id)}
                            >
                              取消
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ── 分页 ── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
        <button className="btn-secondary" disabled={offset === 0} onClick={() => void load(Math.max(offset - PAGE_SIZE, 0))}>
          上一页
        </button>
        <button
          className="btn-secondary"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => void load(offset + PAGE_SIZE)}
        >
          下一页
        </button>
      </div>

      <div className="hint">
        任务保留 30 天自动清理。点击任务 ID 或「详情」可查看逐租户实时进度；终态任务可重试失败租户（重新入队继续跑），排队中/运行中任务可协作式取消。
      </div>

      {detailId && <LlmPushProgressModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </>
  );
}
