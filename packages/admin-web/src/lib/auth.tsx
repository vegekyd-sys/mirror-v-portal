// Auth session state: login (passphrase → JWT exchange), restore-on-load via
// GET /v1/admin/auth/me, and logout. Consumed by the router guard and layout.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  clearSession,
  getToken,
  getStoredUser,
  saveSession,
  LOGIN_PATH,
  type AdminUser,
} from './api';

interface AuthState {
  /** false while the stored session is being validated on first load */
  ready: boolean;
  user: AdminUser | null;
  login: (passphrase: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  ready: false,
  user: null,
  login: async () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<AdminUser | null>(null);

  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    // Optimistically show the cached user, then validate the JWT.
    setUser(getStoredUser());
    api<{ user: AdminUser }>('/v1/admin/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => {
        // api() already cleared the session and redirected on 401.
        setUser(null);
      })
      .finally(() => setReady(true));
  }, []);

  const login = async (passphrase: string) => {
    const r = await api<{ ok: boolean; jwt: string; user: AdminUser }>(
      '/v1/admin/auth/login',
      { method: 'POST', body: { token: passphrase } },
    );
    saveSession(r.jwt, r.user);
    setUser(r.user);
  };

  const logout = () => {
    clearSession();
    setUser(null);
    window.location.href = LOGIN_PATH;
  };

  return (
    <AuthContext.Provider value={{ ready, user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
