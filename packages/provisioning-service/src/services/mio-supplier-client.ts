/**
 * 米奥（Mio）供应商目录客户端。
 *
 * provisioning-service 侧唯一的米奥 HTTP 出口，封装两个接口：
 *   1) 搜索供应商   POST {base}/blade-supplier/supplier/foreignTrade/pageSupplier
 *   2) 快速创建供应商 POST {base}/blade-agent-adapter/ops/agentBilling/customer/quickRegister
 *
 * 鉴权（2026-09-15 与米奥确认）：
 *   1) 先用 MIO_LOGIN_ID 登录换取 JWT：
 *      POST {base}/blade-agent-adapter/login/login.json
 *      请求只带 `Content-Type: application/json`，body 只有
 *      `{"login":"<MIO_LOGIN_ID>"}` —— **不带** Blade-Auth /
 *      X-Supplier-Id / X-Feishu-Open-Id（这三个头保留为可选配置项，
 *      默认空、当前不参与请求）。
 *   2) 之后所有 micro.tradechina.com 请求统一带
 *      `Blade-Auth: bearer <token>`。
 *   3) token 进程内缓存；有效期以 JWT 的 exp 为准，提前
 *      MIO_TOKEN_EXPIRY_SKEW_MS（300 秒）视为过期；同一时刻的并发请求
 *      合并为一次登录（in-flight promise）；过期或上游鉴权失败（401）时
 *      **只重取一次**并重试原请求。
 *   4) MIO_BLADE_AUTH 降级为**可选兜底**，仅当登录不可用时使用；登录
 *      与兜底都不可用 → 抛 MioApiError(kind='config',
 *      code='MIO_AUTH_NOT_CONFIGURED')，不静默降级、不发未鉴权请求。
 *
 * 凭据只从配置/环境读（config.mioLoginId / MIO_LOGIN_ID /
 * config.mioBladeAuth / MIO_BLADE_AUTH），绝不写进代码/日志/响应，
 * 也绝不出现在任何返回值里。
 *
 * 错误归一：网络（连不上/超时）、HTTP（非 2xx）、业务（code!=200 或
 * success=false）、响应体不可解析，四类分开成 MioApiError.kind ∈
 * config|input|network|http|business|parse，路由层只做 status 映射，
 * 不会把 fetch 原始异常抛给调用方。
 *
 * 字段口径（已与米奥确认）：要绑定的 supplierId = 响应 data 里的 `id`
 * （12 位数字），**不是** `code`。quickRegister 返回的 `password` 一律
 * 忽略——不入库、不回显、不记日志。
 */

import type { ProvisioningConfig } from '../config.js';
import { DEFAULT_MIO_API_BASE_URL } from '../config.js';

/** 两个接口共用超时。 */
export const MIO_REQUEST_TIMEOUT_MS = 10_000;
/** pageSupplier 单页条数（搜索为模糊匹配，50 条足够前端下拉）。 */
export const MIO_SUPPLIER_PAGE_SIZE = 50;

const MIO_SEARCH_PATH = '/blade-supplier/supplier/foreignTrade/pageSupplier';
const MIO_QUICK_REGISTER_PATH = '/blade-agent-adapter/ops/agentBilling/customer/quickRegister';
/** 登录换取 token 的路径（相对 MIO_API_BASE_URL）。 */
const MIO_LOGIN_PATH = '/blade-agent-adapter/login/login.json';

/** 到期前多少毫秒即视为过期（与米奥确认：提前 300 秒）。 */
export const MIO_TOKEN_EXPIRY_SKEW_MS = 300_000;
/** JWT 里读不到 exp 时的兜底有效期（与米奥确认的 24 小时）。 */
export const MIO_TOKEN_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

export type MioApiErrorKind = 'config' | 'input' | 'network' | 'http' | 'business' | 'parse';

export class MioApiError extends Error {
  constructor(
    public kind: MioApiErrorKind,
    /** 建议由路由层返回的 HTTP status（个别场景由路由覆盖）。 */
    public status: number,
    public code: string,
    message: string,
    /** 米奥原始业务码/msg（便于排查，不含任何凭据）。 */
    public upstream?: { code?: unknown; msg?: unknown },
  ) {
    super(message);
    this.name = 'MioApiError';
  }
}

export interface MioSupplierRecord {
  /** 米奥供应商 id —— 这就是要写进 tenants.mio_cdp_supplier_id 的值。 */
  id: string;
  /** 米奥内部编码（仅展示用，不用于绑定）。 */
  code: string | null;
  name: string | null;
}

export interface MioSupplierSearchResult {
  items: MioSupplierRecord[];
  total: number;
}

export interface MioSupplierCreateInput {
  companyName: string;
  mobile: string;
  /** 国际区号，默认 +86。 */
  intDialingCode?: string;
}

export interface MioSupplierCreateResult {
  /** data.supplierId —— 与搜索结果里的 `id` 同一口径（12 位数字）。 */
  supplierId: string;
  name: string | null;
}

/** 归一化米奥业务响应：`{code, success, msg, data}`。 */
interface MioEnvelope {
  code?: unknown;
  success?: unknown;
  msg?: unknown;
  message?: unknown;
  data?: unknown;
}

function resolveBaseUrl(config: ProvisioningConfig): string {
  const base = (config.mioApiBaseUrl || DEFAULT_MIO_API_BASE_URL).trim().replace(/\/+$/, '');
  if (!base) {
    throw new MioApiError(
      'config',
      503,
      'MIO_API_BASE_URL_MISSING',
      '未配置 MIO_API_BASE_URL，无法调用米奥接口',
    );
  }
  return base;
}

// ---------------------------------------------------------------------------
// 鉴权：登录换取 token
//
// 口径（2026-09-15 米奥确认）：MIO_LOGIN_ID 登录换 JWT → 之后所有请求带
// `Blade-Auth: bearer <token>`；MIO_BLADE_AUTH 降级为可选兜底。
// ---------------------------------------------------------------------------

/**
 * 新增配置项：优先读 config（若 config.ts 已经接线），否则直接读同名 env。
 * 这样不论环境变量走哪条线都不需要改调用方，也不会把值写进代码。
 */
interface MioAuthConfigFields {
  mioLoginId?: string;
  mioSupplierId?: string;
  mioFeishuOpenId?: string;
}

/**
 * 预留头的落点（默认空 = 不发送）。换取 token 后米奥侧不需要这三个头，
 * 但口径万一变化时只改这里，不必重写请求构造。当前**不参与任何请求**。
 */
export const MIO_RESERVED_HEADERS = {
  supplierId: { header: 'X-Supplier-Id', env: 'MIO_SUPPLIER_ID' },
  feishuOpenId: { header: 'X-Feishu-Open-Id', env: 'MIO_FEISHU_OPEN_ID' },
} as const;

function readMioField(
  config: ProvisioningConfig,
  field: keyof MioAuthConfigFields,
  envName: string,
): string {
  const fromConfig = (config as ProvisioningConfig & MioAuthConfigFields)[field];
  if (typeof fromConfig === 'string' && fromConfig.trim()) return fromConfig.trim();
  return (process.env[envName] || '').trim();
}

/** 登录用的米奥账号（MIO_LOGIN_ID）；未配置返回 ''。 */
export function resolveMioLoginId(config: ProvisioningConfig): string {
  return readMioField(config, 'mioLoginId', 'MIO_LOGIN_ID');
}

/**
 * 预留头的非空取值（默认 {}）。当前不参与请求，仅供口径变化时接线与测试断言。
 */
export function resolveReservedMioHeaders(config: ProvisioningConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  const supplierId = readMioField(config, 'mioSupplierId', MIO_RESERVED_HEADERS.supplierId.env);
  const feishuOpenId = readMioField(config, 'mioFeishuOpenId', MIO_RESERVED_HEADERS.feishuOpenId.env);
  if (supplierId) headers[MIO_RESERVED_HEADERS.supplierId.header] = supplierId;
  if (feishuOpenId) headers[MIO_RESERVED_HEADERS.feishuOpenId.header] = feishuOpenId;
  return headers;
}

/** 登录与静态兜底都不可用时的错误（消息不包含任何凭据值）。 */
function mioAuthNotConfiguredError(): MioApiError {
  return new MioApiError(
    'config',
    503,
    'MIO_AUTH_NOT_CONFIGURED',
    '未配置米奥鉴权：请注入 MIO_LOGIN_ID（登录换取 token，推荐）或 MIO_BLADE_AUTH（静态兜底）。两者都没有时不会调用米奥接口，也不会发未鉴权请求。',
  );
}

/** 兜底静态 token（MIO_BLADE_AUTH）——只从配置/env 读，未配置返回 ''。 */
function resolveStaticFallbackToken(config: ProvisioningConfig): string {
  return (config.mioBladeAuth || '').trim();
}

interface MioTokenCacheEntry {
  token: string;
  /** JWT exp 折算的毫秒时间戳；读不到 exp 时按 24h 兜底。 */
  expiresAtMs: number;
}

interface MioAuthMaterial {
  token: string;
  source: 'login' | 'static';
  /** 登录 token 的缓存 key（静态兜底为 null，不入缓存）。 */
  cacheKey: string | null;
}

/** 进程内 token 缓存：key = `${baseUrl}|${loginId}`。 */
const tokenCache = new Map<string, MioTokenCacheEntry>();
/** 同一时刻的并发登录合并：相同 key 只发一次。 */
const inflightLogins = new Map<string, Promise<string>>();

/** 仅供测试：清空进程内 token 缓存与 in-flight 登录。 */
export function __resetMioAuthCacheForTests(): void {
  tokenCache.clear();
  inflightLogins.clear();
}

/**
 * 解析 JWT payload 的 exp（秒 → 毫秒）。解不出返回 null。
 * 不抛错、不回显 token 内容。
 */
function decodeJwtExpiryMs(token: string): number | null {
  const payloadPart = token.split('.')[1];
  if (!payloadPart) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { exp?: unknown };
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function expiryMsFor(token: string, now: number): number {
  return decodeJwtExpiryMs(token) ?? now + MIO_TOKEN_FALLBACK_TTL_MS;
}

/** 提前 MIO_TOKEN_EXPIRY_SKEW_MS 即视为过期。 */
function isTokenExpired(entry: MioTokenCacheEntry, now: number): boolean {
  return entry.expiresAtMs - MIO_TOKEN_EXPIRY_SKEW_MS <= now;
}

/**
 * 登录换取 token。
 * 请求只带 `Content-Type: application/json`，body 只有 `{login}`；
 * **不带** Blade-Auth / X-Supplier-Id / X-Feishu-Open-Id。
 * 失败一律抛 MioApiError，消息里不含 loginId / token。
 */
async function loginForToken(
  config: ProvisioningConfig,
  base: string,
  loginId: string,
): Promise<string> {
  const url = `${base}${MIO_LOGIN_PATH}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: loginId }),
      signal: AbortSignal.timeout(MIO_REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const e = err as any;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new MioApiError(
      'network',
      timedOut ? 504 : 502,
      timedOut ? 'MIO_LOGIN_TIMEOUT' : 'MIO_LOGIN_UNREACHABLE',
      timedOut
        ? `米奥登录接口超时（${MIO_REQUEST_TIMEOUT_MS / 1000}s）`
        : `无法连接米奥登录接口：${e?.message || err}`,
    );
  }

  let payload: MioEnvelope;
  try {
    payload = (await res.json()) as MioEnvelope;
  } catch {
    throw new MioApiError('parse', 502, 'MIO_LOGIN_BAD_RESPONSE', `米奥登录接口返回非 JSON（HTTP ${res.status}）`);
  }

  if (!res.ok) {
    throw new MioApiError('http', 503, 'MIO_LOGIN_FAILED', `米奥登录接口返回 HTTP ${res.status}`);
  }

  const codeNum = payload?.code === undefined || payload?.code === null ? null : Number(payload.code);
  if (payload?.success === false || (codeNum !== null && codeNum !== 200)) {
    const upstreamMsg =
      typeof payload?.msg === 'string' && payload.msg.trim() ? payload.msg.trim() : '米奥登录失败';
    throw new MioApiError('http', 503, 'MIO_LOGIN_FAILED', upstreamMsg, {
      code: payload?.code,
      msg: upstreamMsg,
    });
  }

  const dataField = payload?.data as { token?: unknown } | null | undefined;
  const token = typeof dataField?.token === 'string' ? dataField.token.trim() : '';
  if (!token) {
    throw new MioApiError('parse', 502, 'MIO_LOGIN_BAD_RESPONSE', '米奥登录响应里缺少 data.token');
  }
  return token;
}

/**
 * 取本次请求要用的 Blade-Auth token。
 * 顺序：进程内缓存命中 → 登录换取（并发合并成一次）→ 静态兜底（登录不可用
 * 且配置了 MIO_BLADE_AUTH）。都没有 → MIO_AUTH_NOT_CONFIGURED。
 */
async function acquireMioAuth(
  config: ProvisioningConfig,
  options: { forceRefresh?: boolean } = {},
): Promise<MioAuthMaterial> {
  const base = resolveBaseUrl(config);
  const loginId = resolveMioLoginId(config);
  const staticToken = resolveStaticFallbackToken(config);

  if (!loginId) {
    // 没有登录能力：只能用兜底；兜底也没有 → 明确报错（绝不发未鉴权请求）。
    if (staticToken) return { token: staticToken, source: 'static', cacheKey: null };
    throw mioAuthNotConfiguredError();
  }

  const cacheKey = `${base}|${loginId}`;
  if (!options.forceRefresh) {
    const cached = tokenCache.get(cacheKey);
    if (cached && !isTokenExpired(cached, Date.now())) {
      return { token: cached.token, source: 'login', cacheKey };
    }
  }

  let pending = inflightLogins.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const token = await loginForToken(config, base, loginId);
      tokenCache.set(cacheKey, { token, expiresAtMs: expiryMsFor(token, Date.now()) });
      return token;
    })();
    inflightLogins.set(cacheKey, pending);
    // 登录结束（无论成败）释放 in-flight 位；等待者仍共享同一个结果。
    void pending
      .catch(() => undefined)
      .finally(() => {
        if (inflightLogins.get(cacheKey) === pending) inflightLogins.delete(cacheKey);
      });
  }

  try {
    return { token: await pending, source: 'login', cacheKey };
  } catch (err: unknown) {
    // 登录不可用 → 允许静态兜底（仅当配置了 MIO_BLADE_AUTH）；否则抛原始错误。
    if (staticToken) return { token: staticToken, source: 'static', cacheKey: null };
    throw err;
  }
}

/**
 * 重取一次 token（用于过期 / 上游 401）。没有登录能力或重登失败时返回
 * null，由调用方维持原错误 —— 不做无意义的重复请求。
 */
async function refreshMioAuthQuietly(config: ProvisioningConfig): Promise<MioAuthMaterial | null> {
  if (!resolveMioLoginId(config)) return null;
  try {
    return await acquireMioAuth(config, { forceRefresh: true });
  } catch {
    return null;
  }
}

/**
 * 启动一次调用前的配置自检：base URL + 鉴权凭据（MIO_LOGIN_ID 或
 * MIO_BLADE_AUTH）均可用。供批量任务（补录）在扫库前 fail-fast 使用，
 * 避免跑一半才报错。
 * 注意：本自检是同步的 —— 它只能证明凭据已配置，不能证明登录一定成功。
 */
export function assertMioConfigured(config: ProvisioningConfig): void {
  resolveBaseUrl(config);
  if (!resolveMioLoginId(config) && !resolveStaticFallbackToken(config)) {
    throw mioAuthNotConfiguredError();
  }
}

interface MioHttpAttempt {
  status: number;
  ok: boolean;
  payload: MioEnvelope | null;
  /** 响应体不是 JSON。 */
  bodyUnparsable: boolean;
}

/** 单次业务请求：只负责发请求 + 收响应，业务语义交给 unwrapMioAttempt。 */
async function sendMioAttempt(
  url: string,
  path: string,
  body: Record<string, unknown>,
  token: string,
): Promise<MioHttpAttempt> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Blade-Auth': `bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MIO_REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const e = err as any;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new MioApiError(
      'network',
      timedOut ? 504 : 502,
      timedOut ? 'MIO_TIMEOUT' : 'MIO_UNREACHABLE',
      timedOut
        ? `米奥接口超时（${MIO_REQUEST_TIMEOUT_MS / 1000}s）：${path}`
        : `无法连接米奥接口：${e?.message || err}`,
    );
  }

  try {
    return {
      status: res.status,
      ok: res.ok,
      payload: (await res.json()) as MioEnvelope,
      bodyUnparsable: false,
    };
  } catch {
    return { status: res.status, ok: res.ok, payload: null, bodyUnparsable: true };
  }
}

/** HTTP 401 或业务码 401 → 鉴权失败（触发一次重取 + 重试原请求）。 */
function isMioAuthFailure(attempt: MioHttpAttempt): boolean {
  if (attempt.status === 401) return true;
  const code = attempt.payload?.code;
  return code !== undefined && code !== null && Number(code) === 401;
}

/** 归一化业务响应：parse / http / business 三类错误都在这里抛。 */
function unwrapMioAttempt(attempt: MioHttpAttempt, path: string): unknown {
  if (attempt.bodyUnparsable) {
    throw new MioApiError(
      'parse',
      502,
      'MIO_BAD_RESPONSE',
      `米奥接口返回非 JSON（HTTP ${attempt.status}）：${path}`,
    );
  }

  const payload = attempt.payload;

  if (!attempt.ok) {
    const upstreamMsg = typeof payload?.msg === 'string' && payload.msg.trim()
      ? payload.msg
      : typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message
        : '';
    throw new MioApiError(
      'http',
      502,
      'MIO_HTTP_ERROR',
      `米奥接口返回 HTTP ${attempt.status}${upstreamMsg ? `：${upstreamMsg}` : ''}`,
      { code: payload?.code, msg: upstreamMsg },
    );
  }

  const codeNum = payload?.code === undefined || payload?.code === null ? null : Number(payload.code);
  const businessFailed = payload?.success === false || (codeNum !== null && codeNum !== 200);
  if (businessFailed) {
    const upstreamMsg =
      typeof payload?.msg === 'string' && payload.msg.trim()
        ? payload.msg.trim()
        : typeof payload?.message === 'string' && payload.message.trim()
          ? payload.message.trim()
          : '米奥接口返回业务错误';
    // 原样透出上游 msg —— 不重写、不重试、不去重。
    throw new MioApiError('business', 409, 'MIO_BUSINESS_ERROR', upstreamMsg, {
      code: payload?.code,
      msg: upstreamMsg,
    });
  }

  return payload?.data;
}

/**
 * fetch 失败（含超时）→ network；HTTP 非 2xx → http；业务失败 → business。
 * 鉴权失败（401）时重取一次 token 并重试原请求；重取不可用或重试仍失败，
 * 就按原错误抛出（不无限重试）。
 */
async function callMio(
  config: ProvisioningConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const base = resolveBaseUrl(config);
  const url = `${base}${path}`;

  const auth = await acquireMioAuth(config);
  let attempt = await sendMioAttempt(url, path, body, auth.token);

  if (isMioAuthFailure(attempt)) {
    const refreshed = await refreshMioAuthQuietly(config);
    if (refreshed) attempt = await sendMioAttempt(url, path, body, refreshed.token);
  }

  return unwrapMioAttempt(attempt, path);
}

/**
 * 模糊搜索供应商。
 * 注意：`search` 是模糊匹配 —— 可能 0 条，也可能多条；精确性由调用方
 * 自行判定（例如补录只认「唯一精确命中」）。
 */
export async function searchMioSuppliers(
  config: ProvisioningConfig,
  params: { search: string; page?: number; pageSize?: number },
): Promise<MioSupplierSearchResult> {
  const search = typeof params.search === 'string' ? params.search.trim() : '';
  if (!search) {
    throw new MioApiError('input', 400, 'MIO_BAD_INPUT', '搜索关键词（公司名）不能为空');
  }
  const page = Math.max(0, Math.floor(Number(params.page ?? 0) || 0));
  const pageSize = Math.min(
    Math.max(1, Math.floor(Number(params.pageSize ?? MIO_SUPPLIER_PAGE_SIZE) || MIO_SUPPLIER_PAGE_SIZE)),
    200,
  );

  const data = await callMio(config, MIO_SEARCH_PATH, {
    appVersion: '1.0',
    time: Date.now(),
    lang: 'zh',
    data: { page, pageSize, search },
  });

  const records = Array.isArray((data as any)?.records) ? (data as any).records : [];
  const items: MioSupplierRecord[] = records
    .map((r: any): MioSupplierRecord => ({
      id: r?.id === undefined || r?.id === null ? '' : String(r.id),
      code: r?.code === undefined || r?.code === null ? null : String(r.code),
      name: r?.name === undefined || r?.name === null ? null : String(r.name),
    }))
    .filter((r: MioSupplierRecord) => r.id !== '');

  const totalRaw = Number((data as any)?.total);
  const total = Number.isFinite(totalRaw) ? totalRaw : items.length;

  return { items, total };
}

/**
 * 快速创建供应商（quickRegister）。
 *
 * 同名重复等业务失败会原样抛出上游 msg（MioApiError.kind='business'），
 * 本函数不做去重、不做重试、不猜测 id —— supplierId 一律取
 * data.supplierId；data.password 直接忽略。
 */
export async function quickRegisterMioSupplier(
  config: ProvisioningConfig,
  input: MioSupplierCreateInput,
): Promise<MioSupplierCreateResult> {
  const companyName = typeof input.companyName === 'string' ? input.companyName.trim() : '';
  const mobile = typeof input.mobile === 'string' ? input.mobile.trim() : '';
  const intDialingCode =
    typeof input.intDialingCode === 'string' && input.intDialingCode.trim()
      ? input.intDialingCode.trim()
      : '+86';

  if (!companyName) {
    throw new MioApiError('input', 400, 'MIO_BAD_INPUT', '公司名称不能为空');
  }
  if (!mobile) {
    throw new MioApiError('input', 400, 'MIO_BAD_INPUT', '联系人手机号不能为空');
  }

  const data = await callMio(config, MIO_QUICK_REGISTER_PATH, {
    companyName,
    mobile,
    intDialingCode,
  });

  const supplierId =
    (data as any)?.supplierId === undefined || (data as any)?.supplierId === null
      ? ''
      : String((data as any).supplierId);
  if (!supplierId) {
    throw new MioApiError(
      'parse',
      502,
      'MIO_BAD_RESPONSE',
      '米奥快速创建供应商返回里缺少 supplierId',
    );
  }

  return {
    supplierId,
    name:
      typeof (data as any)?.companyName === 'string' && (data as any).companyName.trim()
        ? (data as any).companyName.trim()
        : companyName,
  };
}
