import { describe, expect, it } from 'vitest';
import { ModelMutationSchema, ModelRuntimeParamsV1Schema, mergeModelRuntimeParams } from '../domain/model-catalog.js';
import { encryptValue } from '../services/crypto.js';
import {
  CatalogRepository, CatalogService, snapshotFingerprint, stableProviderInstanceId, stableProviderModelId,
} from '../services/model-catalog.js';
import { BuiltinModelParamSource } from '../services/model-param-sources/builtin.js';
import { OpenAiCompatibleModelParamSource } from '../services/model-param-sources/openai-compatible.js';

describe('model catalog domain', () => {
  it('rejects invalid cross-field values and client-owned effective params', () => {
    expect(ModelRuntimeParamsV1Schema.safeParse({ contextWindow: 10, maxOutputTokens: 11 }).success).toBe(false);
    expect(ModelRuntimeParamsV1Schema.safeParse({ vision: true, inputModalities: ['text'] }).success).toBe(false);
    expect(ModelMutationSchema.safeParse({ modelId: 'm', modelType: 'chat', effectiveParams: {} }).success).toBe(false);
  });

  it('merges nested values by override, discovered, then fallback', () => {
    const result = mergeModelRuntimeParams(
      { contextWindow: 100, maxOutputTokens: 20, compat: { a: true, b: 'old' } },
      { maxOutputTokens: 30, compat: { b: 'new' } },
    );
    expect(result.effectiveParams).toMatchObject({
      contextWindow: 100, maxOutputTokens: 30, inputModalities: ['text'], compat: { a: true, b: 'new' },
    });
    expect(result.status).toBe('fallback');
  });

  it('discovers only the exact verified Aliyun qwen alias without guessing other aliases', async () => {
    const observedAt = new Date('2026-09-13T14:30:00.123Z');
    const source = new BuiltinModelParamSource(() => observedAt);
    const result = await source.preview({
      provider: {
        id: 'provider', legacyProviderName: 'aochi-aliyun', templateKey: 'custom-openai',
        baseUrl: 'https://workspace-123.maas.aliyuncs.com/compatible-mode/v1', updatedAt: new Date(0).toISOString(),
      },
      modelIds: ['qwen3.7-plus', 'deepseek-v3.2', 'gpt-5.2'],
    });
    expect(result.candidates[0].params).toEqual({
      contextWindow: 1_000_000,
      maxInputTokens: 991_808,
      maxOutputTokens: 131_072,
      maxReasoningTokens: 262_144,
      inputModalities: ['text', 'image', 'video'],
      outputModalities: ['text'],
      reasoning: true,
      vision: true,
      toolCalling: true,
      structuredOutput: true,
    });
    expect(result.candidates[0].unresolvedFields).toEqual([]);
    expect(result.source).toMatchObject({
      url: 'https://help.aliyun.com/zh/model-studio/qwen3-7-plus',
      version: 'qwen3.7-plus-2026-05-26',
      observedAt: observedAt.toISOString(),
    });
    expect(result.candidates[0].evidence.every((item) => item.observedAt === observedAt.toISOString())).toBe(true);
    expect(result.candidates[1].params).toEqual({});
    expect(result.candidates[1].unresolvedFields).toContain('exact-alias-evidence');
    expect(result.candidates[2].params).toEqual({});
  });

  it('reports provider-api parameter discovery as explicitly unsupported', async () => {
    const source = new OpenAiCompatibleModelParamSource();
    await expect(source.preview({
      provider: {
        id: 'provider', legacyProviderName: 'proxy', templateKey: 'custom-openai',
        baseUrl: 'https://proxy.example.com/v1', updatedAt: new Date(0).toISOString(),
      },
      modelIds: ['gpt-5.2'],
    })).rejects.toThrow(/unsupported/);
  });

  it('requires exact provider and hardened Aliyun MaaS endpoint matching', async () => {
    const source = new BuiltinModelParamSource(() => new Date(0));
    const rejectedBaseUrls = [
      'https://oss.aliyuncs.com/compatible-mode/v1',
      'https://evil.aliyuncs.com/compatible-mode/v1',
      'https://maas.aliyuncs.com.evil.com/compatible-mode/v1',
      'https://maas.aliyuncs.com/compatible-mode/v1',
      'https://user@workspace-123.maas.aliyuncs.com/compatible-mode/v1',
      'https://workspace-123.maas.aliyuncs.com:8443/compatible-mode/v1',
      'http://workspace-123.maas.aliyuncs.com/compatible-mode/v1',
      'https://workspace-123.maas.aliyuncs.com/v1',
      'https://workspace-123.maas.aliyuncs.com/compatible-mode/v1/extra',
    ];
    for (const baseUrl of rejectedBaseUrls) {
      const result = await source.preview({
        provider: {
          id: 'provider', legacyProviderName: 'aochi-aliyun', templateKey: 'custom-openai',
          baseUrl, updatedAt: new Date(0).toISOString(),
        },
        modelIds: ['qwen3.7-plus'],
      });
      expect(result.candidates[0].params, baseUrl).toEqual({});
    }
    const wrongProvider = await source.preview({
      provider: {
        id: 'provider', legacyProviderName: 'deepseek', templateKey: 'custom-openai',
        baseUrl: 'https://workspace-123.maas.aliyuncs.com/compatible-mode/v1', updatedAt: new Date(0).toISOString(),
      },
      modelIds: ['qwen3.7-plus'],
    });
    expect(wrongProvider.candidates[0].params).toEqual({});

    const wrongTemplate = await source.preview({
      provider: {
        id: 'provider', legacyProviderName: 'aochi-aliyun', templateKey: 'aliyun-native',
        baseUrl: 'https://workspace-123.maas.aliyuncs.com/compatible-mode/v1', updatedAt: new Date(0).toISOString(),
      },
      modelIds: ['qwen3.7-plus'],
    });
    expect(wrongTemplate.candidates[0].params).toEqual({});
    expect(wrongTemplate.candidates[0].unresolvedFields).toContain('exact-alias-evidence');
  });

  it('generates stable versioned identifiers and canonical snapshot fingerprints', () => {
    const providerId = stableProviderInstanceId('deepseek');
    expect(providerId).toMatch(/^lpi_[a-f0-9]{24}$/);
    expect(stableProviderInstanceId('deepseek')).toBe(providerId);
    expect(stableProviderModelId(providerId, 'deepseek-v4')).toMatch(/^lpm_[a-f0-9]{24}$/);
    const first = { providers: [], defaultModel: null, imageModel: null, compactionModel: null, fallbackModels: [] };
    const reordered = { fallbackModels: [], compactionModel: null, imageModel: null, defaultModel: null, providers: [] };
    expect(snapshotFingerprint(first)).toBe(snapshotFingerprint(reordered));
  });

  it('reports provider, model, and reference preview differences', async () => {
    process.env.RUNTIME_CONFIG_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const repository = {
      listRuntimeCatalog: async () => [{
      provider: {
        id: 'p1', legacyProviderName: 'new-provider', templateKey: 'custom-openai',
        protocol: 'openai-completions', baseUrl: 'https://example.invalid', encryptedApiKey: encryptValue('secret'),
        source: 'manual', enabled: true,
      },
      models: [{
        id: 'm1', providerInstanceId: 'p1', modelId: 'new-model', modelType: 'chat',
        runtimeEnabled: true, effectiveParams: { inputModalities: ['text'], outputModalities: ['text'] },
        paramsStatus: 'fallback', schemaVersion: 1,
      }],
    }],
    } as unknown as CatalogRepository;
    const service = new CatalogService(repository);
    const legacy = {
      providers: [{ name: 'old-provider', baseUrl: 'https://old.invalid', apiKey: 'secret', models: [{ id: 'old-model' }] }],
      defaultModel: 'old-provider/old-model', imageModel: null, compactionModel: null,
      fallbackModels: ['old-provider/old-model'],
    };
    const snapshot = await service.buildCompatibilitySnapshot(legacy);
    const diff = service.diffCompatibilitySnapshot(legacy, snapshot);
    expect(diff.addedProviders).toEqual(['new-provider']);
    expect(diff.removedProviders).toEqual(['old-provider']);
    expect(diff.addedModels).toEqual(['new-provider/new-model']);
    expect(diff.removedModels).toEqual(['old-provider/old-model']);
    expect(diff.changedReferences.map((item) => item.reference)).toEqual(['defaultModel', 'fallbackModels']);
    expect(diff.fingerprint).toBe(snapshotFingerprint(snapshot));
  });
});
