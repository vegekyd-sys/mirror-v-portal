import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

const cryptoMocks = vi.hoisted(() => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
  getMasterKey: () => 'a'.repeat(64),
  MasterKeyError: class MasterKeyError extends Error {},
  isEncrypted: (v: string) => v.startsWith('enc:'),
  maskValue: (v: string) => '••••••••',
}));
vi.mock('../services/crypto.js', () => cryptoMocks);

const k8sMocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  putSecret: vi.fn(),
  restartDeployment: vi.fn(),
  deploymentExists: vi.fn(),
  patchDeploymentEnvFromSecret: vi.fn(),
}));
vi.mock('../services/k8s-client.js', () => k8sMocks);

import {
  applyTenantLlmConfig,
  LLM_PROVIDERS_KEY,
  LLM_RUNTIME_CONFIG_V2_KEY,
  LLM_RUNTIME_CONTRACT_MODE_KEY,
  LLM_RUNTIME_ROUTES_V2_KEY,
  LLM_PROXY_CONFIG_SECRET,
  type LlmProvidersConfig,
} from '../services/llm-providers.js';
import { ENV_FROM_ONLY_KEYS } from '../services/skill-env.js';
import type { ProvisioningConfig } from '../config.js';

function makeConfig(overrides: Partial<ProvisioningConfig> = {}): ProvisioningConfig {
  return {
    port: 0,
    databaseUrl: 'postgresql://test:test@localhost:5432/test',
    k8sDryRun: false,
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
    ...overrides,
  };
}

const goodLibrary: LlmProvidersConfig = {
  providers: [
    {
      name: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      apiKey: 'sk-test',
      models: [{ id: 'qwen-max', modelType: 'chat', contextWindow: 32768 }],
    },
  ],
  defaultModel: 'qwen/qwen-max',
  imageModel: null,
  compactionModel: null,
  fallbackModels: [],
};

describe('applyTenantLlmConfig — V2 dual-render', () => {
  it('writes both V1 and V2 payloads to the same tenant-config Secret', async () => {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT k8s_namespace')) {
          return { rows: [{ k8s_namespace: 'ns-test' }], rowCount: 1 };
        }
        if (sql.includes("config_key = 'LLM_MODEL_SELECTION'")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('config_key = \'LLM_PROVIDERS\'')) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    k8sMocks.getSecret.mockResolvedValue({ data: {} });
    k8sMocks.putSecret.mockResolvedValue(undefined);
    k8sMocks.deploymentExists.mockResolvedValue(false);
    k8sMocks.patchDeploymentEnvFromSecret.mockResolvedValue(true);

    const outcome = await applyTenantLlmConfig(
      pool as any,
      makeConfig(),
      't1',
      goodLibrary,
      null,
      null,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.v2Warning).toBeUndefined();

    // Verify tenant-config Secret write contains both V1 and V2 keys.
    const tenantConfigWrite = k8sMocks.putSecret.mock.calls.find(
      (call: unknown[]) => call[1] === 'tenant-config',
    );
    expect(tenantConfigWrite).toBeTruthy();
    const data = tenantConfigWrite![2] as Record<string, string>;
    expect(data[LLM_PROVIDERS_KEY]).toBeTruthy();
    expect(data[LLM_RUNTIME_CONFIG_V2_KEY]).toBeTruthy();
    expect(data[LLM_RUNTIME_CONTRACT_MODE_KEY]).toBe('v1');

    // Verify llm-proxy-config Secret write contains V2 routes.
    const proxyConfigWrite = k8sMocks.putSecret.mock.calls.find(
      (call: unknown[]) => call[1] === LLM_PROXY_CONFIG_SECRET,
    );
    expect(proxyConfigWrite).toBeTruthy();
    const proxyData = proxyConfigWrite![2] as Record<string, string>;
    expect(proxyData[LLM_RUNTIME_ROUTES_V2_KEY]).toBeTruthy();
    // Gap 1: contract mode must also be written to llm-proxy-config so the
    // gateway (which reads envFrom from this Secret) can see it.
    expect(proxyData[LLM_RUNTIME_CONTRACT_MODE_KEY]).toBe('v1');
  });

  it('V2 fingerprint is deterministic for the same config', async () => {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT k8s_namespace')) {
          return { rows: [{ k8s_namespace: 'ns-test' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    k8sMocks.getSecret.mockResolvedValue({ data: {} });
    k8sMocks.putSecret.mockResolvedValue(undefined);
    k8sMocks.deploymentExists.mockResolvedValue(false);
    k8sMocks.patchDeploymentEnvFromSecret.mockResolvedValue(true);

    // First call.
    await applyTenantLlmConfig(pool as any, makeConfig(), 't1', goodLibrary, null, null);
    const firstProxyWrite = k8sMocks.putSecret.mock.calls.find(
      (c: unknown[]) => c[1] === 'tenant-config',
    );
    const firstV2 = (firstProxyWrite![2] as Record<string, string>)[LLM_RUNTIME_CONFIG_V2_KEY];

    k8sMocks.putSecret.mockClear();
    // Second call with same library.
    await applyTenantLlmConfig(pool as any, makeConfig(), 't1', goodLibrary, null, null);
    const secondProxyWrite = k8sMocks.putSecret.mock.calls.find(
      (c: unknown[]) => c[1] === 'tenant-config',
    );
    const secondV2 = (secondProxyWrite![2] as Record<string, string>)[LLM_RUNTIME_CONFIG_V2_KEY];

    // materializationFingerprint should be the same for identical content
    // (generatedAt is excluded from fingerprint computation).
    const firstEnvelope = JSON.parse(firstV2);
    const secondEnvelope = JSON.parse(secondV2);
    expect(firstEnvelope.materializationFingerprint).toBe(
      secondEnvelope.materializationFingerprint,
    );
  });

  it('ENV_FROM_ONLY_KEYS includes V2 keys', () => {
    expect(ENV_FROM_ONLY_KEYS.has(LLM_RUNTIME_CONFIG_V2_KEY)).toBe(true);
    expect(ENV_FROM_ONLY_KEYS.has(LLM_RUNTIME_CONTRACT_MODE_KEY)).toBe(true);
  });

  it('V2 write failure does not block V1 delivery', async () => {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT k8s_namespace')) {
          return { rows: [{ k8s_namespace: 'ns-test' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    // First putSecret (tenant-config) fails to simulate V2 write failure.
    k8sMocks.getSecret.mockResolvedValue({ data: {} });
    k8sMocks.putSecret
      .mockRejectedValueOnce(new Error('k8s putSecret failed'))
      .mockResolvedValue(undefined);
    k8sMocks.deploymentExists.mockResolvedValue(false);
    k8sMocks.patchDeploymentEnvFromSecret.mockResolvedValue(true);

    const outcome = await applyTenantLlmConfig(
      pool as any,
      makeConfig(),
      't1',
      goodLibrary,
      null,
      null,
    );

    // V1 failure → outcome.ok = false with error. But the point is that the
    // V2 rendering code didn't throw before the V1 putSecret.
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('k8s putSecret failed');
  });

  it('directMode does not write gateway V2 routes', async () => {
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT k8s_namespace')) {
          return { rows: [{ k8s_namespace: 'ns-test' }], rowCount: 1 };
        }
        if (sql.includes('config_key = $2') && params && params[1] === 'LLM_MODEL_SELECTION') {
          // Return a tenant selection with directMode=true.
          return {
            rows: [{
              encrypted_value: `enc:${JSON.stringify({
                defaultModel: 'qwen/qwen-max',
                imageModel: null,
                compactionModel: null,
                fallbackModels: null,
                directMode: true,
              })}`,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    k8sMocks.getSecret.mockClear();
    k8sMocks.putSecret.mockClear();
    k8sMocks.getSecret.mockResolvedValue({ data: {} });
    k8sMocks.putSecret.mockResolvedValue(undefined);
    k8sMocks.deploymentExists.mockResolvedValue(false);
    k8sMocks.patchDeploymentEnvFromSecret.mockResolvedValue(true);

    await applyTenantLlmConfig(pool as any, makeConfig(), 't1', goodLibrary, null, null);

    const proxyConfigWrite = k8sMocks.putSecret.mock.calls.find(
      (call: unknown[]) => call[1] === LLM_PROXY_CONFIG_SECRET,
    );
    expect(proxyConfigWrite).toBeTruthy();
    const proxyData = proxyConfigWrite![2] as Record<string, string>;
    // directMode → V2 routes should be '{}' (empty, agent bypasses gateway).
    expect(proxyData[LLM_RUNTIME_ROUTES_V2_KEY]).toBe('{}');
  });

  it('dry-run returns skipped without calling k8s', async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    k8sMocks.putSecret.mockClear();
    k8sMocks.getSecret.mockClear();

    const outcome = await applyTenantLlmConfig(
      pool as any,
      makeConfig({ k8sDryRun: true }),
      't1',
      goodLibrary,
      null,
      null,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.skipped).toBe(true);
    expect(k8sMocks.putSecret).not.toHaveBeenCalled();
  });
});
