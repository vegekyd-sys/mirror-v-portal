// 钉钉扫码一键创建机器人 — 供「Agent 详情-钉钉绑定」使用。
//
// 流程：打开即调 POST /v1/admin/dingtalk-app/scan/start，provisioning 调钉钉
// 设备授权流（init→begin）拿 device_code + verification_uri_complete，前端渲染
// 二维码；客户用钉钉 App 扫码并确认「一键创建机器人」，前端轮询 status（内部
// 同步调钉钉 poll），成功后拿到 clientId/clientSecret 自动回填表单，由管理员
// 确认后提交（提交仍走原有 dingtalk-binding 校验/绑定链路）。
//
// 与飞书/企微扫码的差异：钉钉走官方 registration 设备授权流
// （oapi.dingtalk.com/app/registration/*），返回 clientId/clientSecret 回填钉钉
// 绑定表单，对标企业微信的 botId/secret。
import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { api, errMsg } from '../lib/api';
import { IconRefresh } from './icons';

interface ScanStartResp {
  ok: true;
  deviceCode: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete: string;
  qrDataUri: string;
  expireIn: number;
  status: string;
}

interface ScanStatusResp {
  ok: true;
  deviceCode: string;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  message: string;
  result?: { clientId: string; clientSecret: string };
  error?: string;
}

type Phase = 'starting' | 'scanning' | 'success' | 'error';

const POLL_INTERVAL_MS = 3000;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 扫码成功后回填表单（clientId + clientSecret） */
  onCredentials: (clientId: string, clientSecret: string) => void;
}

export default function DingTalkAppScanModal({ open, onClose, onCredentials }: Props) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [qrDataUri, setQrDataUri] = useState('');
  const [verificationUriComplete, setVerificationUriComplete] = useState('');
  const [userCode, setUserCode] = useState('');
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

  const requestClose = useCallback(() => {
    const dc = deviceCodeRef.current;
    if (dc) {
      api('/v1/admin/dingtalk-app/scan/cancel', { method: 'POST', body: { deviceCode: dc } }).catch(
        () => {},
      );
    }
    onClose();
  }, [onClose]);

  const poll = useCallback(async () => {
    const dc = deviceCodeRef.current;
    if (!dc || cancelledRef.current) return;
    try {
      const r = await api<ScanStatusResp>(
        `/v1/admin/dingtalk-app/scan/status/${encodeURIComponent(dc)}`,
      );
      if (cancelledRef.current) return;

      if (r.status === 'completed' && r.result) {
        stopTimers();
        setPhase('success');
        setMessage('机器人创建成功，凭据已自动填入表单');
        onCredentials(r.result.clientId, r.result.clientSecret);
        deviceCodeRef.current = '';
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
      setMessage(r.message || '请客户用钉钉扫描二维码并确认创建机器人');
      if (!cancelledRef.current) {
        pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    } catch (e) {
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
    setVerificationUriComplete('');
    setUserCode('');
    setError('');
    setMessage('正在生成二维码…');
    deviceCodeRef.current = '';
    try {
      const r = await api<ScanStartResp>('/v1/admin/dingtalk-app/scan/start', { method: 'POST', body: {} });
      if (cancelledRef.current) return;
      deviceCodeRef.current = r.deviceCode;
      setQrDataUri(r.qrDataUri);
      setVerificationUriComplete(r.verificationUriComplete);
      setUserCode(r.userCode || '');
      setPhase('scanning');
      setMessage('请客户用钉钉扫描二维码并确认创建机器人');
      const exp = Date.now() + (r.expireIn || 7200) * 1000;
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
    <Modal title="扫码创建并绑定钉钉机器人" open={open} onClose={requestClose} width={420}>
      {error && <div className="msg msg-err">{error}</div>}
      <div style={{ textAlign: 'center', padding: '12px 0' }}>
        {qrDataUri && phase !== 'error' ? (
          <img
            src={qrDataUri}
            alt="钉钉扫码二维码"
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
        {userCode && phase === 'scanning' && (
          <div className="hint" style={{ margin: '6px 0 0' }}>
            无法扫码时，可在授权页手动输入授权码：
            <span className="mono" style={{ marginLeft: 4, fontWeight: 600 }}>
              {userCode}
            </span>
          </div>
        )}
        {verificationUriComplete && phase === 'scanning' && (
          <div className="hint" style={{ margin: '6px 0 0', wordBreak: 'break-all' }}>
            无法扫码时，可让客户在浏览器打开授权链接：
            <a href={verificationUriComplete} target="_blank" rel="noreferrer" style={{ marginLeft: 4 }}>
              打开授权页
            </a>
          </div>
        )}
      </div>
      <div className="hint">
        客户用钉钉 App 扫码并确认后，钉钉会在客户企业内自动创建<b>企业内部应用</b>
        （应用创建完成后即具备机器人能力），Client ID 与 Client Secret 将自动填入表单，
        无需再到钉钉开放平台手动复制。如客户已有现成应用，仍可手动填写。
      </div>
      <div className="hint" style={{ marginTop: 8, color: '#d97706' }}>
        ⚠️ 钉钉创建的是「企业内部应用」，需该企业的管理员在钉钉管理后台审批同意后方可生效，
        审批通过前凭据暂不可用。
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
