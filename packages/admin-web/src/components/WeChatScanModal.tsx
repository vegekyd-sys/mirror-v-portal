// 微信扫码绑定 — 供「客户详情-微信绑定」使用。
//
// 流程：打开即调 POST /v1/admin/tenants/:tid/wechat-binding/start，Agent 内
// bridge 向 iLink API 请求二维码 URL；前端展示二维码图片（URL 渲染为 QR），
// 每 3s 轮询 status；用户手机微信扫码确认后，bridge 保存账号 token 到 PVC，
// 网关热重载启动 monitor。
//
// 与飞书扫码的区别：微信返回的是 qrcodeUrl（需前端渲染为 QR 图片），
// 没有 appId/appSecret 回填；登录可能要求输入手机验证码。
import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { api, errMsg } from '../lib/api';
import { IconRefresh } from './icons';

interface StartResp {
  ok: true;
  sessionId: string;
  qrcodeUrl: string;
  expiresAt: string;
}

interface StatusResp {
  ok: true;
  status: 'pending' | 'scanned' | 'need_verify_code' | 'completed' | 'failed' | 'cancelled' | 'expired';
  message: string;
  qrcodeUrl?: string;
  accountId?: string;
  weixinUserId?: string;
  error?: string;
}

type Phase = 'starting' | 'scanning' | 'need_code' | 'success' | 'error';

const POLL_INTERVAL_MS = 3000;

interface Props {
  tenantId: string;
  open: boolean;
  onClose: () => void;
  onBound?: () => void;
}

export default function WeChatScanModal({ tenantId, open, onClose, onBound }: Props) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [qrcodeUrl, setQrcodeUrl] = useState('');
  const [message, setMessage] = useState('正在生成二维码…');
  const [error, setError] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [remainingSec, setRemainingSec] = useState(0);

  const sessionIdRef = useRef('');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);
  const expiresAtRef = useRef<number>(0);

  const stopPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const requestClose = useCallback(() => {
    const sid = sessionIdRef.current;
    if (sid) {
      api(`/v1/admin/tenants/${tenantId}/wechat-binding/cancel`, {
        method: 'POST',
        body: { sessionId: sid },
      }).catch(() => {});
    }
    onClose();
  }, [onClose, tenantId]);

  const poll = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || cancelledRef.current) return;
    try {
      const r = await api<StatusResp>(
        `/v1/admin/tenants/${tenantId}/wechat-binding/status/${encodeURIComponent(sid)}`,
      );
      if (cancelledRef.current) return;

      // QR may be refreshed
      if (r.qrcodeUrl) setQrcodeUrl(r.qrcodeUrl);

      if (r.status === 'completed') {
        stopPoll();
        setPhase('success');
        setMessage(r.message || '微信绑定成功');
        sessionIdRef.current = '';
        onBound?.();
        setTimeout(() => {
          if (!cancelledRef.current) onClose();
        }, 1500);
        return;
      }
      if (r.status === 'failed' || r.status === 'cancelled' || r.status === 'expired') {
        stopPoll();
        setPhase('error');
        setError(r.error || r.message || '扫码失败，请重试');
        return;
      }
      if (r.status === 'need_verify_code') {
        setPhase('need_code');
        setMessage(r.message || '请输入手机微信显示的数字');
        return; // don't schedule next poll until code submitted
      }
      if (r.status === 'scanned') {
        setPhase('scanning');
      }
      setMessage(r.message || '请用手机微信扫描二维码');
      if (!cancelledRef.current) {
        pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    } catch (e) {
      if (cancelledRef.current) return;
      const status = (e as { status?: number }).status;
      if (status === 404) {
        stopPoll();
        setPhase('error');
        setError('扫码会话已失效，请重新发起');
        return;
      }
      pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS * 2);
    }
  }, [onBound, onClose, stopPoll, tenantId]);

  const startScan = useCallback(async () => {
    cancelledRef.current = false;
    stopPoll();
    setPhase('starting');
    setQrcodeUrl('');
    setError('');
    setVerifyCode('');
    setRemainingSec(0);
    expiresAtRef.current = 0;
    setMessage('正在生成二维码…');
    sessionIdRef.current = '';
    try {
      const r = await api<StartResp>(`/v1/admin/tenants/${tenantId}/wechat-binding/start`, {
        method: 'POST',
      });
      if (cancelledRef.current) return;
      sessionIdRef.current = r.sessionId;
      setQrcodeUrl(r.qrcodeUrl);
      const ts = new Date(r.expiresAt).getTime();
      expiresAtRef.current = ts;
      setRemainingSec(Math.max(0, Math.floor((ts - Date.now()) / 1000)));
      setPhase('scanning');
      setMessage('请用手机微信扫描二维码');
      pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (e) {
      if (cancelledRef.current) return;
      setPhase('error');
      setError(errMsg(e));
    }
  }, [poll, stopPoll, tenantId]);

  // Countdown ticker — updates remaining seconds every second while QR is active
  useEffect(() => {
    if (phase !== 'scanning' && phase !== 'need_code') return;
    if (!expiresAtRef.current) return;
    const tick = () => {
      const left = Math.max(0, Math.floor((expiresAtRef.current - Date.now()) / 1000));
      setRemainingSec(left);
      if (left <= 0) {
        stopPoll();
        setPhase('error');
        setError('二维码已过期，请重新生成');
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase, stopPoll]);

  const submitVerifyCode = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || !verifyCode.trim()) return;
    try {
      // Submit code to agent bridge via provisioning
      await api(`/v1/admin/tenants/${tenantId}/wechat-binding/status/${encodeURIComponent(sid)}`, {
        method: 'POST',
        body: { code: verifyCode.trim() },
      }).catch(() => {});
      setPhase('scanning');
      setMessage('验证码已提交，等待确认…');
      pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [poll, tenantId, verifyCode]);

  useEffect(() => {
    if (open) void startScan();
    else {
      cancelledRef.current = true;
      stopPoll();
    }
    return () => {
      cancelledRef.current = true;
      stopPoll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal title="扫码绑定微信" open={open} onClose={requestClose} width={420}>
      {error && <div className="msg msg-err">{error}</div>}
      <div style={{ textAlign: 'center', padding: '12px 0' }}>
        {qrcodeUrl && phase !== 'error' ? (
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(qrcodeUrl)}`}
            alt="微信扫码二维码"
            width={220}
            height={220}
            style={{ borderRadius: 12 }}
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
          ) : (
            <span>{message}</span>
          )}
        </div>
        {(phase === 'scanning' || phase === 'need_code') && remainingSec > 0 && (
          <div style={{
            marginTop: 6,
            fontSize: 12,
            color: remainingSec <= 60 ? '#e5484d' : '#8a8f98',
            fontWeight: remainingSec <= 60 ? 600 : 400,
          }}>
            ⏱ 二维码 {Math.floor(remainingSec / 60)}:{String(remainingSec % 60).padStart(2, '0')} 后过期
          </div>
        )}
      </div>
      {phase === 'need_code' && (
        <div className="form-row" style={{ marginTop: 8, gap: 8 }}>
          <input
            type="text"
            placeholder="输入手机微信显示的数字"
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value)}
            style={{ flex: 1, textAlign: 'center', fontSize: 18, letterSpacing: 2 }}
            autoFocus
          />
          <button className="btn-primary" onClick={() => void submitVerifyCode()}>
            确认
          </button>
        </div>
      )}
      <div className="hint">
        管理员用手机微信扫码后，在手机上确认登录。如果微信要求验证码，请在上方输入手机显示的数字。
        绑定成功后，该租户 Agent 将持有微信长连接，私聊消息由 Agent 自动回复。
      </div>
      <div className="form-row" style={{ marginTop: 12, justifyContent: 'center' }}>
        {phase === 'error' && (
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
