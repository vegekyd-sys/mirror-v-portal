import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MioApiError,
  MIO_REQUEST_TIMEOUT_MS,
  assertMioConfigured,
  quickRegisterMioSupplier,
  searchMioSuppliers,
} from '../services/mio-supplier-client.js';
import type { ProvisioningConfig } from '../config.js';

// 注意：这里用的是**假**凭据占位符，任何时候都不得把真实 MIO_BLADE_AUTH 写进
// 代码/测试/示例。生产凭据只通过 env 注入。
const TEST_TOKEN = 'unit-test-blade-token-placeholder';

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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
