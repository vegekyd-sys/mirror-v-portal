// Login: split hero layout. Exchanges the admin passphrase for a JWT via
// credits-ledger POST /v1/admin/auth/login { token } → { jwt, user }.
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { IconArrowRight, IconCheck, IconNexus } from '../components/icons';
import nexusLogo from '../../../central-gateway/public/onboard/nexus-logo-v2.webp';

export default function LoginPage() {
  const elastic = import.meta.env.VITE_NEXUS_ELASTIC === 'true';
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
    <div className={`login-shell ${elastic ? 'elastic-login' : ''}`}>
      <div className="login-hero">
        <div className="hero-brand">
          {elastic ? <img className="elastic-logo" src={nexusLogo} alt="Nexus" /> : <><div className="logo-mark"><IconNexus size={22} /></div>Nexus · 控制台</>}
        </div>
        <div className="hero-eyebrow">{elastic ? 'MIRROR V AGENT 门户' : 'AGENT 运行管理平台'}</div>
        <h1 className="hero-title">
          {elastic ? '选择模板，创建并管理' : '一个平台，连接并管理'}
          <br />
          {elastic ? '你的 AI Agent。' : '你的每一个 AI Agent。'}
        </h1>
        <p className="hero-desc">
          {elastic
            ? 'Nexus 是 Mirror V 的门户。扫码创建独立实例，选择 DealClaw 或 Mirror V 模板，并查看运行、客户账户和 Credits。'
            : '多租户隔离运行、模型供应商、Credits 计费与 Skill 编排，统一在 Nexus 完成 —— 让 Agent 的开通、运行与运维清晰可控。'}
        </p>
        <div className="hero-foot">
          <span className="side-status">
            <span className="status-dot" /> 平台运行正常
          </span>
          <span>·</span>
          <span>{elastic ? '独立 Agent 实例 · 数据实时同步' : '多租户隔离 · 数据实时同步'}</span>
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
              {elastic ? '请从 HTTPS 管理入口登录。' : '请求会通过加密连接发送，不会被前端记录。'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
