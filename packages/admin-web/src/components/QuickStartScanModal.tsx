// 「一键开通小元」结果面板 — 展示飞书扫码二维码 + 实时状态。
//
// 与「添加 Agent」里的 FeishuAppScanModal 的差别：这里的扫码会话是后端
// quick-start 流水线创建的（POST /v1/admin/onboarding/quick-start 已经拿到
// deviceCode/qrUrl），前端只轮询 + 展示，不再自己 start；
// 同时显示本次开通结果的租户/供应商信息，方便 FDE 核对。
import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from '../components/Modal';
import { api } from '../lib/api';
import { IconRefresh } from '../components/icons';
import type { QuickStartResponse } from '../lib/types';

interface ScanStatusResp {
  ok: true;
  deviceCode: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  message: string;
  result?: { appId: string; appSecret: string };
  error?: string;
}

const POLL_INTERVAL_MS = 2500;

interface Props {
  open: boolean;
  /** quick-start 的成功响应（deviceCode / qrDataUri / expireIn / tenantId …）。 */
  result: QuickStartResponse | null;
  onClose: () => void;
  /** 扫码完成拿到凭据后的下一步（例如去 Agent 详情页绑定）。 */
  onCompleted?: (appId: string, appSecret: string) => void;
}

export default function QuickStartScanModal({ open, result, onClose, onCompleted }: Props) {
  const [status, setStatus] = useState<string>('pending');
  const [message, setMessage] = useState('请客户用飞书 App 扫描二维码并确认创建应用');
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);

  const stopTimers = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const poll = useCallback(async () => {
    const deviceCode = result?.deviceCode;
    if (!deviceCode || stoppedRef.current) return;
    try {
      const r = await api<ScanStatusResp>(
        `/v1/admin/feishu-app/scan/status/${encodeURIComponent(deviceCode)}`,
      );
      if (stoppedRef.current) return;
      setStatus(r.status);
      if (r.status === 'completed' && r.result) {
        stopTimers();
        setMessage('应用创建成功，飞书凭据已获取——在客户详情页完成绑定后即可自动开通 Agent');
        onCompleted?.(r.result.appId, r.result.appSecret);
        return;
      }
      if (r.status === 'failed' || r.status === 'cancelled') {
        stopTimers();
        setError(r.message || '扫码失败，请重试');
        return;
      }
      setMessage(r.message || '请客户用飞书 App 扫描二维码并确认创建应用');
      if (!stoppedRef.current) pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (e) {
      if (stoppedRef.current) return;
      if ((e as { status?: number }).status === 404) {
        stopTimers();
        setError('二维码已过期或会话失效（服务重启会丢失扫描会话），可在「添加 Agent」里重新扫码');
        return;
      }
      pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS * 2);
    }
  }, [onCompleted, result?.deviceCode, stopTimers]);

  useEffect(() => {
    stoppedRef.current = !open;
    if (!open || !result) {
      stopTimers();
      return;
    }
    setError('');
    setStatus(result.scanStatus || 'pending');
    setMessage(result.scanMessage || '请客户用飞书 App 扫描二维码并确认创建应用');
    const expireIn = result.expireIn || 600;
    const exp = Date.now() + expireIn * 1000;
    setCountdown(Math.max(0, Math.floor((exp - Date.now()) / 1000)));
    countdownTimerRef.current = setInterval(() => {
      const left = Math.max(0, Math.floor((exp - Date.now()) / 1000));
      setCountdown(left);
      if (left <= 0 && countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    }, 1000);
    pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stoppedRef.current = true;
      stopTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, result?.deviceCode]);

  const restart = () => {
    stopTimers();
    stoppedRef.current = false;
    pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  };

  const expired = status === 'pending' && countdown <= 0;

  if (!result) return null;

  return (
    <Modal title="一键开通小元 · 扫码创建飞书应用" open={open} onClose={onClose} width={460}>
      {error && <div className="msg msg-err">{error}</div>}
      <div className="panel" style={{ marginBottom: 10 }}>
        <table>
          <tbody>
            <tr>
              <td style={{ width: 110, fontSize: 12 }}>租户 ID</td>
              <td className="mono" style={{ fontSize: 12 }}>{result.tenantId}</td>
            </tr>
            <tr>
              <td style={{ fontSize: 12 }}>米奥供应商</td>
              <td className="mono" style={{ fontSize: 12 }}>
                {result.supplierId}
                {result.supplier?.created ? '（本次新建）' : '（命中已有）'}
                {result.supplier?.name ? ` · ${result.supplier.name}` : ''}
              </td>
            </tr>
            <tr>
              <td style={{ fontSize: 12 }}>Agent 状态</td>
              <td style={{ fontSize: 12 }}>
                <span className={`badge ${result.status === 'active' ? 'badge-active' : 'badge-pending'}`}>
                  {result.status}
                </span>
                {!result.provisioned && (
                  <span className="hint" style={{ marginLeft: 8 }}>
                    待客户扫码拿到飞书凭据后自动开通（先建客户记录）
                  </span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ textAlign: 'center', padding: '4px 0' }}>
        {result.qrDataUri ? (
          <img
            src={result.qrDataUri}
            alt="飞书扫码二维码"
            width={220}
            height={220}
            style={{ borderRadius: 12, filter: expired ? 'blur(3px) opacity(0.4)' : 'none' }}
          />
        ) : (
          <div
            style={{
              width: 220,
              height: 220,
              margin: '0 auto',
              borderRadius: 12,
              background: 'var(--panel-2, #f5f6f8)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#999',
              fontSize: 13,
            }}
          >
            二维码不可用
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: 13 }}>
          {status === 'completed' ? (
            <span style={{ color: '#16a34a' }}>✅ {message}</span>
          ) : expired ? (
            <span style={{ color: '#d97706' }}>二维码已过期，请重新发起一键开通</span>
          ) : (
            <span>{message}</span>
          )}
        </div>
        {status === 'pending' && !expired && countdown > 0 && (
          <div className="hint" style={{ margin: '6px 0 0' }}>
            有效期剩余 {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
          </div>
        )}
      </div>

      {(result.warnings || []).length > 0 && (
        <div className="msg msg-warn" style={{ fontSize: 12 }}>
          {(result.warnings || []).map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      <div className="hint">
        客户扫码确认后飞书会在其企业内创建「DealClaw AI销售助手」应用；凭据自动进入绑定流程，
        无需再到飞书开放平台手工复制。
      </div>

      <div className="form-row" style={{ marginTop: 12, justifyContent: 'center' }}>
        {(status === 'failed' || status === 'cancelled') && (
          <button className="btn-secondary" onClick={restart}>
            <IconRefresh /> 重新查询状态
          </button>
        )}
        <button className="btn-secondary" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
