// LLM 推送进度弹窗（模型供应商页）。
//
// 保存/清空供应商库后，后端改为异步任务逐租户物化 + 滚动重启，本弹窗
// 订阅 SSE 实时展示推送进度：总体进度条 + 逐租户状态列表。终态后可对
// 失败租户一键重试（复用 POST .../retry 端点，重试会重新入队继续跑）。

import { useState } from 'react';
import Modal from './Modal';
import { api, errMsg } from '../lib/api';
import {
  useLlmPushTask,
  type LlmPushItem,
  type LlmPushTaskStatus,
} from '../hooks/useLlmPushTask';
import { IconRefresh } from './icons';

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

const ITEM_BADGE: Record<LlmPushItem['status'], string> = {
  pending: 'badge-pending',
  running: 'badge-provisioning',
  succeeded: 'badge-active',
  skipped: 'badge-warn',
  failed: 'badge-failed',
};

const ITEM_LABEL: Record<LlmPushItem['status'], string> = {
  pending: '等待',
  running: '推送中',
  succeeded: '已重启',
  skipped: '跳过',
  failed: '失败',
};

interface LlmPushProgressModalProps {
  taskId: string;
  onClose: () => void;
}

export default function LlmPushProgressModal({ taskId, onClose }: LlmPushProgressModalProps) {
  const { status, counts, items, hint, done, error, reload } = useLlmPushTask(taskId);
  const [retrying, setRetrying] = useState(false);
  const [retryMsg, setRetryMsg] = useState('');

  const completed = counts.succeeded + counts.skipped + counts.failed;
  const percent = counts.total > 0 ? Math.round((completed / counts.total) * 100) : (done ? 100 : 0);

  const barColor =
    status === 'failed' ? '#c0392b' : status === 'partial' ? '#d68910' : status === 'succeeded' ? '#27ae60' : '#3498db';

  const retryFailed = async () => {
    setRetrying(true);
    setRetryMsg('');
    try {
      const r = await api<{ ok: boolean; resetCount: number }>(
        `/v1/admin/llm-push-tasks/${encodeURIComponent(taskId)}/retry`,
        { method: 'POST' },
      );
      setRetryMsg(`已重新入队 ${r.resetCount} 个失败租户，继续推送中…`);
      reload();
    } catch (e) {
      setRetryMsg(`重试失败：${errMsg(e)}`);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Modal title={`推送进度 · ${taskId.slice(0, 8)}`} open onClose={onClose} width={720}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className={`badge ${TASK_BADGE[status]}`}>{TASK_LABEL[status]}</span>
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
        <span>成功 <b>{counts.succeeded}</b></span>
        <span>跳过 <b>{counts.skipped}</b></span>
        <span style={{ color: counts.failed > 0 ? '#c0392b' : undefined }}>
          失败 <b>{counts.failed}</b>
        </span>
        {percent < 100 && !done && (
          <span className="hint" style={{ margin: 0 }}>滚动重启约 1–2 分钟生效</span>
        )}
      </div>

      {hint && <div className="msg msg-ok" style={{ marginBottom: 10 }}>{hint}</div>}
      {error && <div className="msg msg-err" style={{ marginBottom: 10 }}>{error}</div>}
      {retryMsg && <div className="msg msg-ok" style={{ marginBottom: 10 }}>{retryMsg}</div>}

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
                <th style={{ width: 90 }}>状态</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.tenantId}>
                  <td className="mono">{it.tenantId}</td>
                  <td>
                    <span className={`badge ${ITEM_BADGE[it.status]}`}>{ITEM_LABEL[it.status]}</span>
                  </td>
                  <td style={{ fontSize: 11 }}>
                    {it.error ? (
                      <span style={{ color: '#c0392b' }}>{it.error}</span>
                    ) : it.status === 'succeeded' ? (
                      <>
                        agent{it.restarted ? ' 已重启' : ''}
                        {it.gatewayRestarted ? '、网关已重启' : ''}
                      </>
                    ) : it.status === 'skipped' ? (
                      '模型无变化，未重启'
                    ) : (
                      ''
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="hint" style={{ margin: 0 }}>
          {done ? '没有需要推送的租户' : '正在枚举租户…'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        {(status === 'partial' || status === 'failed') && (
          <button className="btn-secondary" disabled={retrying} onClick={() => void retryFailed()}>
            <IconRefresh /> {retrying ? '重试中…' : '重试失败租户'}
          </button>
        )}
        <button className="btn-primary" onClick={onClose}>
          {done ? '关闭' : '后台继续'}
        </button>
      </div>
    </Modal>
  );
}
