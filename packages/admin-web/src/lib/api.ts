import { LOCAL_PREVIEW, previewResponse } from "./local-preview";
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

/**
 * Transient gateway errors worth retrying: 502/503/504 surface when the ALB
 * or ingress briefly has no healthy backend during a rolling update, and
 * 0 (NETWORK) covers a short-lived connection reset. Retrying once or twice
 * after a short backoff clears these without user-visible errors.
 */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [400, 800, 1600];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function requestOnce<T = unknown>(path: string, opts: RequestOptions): Promise<T> {
  if (LOCAL_PREVIEW) return previewResponse(path, opts.method) as T;
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

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  // Auto-retry only safe reads (GET/HEAD). Mutations are intentionally not
  // retried — a 502 after a POST/PATCH may have already taken effect, and
  // blind retries could duplicate side effects (e.g. two backup Jobs).
  const method = (opts.method ?? 'GET').toUpperCase();
  const retryable = method === 'GET' || method === 'HEAD';
  const maxAttempts = retryable ? MAX_RETRIES + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await requestOnce<T>(path, opts);
    } catch (e) {
      const canRetry =
        retryable &&
        attempt < maxAttempts - 1 &&
        e instanceof ApiError &&
        (RETRYABLE_STATUSES.has(e.status) || e.status === 0);
      if (!canRetry) throw e;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }

  // Unreachable (the loop always returns or throws); kept for exhaustiveness.
  throw new ApiError(0, 'NETWORK', '网络错误，请稍后重试');
}
