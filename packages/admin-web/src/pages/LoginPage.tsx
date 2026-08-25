// Login: split hero layout. Exchanges the admin passphrase for a JWT via
// credits-ledger POST /v1/admin/auth/login { token } → { jwt, user }.
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { IconArrowRight, IconCheck, IconNexus } from '../components/icons';

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [passphrase, setPassphrase] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = passphrase.trim();
    if (!token || busy) return;
    setBusy(true);
    setError('');
    try {
      await login(token);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? errMsg(err) : '登录失败');
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-hero">
        <div className="hero-brand">
          <div className="logo-mark">
            <IconNexus size={22} />
          </div>
          Nexus · 控制台
        </div>
        <div className="hero-eyebrow">AGENT 运行管理平台</div>
        <h1 className="hero-title">
          一个平台，连接并管理
          <br />
          你的每一个 AI Agent。
        </h1>
        <p className="hero-desc">
          多租户隔离运行、模型供应商、Credits 计费与 Skill 编排，统一在 Nexus 完成 —— 让 Agent 的开通、运行与运维清晰可控。
        </p>
        <div className="hero-foot">
          <span className="side-status">
            <span className="status-dot" /> 平台运行正常
          </span>
          <span>·</span>
          <span>多租户隔离 · 数据实时同步</span>
        </div>
      </div>

      <div className="login-pane">
        <div className="login-box">
          <div className="login-eyebrow">管理后台</div>
          <h1>欢迎回来</h1>
          <div className="sub">使用管理员口令验证身份并进入工作台。</div>
          <form onSubmit={submit}>
            {error && <div className="login-err">{error}</div>}
            <label htmlFor="passphrase">管理员口令</label>
            <div className="login-input">
              <input
                id="passphrase"
                type={show ? 'text' : 'password'}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="输入登录口令"
                autoFocus
              />
              <button
                type="button"
                className="peek"
                onClick={() => setShow((s) => !s)}
                tabIndex={-1}
              >
                {show ? '隐藏' : '显示'}
              </button>
            </div>
            <button type="submit" className="login-btn" disabled={busy || !passphrase.trim()}>
              <span>{busy ? '验证中…' : '安全登录'}</span>
              <IconArrowRight size={16} />
            </button>
          </form>
          <div className="login-note">
            <span className="tick">
              <IconCheck size={11} />
            </span>
            <span>
              登录凭证（JWT）仅保存在当前浏览器，
              <br />
              请求会通过加密连接发送，不会被前端记录。
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
