// Rollout batch（镜像滚动发布）进度弹窗。
//
// 订阅 SSE 实时展示滚动发布进度：总体进度条 + 逐租户状态列表。终态后关闭。
// 与 LlmPushProgressModal 同构，但 item 含 already_current / pinned 两种额外
// 终态，并展示 deployment 名与镜像 tag。

import Modal from './Modal';
import {
  useRolloutTask,
  type RolloutItemStatus,
  type RolloutTaskStatus,
} from '../hooks/useRolloutTask';
import { shortId } from './badges';

const TASK_LABEL: Record<RolloutTaskStatus, string> = {
  pending: '排队中',
  running: '发布中',
  succeeded: '已完成',
  partial: '部分失败',
  failed: '失败',
  cancelled: '已取消',
};

const TASK_BADGE: Record<RolloutTaskStatus, string> = {
  pending: 'badge-pending',
  running: 'badge-provisioning',
  succeeded: 'badge-active',
  partial: 'badge-warn',
  failed: 'badge-failed',
  cancelled: 'badge-dead',
};

const ITEM_BADGE: Record<RolloutItemStatus, string> = {
  pending: 'badge-pending',
  running: 'badge-provisioning',
  succeeded: 'badge-active',
  already_current: 'badge-active',
  pinned: 'badge-warn',
  skipped: 'badge-warn',
  failed: 'badge-failed',
};

const ITEM_LABEL: Record<RolloutItemStatus, string> = {
  pending: '等待',
  running: '更新中',
  succeeded: '已更新',
  already_current: '已是最新',
  pinned: '已跳过(pin)',
  skipped: '跳过',
  failed: '失败',
};

interface RolloutProgressModalProps {
  taskId: string;
  onClose: () => void;
}

export default function RolloutProgressModal({ taskId, onClose }: RolloutProgressModalProps) {
  const { status, task, counts, items, done, error } = useRolloutTask(taskId);

  const completed = counts.succeeded + counts.alreadyCurrent + counts.pinned + counts.skipped + counts.failed;
  const percent = counts.total > 0 ? Math.round((completed / counts.total) * 100) : (done ? 100 : 0);

  const barColor =
    status === 'failed' ? '#c0392b' : status === 'partial' ? '#d68910' : status === 'succeeded' ? '#27ae60' : '#3498db';

  return (
    <Modal title={`发布进度 · ${taskId.slice(0, 8)}`} open onClose={onClose} width={720}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className={`badge ${TASK_BADGE[status]}`}>{TASK_LABEL[status]}</span>
        {task && (
          <span className="mono" style={{ fontSize: 12 }}>
            {task.service} → {task.tag}
          </span>
        )}
        <span className="mono" style={{ fontSize: 12 }}>
          {completed}/{counts.total} 租户
        </span>
        <span className="hint" style={{ margin: 0, marginLeft: 'auto' }}>
          {done ? '任务已结束' : '实时更新中…'}
        </span>
      </div>

      {/* 进度条 */}
      <div
        style={{
          height: 10,
          background: '#eef1f6',
          borderRadius: 6,
          overflow: 'hidden',
          marginBottom: 8,
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            background: barColor,
            transition: 'width 0.3s ease',
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12 }}>
        <span>已更新 <b>{counts.succeeded}</b></span>
        <span>已是最新 <b>{counts.alreadyCurrent}</b></span>
        <span>跳过(pin) <b>{counts.pinned}</b></span>
        <span>跳过 <b>{counts.skipped}</b></span>
        <span style={{ color: counts.failed > 0 ? '#c0392b' : undefined }}>
          失败 <b>{counts.failed}</b>
        </span>
      </div>

      {error && <div className="msg msg-err" style={{ marginBottom: 10 }}>{error}</div>}

      {/* 逐租户列表 */}
      {items.length > 0 ? (
        <div
          style={{
            maxHeight: 320,
            overflowY: 'auto',
            border: '1px solid #eef1f6',
            borderRadius: 6,
          }}
        >
          <table style={{ margin: 0 }}>
            <thead>
              <tr>
                <th>租户</th>
                <th>Deployment</th>
                <th style={{ width: 90 }}>状态</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.tenantId}>
                  <td className="mono">{shortId(it.tenantId)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{it.deployment}</td>
                  <td>
                    <span className={`badge ${ITEM_BADGE[it.status]}`}>{ITEM_LABEL[it.status]}</span>
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {it.error ? <span style={{ color: '#c0392b' }}>{it.error}</span> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="hint" style={{ margin: 0 }}>
          {done
            ? '没有需要发布的租户'
            : status === 'pending'
              ? '排队中，等待前序任务完成…'
              : '正在枚举租户…'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn-primary" onClick={onClose}>
          {done ? '关闭' : '后台继续'}
        </button>
      </div>
    </Modal>
  );
}
