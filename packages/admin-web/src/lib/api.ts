// Unified API client for the DealClaw admin SPA.
//
// All endpoints are same-origin (/v1/*) and routed by the ingress directly to
// the owning backend service (credits-ledger / provisioning-service) — there
// is NO Express proxy layer anymore. The admin JWT is stored in localStorage
// and attached as `Authorization: Bearer <jwt>`. Any 401 (except on the login
// endpoint itself) clears the session and redirects to the login page.

const TOKEN_KEY = 'dealclaw_admin_jwt';
const USER_KEY = 'dealclaw_admin_user';

export interface AdminUser {
  id?: string;
  username: string;
  displayName?: string;
  role?: string;
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function getStoredUser(): AdminUser | null {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveSession(jwt: string, user: AdminUser): void {
  localStorage.setItem(TOKEN_KEY, jwt);
  localStorage.setItem(USER_KEY, JSON.stringify(user ?? {}));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export const LOGIN_PATH = `${import.meta.env.BASE_URL}login`;

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Human-readable message for any thrown value (ApiError or network error). */
export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message || `请求失败 (${e.status})`;
  return e instanceof Error ? e.message : '网络错误';
}

interface RequestOptions {
  method?: string;
  body?: unknown;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '网络错误，请稍后重试');
  }

  if (res.status === 401 && !path.startsWith('/v1/admin/auth/login')) {
    clearSession();
    // Avoid redirect loops when the session check fails on the login page.
    if (!window.location.pathname.endsWith('/login')) {
      window.location.href = LOGIN_PATH;
    }
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.code || '', body.message || '');
  }
  return body as T;
}
