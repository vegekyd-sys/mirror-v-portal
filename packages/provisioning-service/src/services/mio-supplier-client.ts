/**
 * 米奥（Mio）供应商目录客户端。
 *
 * provisioning-service 侧唯一的米奥 HTTP 出口，封装两个接口：
 *   1) 搜索供应商   POST {base}/blade-supplier/supplier/foreignTrade/pageSupplier
 *   2) 快速创建供应商 POST {base}/blade-agent-adapter/ops/agentBilling/customer/quickRegister
 *
 * 两个接口都用 `Blade-Auth: bearer <token>` 鉴权，token 只从 env
 * （MIO_BLADE_AUTH → config.mioBladeAuth）读，绝不写进代码/日志/响应。
 * 缺失时抛 MioApiError(kind='config')，不做无鉴权降级调用。
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

/**
 * 读 Blade-Auth token。只从配置（env）取。
 * 缺失 → 明确报错，绝不静默使用空 token 调用上游。
 */
function resolveBladeAuth(config: ProvisioningConfig): string {
  const token = (config.mioBladeAuth || '').trim();
  if (!token) {
    throw new MioApiError(
      'config',
      503,
      'MIO_AUTH_NOT_CONFIGURED',
      '未配置 MIO_BLADE_AUTH：米奥接口需要 Blade-Auth token。请在 provisioning-service 的运行环境注入 MIO_BLADE_AUTH（不要在代码或前端填写）。',
    );
  }
  return token;
}

/**
 * 启动一次调用前的配置自检：base URL + Blade-Auth 均可用。
 * 供批量任务（补录）在扫库前 fail-fast 使用，避免跑一半才报错。
 */
export function assertMioConfigured(config: ProvisioningConfig): void {
  resolveBaseUrl(config);
  resolveBladeAuth(config);
}

/** fetch 失败（含超时）→ network；HTTP 非 2xx → http；业务失败 → business。 */
async function callMio(
  config: ProvisioningConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const base = resolveBaseUrl(config);
  const token = resolveBladeAuth(config);
  const url = `${base}${path}`;

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

  let payload: MioEnvelope;
  try {
    payload = (await res.json()) as MioEnvelope;
  } catch {
    throw new MioApiError(
      'parse',
      502,
      'MIO_BAD_RESPONSE',
      `米奥接口返回非 JSON（HTTP ${res.status}）：${path}`,
    );
  }

  if (!res.ok) {
    const upstreamMsg = typeof payload?.msg === 'string' && payload.msg.trim()
      ? payload.msg
      : typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message
        : '';
    throw new MioApiError(
      'http',
      502,
      'MIO_HTTP_ERROR',
      `米奥接口返回 HTTP ${res.status}${upstreamMsg ? `：${upstreamMsg}` : ''}`,
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
