import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MioApiError,
  MIO_REQUEST_TIMEOUT_MS,
  MIO_TOKEN_EXPIRY_SKEW_MS,
  __resetMioAuthCacheForTests,
  assertMioConfigured,
  quickRegisterMioSupplier,
  resolveMioLoginId,
  resolveReservedMioHeaders,
  searchMioSuppliers,
} from '../services/mio-supplier-client.js';
import type { ProvisioningConfig } from '../config.js';

// 注意：这里用的是**假**凭据占位符，任何时候都不得把真实 MIO_BLADE_AUTH /
// MIO_LOGIN_ID 写进代码/测试/示例。生产凭据只通过 env 注入。
const TEST_TOKEN = 'unit-test-blade-token-placeholder';
const TEST_LOGIN_ID = 'unit-test-login-id-placeholder';
const LOGIN_PATH = '/blade-agent-adapter/login/login.json';
const SEARCH_PATH = '/blade-supplier/supplier/foreignTrade/pageSupplier';
const QUICK_REGISTER_PATH = '/blade-agent-adapter/ops/agentBilling/customer/quickRegister';

function baseConfig(overrides: Partial<ProvisioningConfig> = {}): ProvisioningConfig {
  return {
    port: 0,
    databaseUrl: 'postgresql://test:test@localhost:5432/test',
    k8sDryRun: true,
    runtimeNamespace: 'dealclaw-test',
    imageRegistry: 'test-registry/dealclaw',
    nexusGatewayImageTag: 'test',
    dealclawAgentImageTag: 'test',
    agentPvcSize: '10Gi',
    agentPvcStorageClass: 'alibabacloud-cnfs-nas',
    agentPvcAccessMode: 'ReadWriteOnce',
    ossEndpoint: 'oss-cn-shanghai.aliyuncs.com',
    ossBucket: 'dealclaw-backup',
    ossSecretName: 'dealclaw-oss',
    backupImage: 'test/ossutil',
    creditsLedgerUrl: 'http://credits-ledger:8081',
    creditsLedgerToken: '',
    llmPushWorkerIntervalMs: 100,
    llmPushLeaseSeconds: 600,
    mioApiBaseUrl: 'https://mio.example.test',
    mioBladeAuth: TEST_TOKEN,
    ...overrides,
  };
}

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function mockJson(payload: unknown, status = 200): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn = vi.fn(async (input: any, init?: any) => {
    calls.push({
      url: typeof input === 'string' ? input : String(input?.url ?? input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

// 本文件全部用例都在「无米奥 env」的干净起点上跑：既保证不依赖运行环境，
// 也避免 env 兜底把静态 token 的用例改掉语义。跑完原样还原。
const MIO_ENV_NAMES = ['MIO_LOGIN_ID', 'MIO_SUPPLIER_ID', 'MIO_FEISHU_OPEN_ID'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of MIO_ENV_NAMES) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  __resetMioAuthCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  __resetMioAuthCacheForTests();
  for (const name of MIO_ENV_NAMES) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('米奥客户端 — 配置与凭据', () => {
  it('MIO_BLADE_AUTH 缺失时报明确错误，且不做无鉴权调用', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const config = baseConfig({ mioBladeAuth: '' });

    await expect(searchMioSuppliers(config, { search: 'Acme' })).rejects.toMatchObject({
      kind: 'config',
      status: 503,
      code: 'MIO_AUTH_NOT_CONFIGURED',
    });
    await expect(quickRegisterMioSupplier(config, { companyName: 'Acme', mobile: '13800000000' }))
      .rejects.toMatchObject({ kind: 'config', status: 503, code: 'MIO_AUTH_NOT_CONFIGURED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('assertMioConfigured 在缺凭据时抛错（供批量任务 fail-fast）', () => {
    expect(() => assertMioConfigured(baseConfig())).not.toThrow();
    expect(() => assertMioConfigured(baseConfig({ mioBladeAuth: '   ' }))).toThrow(MioApiError);
  });

  it('base URL 默认值来自 config（不带 /blade-* 路径）', async () => {
    const { calls } = mockJson({ code: 200, success: true, data: { records: [], total: 0 } });
    await searchMioSuppliers(baseConfig({ mioApiBaseUrl: 'https://mio.example.test/' }), { search: 'a' });
    expect(calls[0].url).toBe('https://mio.example.test/blade-supplier/supplier/foreignTrade/pageSupplier');
  });
});

describe('搜索供应商（pageSupplier）', () => {
  it('只回 id/code/name，丢弃无 id 的记录，读 total', async () => {
    const { calls } = mockJson({
      code: 200,
      success: true,
      data: {
        records: [
          { id: 123456789012, code: 'C-1', name: 'Acme Ltd', extra: 'ignored' },
          { id: '', code: 'C-2', name: 'Bad Row' },
        ],
        total: 7,
      },
    });

    const result = await searchMioSuppliers(baseConfig(), { search: 'Acme', page: 1 });

    expect(result.items).toEqual([{ id: '123456789012', code: 'C-1', name: 'Acme Ltd' }]);
    expect(result.total).toBe(7);

    expect(calls[0].url).toBe('https://mio.example.test/blade-supplier/supplier/foreignTrade/pageSupplier');
    expect(calls[0].headers['Blade-Auth']).toBe(`bearer ${TEST_TOKEN}`);
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toMatchObject({
      appVersion: '1.0',
      lang: 'zh',
      data: { page: 1, pageSize: 50, search: 'Acme' },
    });
    expect(typeof calls[0].body.time).toBe('number');
  });

  it('空关键词直接拒绝（input，不发请求）', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    await expect(searchMioSuppliers(baseConfig(), { search: '   ' })).rejects.toMatchObject({
      kind: 'input',
      status: 400,
      code: 'MIO_BAD_INPUT',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('业务失败（code!=200 / success=false）原样透出上游 msg', async () => {
    mockJson({ code: 500, success: false, msg: 'token 已过期，请联系管理员', data: null });
    await expect(searchMioSuppliers(baseConfig(), { search: 'Acme' })).rejects.toMatchObject({
      kind: 'business',
      code: 'MIO_BUSINESS_ERROR',
      message: 'token 已过期，请联系管理员',
    });
  });

  it('HTTP 非 2xx 归一为 http 错误', async () => {
    mockJson({ message: 'Bad Gateway' }, 502);
    await expect(searchMioSuppliers(baseConfig(), { search: 'Acme' })).rejects.toMatchObject({
      kind: 'http',
      status: 502,
      code: 'MIO_HTTP_ERROR',
    });
  });

  it('响应不是 JSON 时归一为 parse 错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 200 })));
    await expect(searchMioSuppliers(baseConfig(), { search: 'Acme' })).rejects.toMatchObject({
      kind: 'parse',
      status: 502,
      code: 'MIO_BAD_RESPONSE',
    });
  });

  it('网络异常归一为 network（不发原始异常给调用方）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    await expect(searchMioSuppliers(baseConfig(), { search: 'Acme' })).rejects.toMatchObject({
      kind: 'network',
      status: 502,
      code: 'MIO_UNREACHABLE',
    });
  });

  it('超时归一为 network/504', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }));
    await expect(searchMioSuppliers(baseConfig(), { search: 'Acme' })).rejects.toMatchObject({
      kind: 'network',
      status: 504,
      code: 'MIO_TIMEOUT',
    });
    expect(MIO_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('快速创建供应商（quickRegister）', () => {
  it('成功时取 data.supplierId 作为绑定 id，忽略 password', async () => {
    const { calls } = mockJson({
      code: 200,
      success: true,
      data: {
        supplierId: 123456789012,
        companyName: 'Acme Ltd',
        mobile: '13800000000',
        intDialingCode: '+86',
        password: 'PLAINTEXT-SHOULD-NEVER-BE-RETURNED',
      },
    });

    const result = await quickRegisterMioSupplier(baseConfig(), {
      companyName: ' Acme Ltd ',
      mobile: '13800000000',
    });

    expect(result).toEqual({ supplierId: '123456789012', name: 'Acme Ltd' });
    expect(Object.keys(result).sort()).toEqual(['name', 'supplierId']);
    expect(JSON.stringify(result)).not.toContain('PLAINTEXT-SHOULD-NEVER-BE-RETURNED');

    expect(calls[0].url).toBe(
      'https://mio.example.test/blade-agent-adapter/ops/agentBilling/customer/quickRegister',
    );
    expect(calls[0].headers['Blade-Auth']).toBe(`bearer ${TEST_TOKEN}`);
    expect(calls[0].body).toEqual({
      companyName: 'Acme Ltd',
      mobile: '13800000000',
      intDialingCode: '+86',
    });
  });

  it('同名重复等业务失败：msg 原样抛出（不重试、不去重）', async () => {
    mockJson({ code: 500, success: false, msg: '该公司名称已存在，请勿重复注册', data: null });
    await expect(
      quickRegisterMioSupplier(baseConfig(), { companyName: 'Acme Ltd', mobile: '13800000000' }),
    ).rejects.toMatchObject({
      kind: 'business',
      status: 409,
      code: 'MIO_BUSINESS_ERROR',
      message: '该公司名称已存在，请勿重复注册',
    });
  });

  it('缺公司名/手机号时本地拒绝（input，不发请求）', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    await expect(quickRegisterMioSupplier(baseConfig(), { companyName: '', mobile: '138' }))
      .rejects.toMatchObject({ kind: 'input', code: 'MIO_BAD_INPUT' });
    await expect(quickRegisterMioSupplier(baseConfig(), { companyName: 'Acme', mobile: ' ' }))
      .rejects.toMatchObject({ kind: 'input', code: 'MIO_BAD_INPUT' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('响应缺少 supplierId 时归一为 parse 错误', async () => {
    mockJson({ code: 200, success: true, data: { companyName: 'Acme Ltd' } });
    await expect(
      quickRegisterMioSupplier(baseConfig(), { companyName: 'Acme Ltd', mobile: '13800000000' }),
    ).rejects.toMatchObject({ kind: 'parse', code: 'MIO_BAD_RESPONSE' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 登录换取 token（2026-09-15 与米奥确认的口径）
// ───────────────────────────────────────────────────────────────────────────

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** 造一个结构合法的假 JWT（只有 payload.exp 有意义，签名是假的）。 */
function makeJwt(expSecondsFromNow: number): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'unit-test', exp })}.unit-test-signature`;
}

type RouteResponder = (call: CapturedCall) => Response | Promise<Response>;

/** 按 URL 分发的 fetch mock；未匹配到路由直接抛错（不静默放过意外请求）。 */
function mockFetchRoutes(routes: { match: string; respond: RouteResponder }[]) {
  const calls: CapturedCall[] = [];
  const fn = vi.fn(async (input: any, init?: any) => {
    const call: CapturedCall = {
      url: typeof input === 'string' ? input : String(input?.url ?? input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    const route = routes.find((r) => call.url.includes(r.match));
    if (!route) throw new TypeError(`Unexpected fetch in test mock: ${call.url}`);
    return route.respond(call);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

const isLoginCall = (call: CapturedCall) => call.url.includes(LOGIN_PATH);
const loginCalls = (calls: CapturedCall[]) => calls.filter(isLoginCall);
const businessCalls = (calls: CapturedCall[]) => calls.filter((c) => !isLoginCall(c));

function loginConfig(
  overrides: Partial<ProvisioningConfig> & { mioLoginId?: string } = {},
): ProvisioningConfig {
  const { mioLoginId = TEST_LOGIN_ID, ...rest } = overrides;
  return { ...baseConfig({ mioBladeAuth: '', ...rest }), mioLoginId } as ProvisioningConfig;
}

/** 登录 + pageSupplier 都成功；每次登录返回一个新 token（便于断言用的是哪一个）。 */
function mockLoginAndSearch(opts: { loginExpSeconds?: number } = {}) {
  let loginCount = 0;
  const tokens: string[] = [];
  const harness = mockFetchRoutes([
    {
      match: LOGIN_PATH,
      respond: () => {
        loginCount += 1;
        const token = makeJwt(opts.loginExpSeconds ?? 24 * 3600);
        tokens.push(token);
        return jsonResponse({ code: 200, success: true, data: { token } });
      },
    },
    {
      match: SEARCH_PATH,
      respond: () => jsonResponse({ code: 200, success: true, data: { records: [], total: 0 } }),
    },
  ]);
  return { ...harness, tokens, loginCount: () => loginCount };
}

describe('米奥鉴权 — 登录换取 token', () => {
  it('首次调用：先登录换 token，再用 Blade-Auth: bearer <token> 调业务接口', async () => {
    const h = mockLoginAndSearch();

    await searchMioSuppliers(loginConfig(), { search: 'Acme' });

    expect(h.calls).toHaveLength(2);
    const [login, business] = h.calls;

    expect(login.url).toBe('https://mio.example.test/blade-agent-adapter/login/login.json');
    expect(login.body).toEqual({ login: TEST_LOGIN_ID });
    // 登录请求只带 Content-Type：不带 Blade-Auth / X-Supplier-Id / X-Feishu-Open-Id
    expect(login.headers).toEqual({ 'Content-Type': 'application/json' });

    expect(business.url).toBe(`https://mio.example.test${SEARCH_PATH}`);
    expect(business.headers['Blade-Auth']).toBe(`bearer ${h.tokens[0]}`);
    expect(business.headers['Content-Type']).toBe('application/json');
    expect(business.headers['X-Supplier-Id']).toBeUndefined();
    expect(business.headers['X-Feishu-Open-Id']).toBeUndefined();
  });

  it('预留头默认空且不参与任何请求（即使配了也不发）', async () => {
    const h = mockLoginAndSearch();
    const config = Object.assign(loginConfig(), {
      mioSupplierId: 'unit-test-supplier-id-placeholder',
      mioFeishuOpenId: 'unit-test-open-id-placeholder',
    }) as ProvisioningConfig;

    await searchMioSuppliers(config, { search: 'Acme' });

    for (const call of h.calls) {
      expect(call.headers['X-Supplier-Id']).toBeUndefined();
      expect(call.headers['X-Feishu-Open-Id']).toBeUndefined();
    }
    expect(h.calls[0].headers['Blade-Auth']).toBeUndefined(); // 登录请求不带 Blade-Auth
    expect(h.calls[1].headers['Blade-Auth']).toBeDefined();

    // 预留头取值可读（口径变化时的落点），但当前不进入请求头。
    expect(resolveReservedMioHeaders(config)).toEqual({
      'X-Supplier-Id': 'unit-test-supplier-id-placeholder',
      'X-Feishu-Open-Id': 'unit-test-open-id-placeholder',
    });
    expect(resolveReservedMioHeaders(loginConfig())).toEqual({});
  });

  it('缓存命中：第二次调用不重复登录', async () => {
    const h = mockLoginAndSearch();
    const config = loginConfig();

    await searchMioSuppliers(config, { search: 'Acme' });
    await searchMioSuppliers(config, { search: 'Beta' });

    expect(loginCalls(h.calls)).toHaveLength(1);
    expect(businessCalls(h.calls)).toHaveLength(2);
    expect(businessCalls(h.calls).map((c) => c.headers['Blade-Auth'])).toEqual([
      `bearer ${h.tokens[0]}`,
      `bearer ${h.tokens[0]}`,
    ]);
  });

  it('并发 5 个请求只触发 1 次登录（in-flight 合并）', async () => {
    let loginCount = 0;
    const token = makeJwt(24 * 3600);
    const h = mockFetchRoutes([
      {
        match: LOGIN_PATH,
        respond: async () => {
          loginCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return jsonResponse({ code: 200, success: true, data: { token } });
        },
      },
      { match: SEARCH_PATH, respond: () => jsonResponse({ code: 200, success: true, data: { records: [], total: 0 } }) },
      {
        match: QUICK_REGISTER_PATH,
        respond: () => jsonResponse({ code: 200, success: true, data: { supplierId: 123456789012 } }),
      },
    ]);
    const config = loginConfig();

    await Promise.all([
      searchMioSuppliers(config, { search: 'a' }),
      searchMioSuppliers(config, { search: 'b' }),
      quickRegisterMioSupplier(config, { companyName: 'Acme Ltd', mobile: '13800000000' }),
      searchMioSuppliers(config, { search: 'c' }),
      quickRegisterMioSupplier(config, { companyName: 'Beta Ltd', mobile: '13900000000' }),
    ]);

    expect(loginCount).toBe(1);
    expect(loginCalls(h.calls)).toHaveLength(1);
    expect(businessCalls(h.calls)).toHaveLength(5);
    for (const call of businessCalls(h.calls)) {
      expect(call.headers['Blade-Auth']).toBe(`bearer ${token}`);
    }
  });

  it('token 已过期（JWT exp 在过去）→ 重新登录', async () => {
    const h = mockLoginAndSearch({ loginExpSeconds: -10 });
    const config = loginConfig();

    await searchMioSuppliers(config, { search: 'Acme' });
    await searchMioSuppliers(config, { search: 'Acme' });

    expect(loginCalls(h.calls)).toHaveLength(2);
    expect(businessCalls(h.calls)).toHaveLength(2);
    expect(businessCalls(h.calls)[0].headers['Blade-Auth']).toBe(`bearer ${h.tokens[0]}`);
    expect(businessCalls(h.calls)[1].headers['Blade-Auth']).toBe(`bearer ${h.tokens[1]}`);
  });

  it('距到期不足 300 秒也算过期（提前刷新）', async () => {
    const expSeconds = 120;
    expect(expSeconds * 1000).toBeLessThan(MIO_TOKEN_EXPIRY_SKEW_MS);
    const h = mockLoginAndSearch({ loginExpSeconds: expSeconds });
    const config = loginConfig();

    await searchMioSuppliers(config, { search: 'Acme' });
    await searchMioSuppliers(config, { search: 'Acme' });

    expect(loginCalls(h.calls)).toHaveLength(2);
  });

  it('token 不是可解析 JWT（拿不到 exp）→ 按 24h 兜底缓存，不重复登录', async () => {
    const opaqueToken = 'unit-test-opaque-token-placeholder';
    let loginCount = 0;
    const h = mockFetchRoutes([
      {
        match: LOGIN_PATH,
        respond: () => {
          loginCount += 1;
          return jsonResponse({ code: 200, success: true, data: { token: opaqueToken } });
        },
      },
      {
        match: SEARCH_PATH,
        respond: () => jsonResponse({ code: 200, success: true, data: { records: [], total: 0 } }),
      },
    ]);
    const config = loginConfig();

    await searchMioSuppliers(config, { search: 'Acme' });
    await searchMioSuppliers(config, { search: 'Acme' });

    expect(loginCount).toBe(1);
    expect(businessCalls(h.calls).map((c) => c.headers['Blade-Auth'])).toEqual([
      `bearer ${opaqueToken}`,
      `bearer ${opaqueToken}`,
    ]);
  });

  it('上游 401 → 重取一次 token 并重试成功', async () => {
    let loginCount = 0;
    let businessCount = 0;
    const tokens: string[] = [];
    const h = mockFetchRoutes([
      {
        match: LOGIN_PATH,
        respond: () => {
          loginCount += 1;
          const token = makeJwt(24 * 3600);
          tokens.push(token);
          return jsonResponse({ code: 200, success: true, data: { token } });
        },
      },
      {
        match: SEARCH_PATH,
        respond: () => {
          businessCount += 1;
          return businessCount === 1
            ? jsonResponse({ code: 401, success: false, msg: 'Blade-Auth 无效' }, 401)
            : jsonResponse({ code: 200, success: true, data: { records: [{ id: 1, name: 'Acme Ltd' }], total: 1 } });
        },
      },
    ]);

    const result = await searchMioSuppliers(loginConfig(), { search: 'Acme' });

    expect(result.items).toEqual([{ id: '1', code: null, name: 'Acme Ltd' }]);
    expect(loginCount).toBe(2);
    expect(businessCount).toBe(2);
    // 重试用的是新 token
    expect(businessCalls(h.calls)[0].headers['Blade-Auth']).toBe(`bearer ${tokens[0]}`);
    expect(businessCalls(h.calls)[1].headers['Blade-Auth']).toBe(`bearer ${tokens[1]}`);
  });

  it('上游持续 401 → 只重取重试一次，然后按原错误抛出', async () => {
    let businessCount = 0;
    const h = mockFetchRoutes([
      {
        match: LOGIN_PATH,
        respond: () => jsonResponse({ code: 200, success: true, data: { token: makeJwt(24 * 3600) } }),
      },
      {
        match: SEARCH_PATH,
        respond: () => {
          businessCount += 1;
          return jsonResponse({ code: 401, success: false, msg: 'Blade-Auth 无效' }, 401);
        },
      },
    ]);

    await expect(searchMioSuppliers(loginConfig(), { search: 'Acme' })).rejects.toMatchObject({
      kind: 'http',
      status: 502,
      code: 'MIO_HTTP_ERROR',
    });

    expect(businessCount).toBe(2);
    expect(loginCalls(h.calls)).toHaveLength(2);
  });

  it('登录失败 → 抛清晰错误，且一个业务请求都不发', async () => {
    const h = mockFetchRoutes([
      { match: LOGIN_PATH, respond: () => jsonResponse({ code: 500, success: false, msg: 'login rejected' }) },
    ]);

    const err = (await searchMioSuppliers(loginConfig(), { search: 'Acme' }).catch((e) => e)) as MioApiError;

    expect(err).toBeInstanceOf(MioApiError);
    expect(err).toMatchObject({ kind: 'http', status: 503, code: 'MIO_LOGIN_FAILED', message: 'login rejected' });
    expect(businessCalls(h.calls)).toHaveLength(0);
    expect(String(err.message)).not.toContain(TEST_LOGIN_ID);
  });

  it('登录网络失败 / 缺 data.token 都归一为 MioApiError，且不发业务请求', async () => {
    const unreachable = mockFetchRoutes([
      {
        match: LOGIN_PATH,
        respond: () => {
          throw new TypeError('fetch failed');
        },
      },
    ]);
    await expect(searchMioSuppliers(loginConfig(), { search: 'Acme' })).rejects.toMatchObject({
      kind: 'network',
      code: 'MIO_LOGIN_UNREACHABLE',
    });
    expect(businessCalls(unreachable.calls)).toHaveLength(0);

    const noToken = mockFetchRoutes([
      { match: LOGIN_PATH, respond: () => jsonResponse({ code: 200, success: true, data: { ticket: 'nope' } }) },
    ]);
    await expect(searchMioSuppliers(loginConfig(), { search: 'Acme' })).rejects.toMatchObject({
      kind: 'parse',
      code: 'MIO_LOGIN_BAD_RESPONSE',
    });
    expect(businessCalls(noToken.calls)).toHaveLength(0);
  });

  it('登录不可用但有 MIO_BLADE_AUTH 兜底 → 用兜底 token（不静默、不无鉴权）', async () => {
    const h = mockFetchRoutes([
      { match: LOGIN_PATH, respond: () => jsonResponse({ code: 500, success: false, msg: 'login rejected' }) },
      { match: SEARCH_PATH, respond: () => jsonResponse({ code: 200, success: true, data: { records: [], total: 0 } }) },
    ]);

    await searchMioSuppliers(loginConfig({ mioBladeAuth: TEST_TOKEN }), { search: 'Acme' });

    expect(businessCalls(h.calls)).toHaveLength(1);
    expect(businessCalls(h.calls)[0].headers['Blade-Auth']).toBe(`bearer ${TEST_TOKEN}`);
  });

  it('没配 MIO_LOGIN_ID → 直接用静态兜底，不发登录请求', async () => {
    const h = mockFetchRoutes([
      { match: SEARCH_PATH, respond: () => jsonResponse({ code: 200, success: true, data: { records: [], total: 0 } }) },
    ]);

    await searchMioSuppliers(baseConfig(), { search: 'Acme' });

    expect(loginCalls(h.calls)).toHaveLength(0);
    expect(businessCalls(h.calls)[0].headers['Blade-Auth']).toBe(`bearer ${TEST_TOKEN}`);
  });

  it('登录与兜底都不可用 → MIO_AUTH_NOT_CONFIGURED，且一个请求都不发', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const config = loginConfig({ mioLoginId: '', mioBladeAuth: '' });

    await expect(searchMioSuppliers(config, { search: 'Acme' })).rejects.toMatchObject({
      kind: 'config',
      status: 503,
      code: 'MIO_AUTH_NOT_CONFIGURED',
    });
    await expect(
      quickRegisterMioSupplier(config, { companyName: 'Acme Ltd', mobile: '13800000000' }),
    ).rejects.toMatchObject({ kind: 'config', status: 503, code: 'MIO_AUTH_NOT_CONFIGURED' });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('MIO_LOGIN_ID 走 env 也能生效（配置对象不接线时）', async () => {
    expect(resolveMioLoginId(baseConfig())).toBe('');
    process.env.MIO_LOGIN_ID = TEST_LOGIN_ID;
    const h = mockLoginAndSearch();

    await searchMioSuppliers(baseConfig({ mioBladeAuth: '' }), { search: 'Acme' });

    expect(resolveMioLoginId(baseConfig())).toBe(TEST_LOGIN_ID);
    expect(h.calls[0].url).toBe('https://mio.example.test/blade-agent-adapter/login/login.json');
    expect(h.calls[0].body).toEqual({ login: TEST_LOGIN_ID });
  });

  it('config 里的 MIO_LOGIN_ID 优先于 env', () => {
    process.env.MIO_LOGIN_ID = 'unit-test-env-login-id-placeholder';
    expect(resolveMioLoginId(loginConfig())).toBe(TEST_LOGIN_ID);
    expect(resolveMioLoginId(baseConfig())).toBe('unit-test-env-login-id-placeholder');
  });

  it('assertMioConfigured：有 MIO_LOGIN_ID 即可，两者都缺时抛 config 错误', () => {
    expect(() => assertMioConfigured(loginConfig())).not.toThrow();
    expect(() => assertMioConfigured(baseConfig())).not.toThrow();
    expect(() => assertMioConfigured(loginConfig({ mioLoginId: '', mioBladeAuth: '' }))).toThrow(MioApiError);
  });

  it('token 值不出现在日志、返回值或抛出的错误里', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const token = makeJwt(24 * 3600);
    mockFetchRoutes([
      { match: LOGIN_PATH, respond: () => jsonResponse({ code: 200, success: true, data: { token } }) },
      {
        match: SEARCH_PATH,
        respond: () => jsonResponse({ code: 200, success: true, data: { records: [{ id: 1, name: 'Acme Ltd' }], total: 1 } }),
      },
      {
        match: QUICK_REGISTER_PATH,
        respond: () => jsonResponse({ code: 500, success: false, msg: '该公司名称已存在' }),
      },
    ]);
    const config = loginConfig();

    const search = await searchMioSuppliers(config, { search: 'Acme' });
    const createErr = (await quickRegisterMioSupplier(config, {
      companyName: 'Acme Ltd',
      mobile: '13800000000',
    }).catch((e) => e)) as MioApiError;

    expect(JSON.stringify(search)).not.toContain(token);
    expect(String(createErr.message)).not.toContain(token);
    const logged = spies.map((spy) => spy.mock.calls.flat().map(String).join('|')).join('|');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(TEST_LOGIN_ID);

    spies.forEach((spy) => spy.mockRestore());
  });
});
