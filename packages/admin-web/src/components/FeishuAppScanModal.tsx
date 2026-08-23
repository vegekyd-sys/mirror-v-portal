// 飞书扫码获取应用凭据 — 供「创建客户」与「客户详情-飞书绑定」两处表单复用。
//
// 流程：打开即调 POST /v1/admin/feishu-app/scan/start 拿二维码（data URI），
// 客户用飞书 App 扫码确认后，飞书会在客户自己的企业内创建一个
// 「DealClaw AI销售助手」自建应用；前端轮询 status，拿到 appId/appSecret
// 后自动回填表单，由管理员确认提交（提交仍走原有校验/绑定链路）。
import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { api, errMsg } from '../lib/api';
import { IconRefresh } from './icons';

interface ScanStartResp {
  ok: true;
  deviceCode: string;
  qrUrl: string;
  qrDataUri: string;
  expireIn: number;
  status: string;
}

interface ScanStatusResp {
  ok: true;
  deviceCode: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  message: string;
  result?: { appId: string; appSecret: string };
  error?: string;
}

type Phase = 'starting' | 'scanning' | 'success' | 'error';

const POLL_INTERVAL_MS = 2500;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 扫码成功后回填表单（appId + appSecret） */
  onCredentials: (appId: string, appSecret: string) => void;
}

export default function FeishuAppScanModal({ open, onClose, onCredentials }: Props) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [qrDataUri, setQrDataUri] = useState('');
  const [message, setMessage] = useState('正在生成二维码…');
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);

  const deviceCodeRef = useRef('');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

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

  // On close while still scanning: cancel server-side so the session is freed.
  const requestClose = useCallback(() => {
    const dc = deviceCodeRef.current;
    if (dc) {
      api('/v1/admin/feishu-app/scan/cancel', { method: 'POST', body: { deviceCode: dc } }).catch(
        () => {},
      );
    }
    onClose();
  }, [onClose]);

  const poll = useCallback(async () => {
    const dc = deviceCodeRef.current;
    if (!dc || cancelledRef.current) return;
    try {
      const r = await api<ScanStatusResp>(`/v1/admin/feishu-app/scan/status/${encodeURIComponent(dc)}`);
      if (cancelledRef.current) return;
      if (r.status === 'completed' && r.result) {
        stopTimers();
        setPhase('success');
        setMessage('应用创建成功，凭据已自动填入表单');
        onCredentials(r.result.appId, r.result.appSecret);
        deviceCodeRef.current = '';
        // Brief success flash, then close so the admin can review the form.
        setTimeout(() => {
          if (!cancelledRef.current) onClose();
        }, 1200);
        return;
      }
      if (r.status === 'failed' || r.status === 'cancelled') {
        stopTimers();
        setPhase('error');
        setError(r.message || '扫码失败，请重试');
        return;
      }
      setMessage(r.message || '请客户用飞书 App 扫描二维码并确认创建应用');
      if (!cancelledRef.current) {
        pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    } catch (e) {
      // 404 = 会话丢失（服务重启/过期），其余按瞬时网络错误退避重试。
      if (cancelledRef.current) return;
      const status = (e as { status?: number }).status;
      if (status === 404) {
        stopTimers();
        setPhase('error');
        setError('二维码已过期或会话失效，请重新扫码');
        return;
      }
      pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS * 2);
    }
  }, [onClose, onCredentials, stopTimers]);

  const startScan = useCallback(async () => {
    cancelledRef.current = false;
    stopTimers();
    setPhase('starting');
    setQrDataUri('');
    setError('');
    setMessage('正在生成二维码…');
    deviceCodeRef.current = '';
    try {
      const r = await api<ScanStartResp>('/v1/admin/feishu-app/scan/start', { method: 'POST', body: {} });
      if (cancelledRef.current) return;
      deviceCodeRef.current = r.deviceCode;
      setQrDataUri(r.qrDataUri);
      setPhase('scanning');
      setMessage('请客户用飞书 App 扫描二维码并确认创建应用');
      const exp = Date.now() + (r.expireIn || 600) * 1000;
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
    } catch (e) {
      if (cancelledRef.current) return;
      setPhase('error');
      setError(errMsg(e));
    }
  }, [poll, stopTimers]);

  useEffect(() => {
    if (open) void startScan();
    else {
      cancelledRef.current = true;
      stopTimers();
    }
    return () => {
      cancelledRef.current = true;
      stopTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const expired = phase === 'scanning' && countdown <= 0;

  return (
    <Modal title="扫码创建并绑定飞书应用" open={open} onClose={requestClose} width={420}>
      {error && <div className="msg msg-err">{error}</div>}
      <div style={{ textAlign: 'center', padding: '12px 0' }}>
        {qrDataUri && phase !== 'error' ? (
          <img
            src={qrDataUri}
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
            {phase === 'starting' ? '二维码生成中…' : '二维码不可用'}
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: 13 }}>
          {phase === 'success' ? (
            <span style={{ color: '#16a34a' }}>✅ {message}</span>
          ) : expired ? (
            <span style={{ color: '#d97706' }}>二维码已过期，请点击重新生成</span>
          ) : (
            <span>{message}</span>
          )}
        </div>
        {phase === 'scanning' && !expired && countdown > 0 && (
          <div className="hint" style={{ margin: '6px 0 0' }}>
            有效期剩余 {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
          </div>
        )}
      </div>
      <div className="hint">
        客户用飞书 App 扫码并确认后，飞书会在客户企业内自动创建一个「DealClaw AI销售助手」自建应用，
        App ID 与 App Secret 将自动填入表单——无需再到飞书开放平台手动复制。
        如客户已有现成应用，仍可直接手动填写。
      </div>
      <div className="form-row" style={{ marginTop: 12, justifyContent: 'center' }}>
        {(phase === 'error' || expired) && (
          <button className="btn-primary" onClick={() => void startScan()}>
            <IconRefresh /> 重新生成二维码
          </button>
        )}
        <button className="btn-secondary" onClick={requestClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
