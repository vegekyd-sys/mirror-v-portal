// Login: exchange the admin passphrase for a JWT via credits-ledger
// POST /v1/admin/auth/login { token } → { jwt, user }.
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [passphrase, setPassphrase] = useState('');
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
    <div className="login-wrap">
      <div className="login-card">
        <h1>DealClaw 管理后台</h1>
        <div className="sub">请输入管理员登录口令</div>
        <form onSubmit={submit}>
          {error && <div className="err">{error}</div>}
          <div className="field">
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="登录口令"
              autoFocus
            />
          </div>
          <button type="submit" className="btn-primary" disabled={busy || !passphrase.trim()}>
            {busy ? '登录中…' : '登 录'}
          </button>
        </form>
      </div>
    </div>
  );
}
