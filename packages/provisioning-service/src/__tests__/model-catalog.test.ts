import { describe, expect, it } from 'vitest';
import { ModelMutationSchema, ModelRuntimeParamsV1Schema, mergeModelRuntimeParams } from '../domain/model-catalog.js';
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

  it('overlays only approved complete model runtime fields and preserves legacy structure', async () => {
    const legacyModel = {
      id: 'qwen3.7-plus', displayName: 'Qwen rolling alias', customCapability: 'keep-me',
      compat: { zeta: true, alpha: 'legacy' },
    };
    const fallbackModels = Array.from({ length: 8 }, (_, index) => ({
      id: index === 0 ? 'gpt-5.2' : `proxy-model-${index + 1}`,
      inputModalities: ['image', 'text'] as Array<'image' | 'text'>,
      reasoning: true,
      customCapability: { passthrough: true, index },
    }));
    const repository = {
      listRuntimeCatalog: async () => [{
        provider: {
          id: 'p1', legacyProviderName: 'aochi-aliyun', templateKey: 'custom-openai',
          protocol: 'openai-completions', baseUrl: 'https://catalog.invalid', encryptedApiKey: 'unused-catalog-ciphertext',
          source: 'manual', enabled: true,
        },
        models: [
          {
            id: 'm1', providerInstanceId: 'p1', modelId: 'qwen3.7-plus', modelType: 'chat',
            runtimeEnabled: true, discoveredParams: {
              contextWindow: 1_000_000, maxInputTokens: 991_808, maxOutputTokens: 131_072,
              maxReasoningTokens: 262_144, inputModalities: ['text', 'image', 'video'],
              outputModalities: ['text'], reasoning: true, vision: true, toolCalling: true,
              structuredOutput: true,
            },
            effectiveParams: {
              contextWindow: 8_192, maxOutputTokens: 1_024,
              inputModalities: ['text'], outputModalities: ['text'],
            },
            paramsStatus: 'complete', snapshotApproved: true, schemaVersion: 1,
          },
          ...fallbackModels.map((model, index) => ({
            id: `m${index + 2}`,
            providerInstanceId: 'p1',
            modelId: model.id,
            modelType: 'chat' as const,
            runtimeEnabled: true,
            effectiveParams: { inputModalities: ['text'] as const, outputModalities: ['text'] as const },
            paramsStatus: 'fallback' as const,
            snapshotApproved: false,
            schemaVersion: 1 as const,
          })),
        ],
      }],
    } as unknown as CatalogRepository;
    const service = new CatalogService(repository);
    const legacy = {
      providers: [{
        name: 'aochi-aliyun', label: 'Production', baseUrl: 'https://legacy.invalid', apiKey: 'legacy-secret',
        models: [legacyModel, ...fallbackModels],
      }],
      defaultModel: 'aochi-aliyun/gpt-5.2', imageModel: 'aochi-aliyun/gpt-5.2',
      compactionModel: 'aochi-aliyun/gpt-5.2', fallbackModels: ['aochi-aliyun/qwen3.7-plus'],
    } as unknown as import('../services/llm-providers.js').LlmProvidersConfig;

    const snapshot = await service.buildCompatibilitySnapshot(legacy);
    expect(snapshot.providers[0]).toMatchObject({
      name: 'aochi-aliyun', label: 'Production', baseUrl: 'https://legacy.invalid', apiKey: 'legacy-secret',
    });
    expect(snapshot.providers[0].models.slice(1)).toEqual(fallbackModels);
    expect(snapshot.providers[0].models[0]).toMatchObject({
      id: 'qwen3.7-plus', displayName: 'Qwen rolling alias', customCapability: 'keep-me',
      contextWindow: 1_000_000, maxOutputTokens: 131_072,
      inputModalities: ['text', 'image', 'video'], reasoning: true, vision: true,
      compat: { zeta: true, alpha: 'legacy' },
    });
    expect(snapshot.providers[0].models[0]).not.toHaveProperty('maxInputTokens');
    expect(snapshot.providers[0].models[0]).not.toHaveProperty('maxReasoningTokens');
    expect(snapshot.providers[0].models[0]).not.toHaveProperty('outputModalities');
    expect(snapshot.providers[0].models[0]).not.toHaveProperty('toolCalling');
    expect(snapshot.providers[0].models[0]).not.toHaveProperty('structuredOutput');
    expect(snapshot.defaultModel).toBe(legacy.defaultModel);
    expect(snapshot.imageModel).toBe(legacy.imageModel);
    expect(snapshot.compactionModel).toBe(legacy.compactionModel);
    expect(snapshot.fallbackModels).toEqual(legacy.fallbackModels);

    const diff = service.diffCompatibilitySnapshot(legacy, snapshot);
    expect(diff).toMatchObject({
      addedProviders: [], removedProviders: [], changedProviders: [],
      addedModels: [], removedModels: [], changedModels: ['aochi-aliyun/qwen3.7-plus'],
      affectedProviders: ['aochi-aliyun'], changedReferences: [],
    });
    expect(diff.fallbackWarnings).toHaveLength(8);
    expect(diff.fallbackWarnings[0]).toEqual({
      providerName: 'aochi-aliyun', modelId: 'gpt-5.2', fallbackFields: ['inputModalities', 'outputModalities'],
    });
    expect(diff.fallbackWarnings.map((warning) => warning.modelId)).toEqual(
      fallbackModels.map((model) => model.id),
    );
    expect(diff.fingerprint).toBe(snapshotFingerprint(snapshot));
  });

  it('fails closed when a legacy provider or model is absent from the catalog', async () => {
    const repository = { listRuntimeCatalog: async () => [] } as unknown as CatalogRepository;
    const service = new CatalogService(repository);
    const legacy = {
      providers: [{ name: 'legacy', baseUrl: 'https://legacy.invalid', apiKey: 'secret', models: [{ id: 'model' }] }],
      defaultModel: 'legacy/model', imageModel: null, compactionModel: null, fallbackModels: [],
    };
    await expect(service.buildCompatibilitySnapshot(legacy)).rejects.toThrow('Catalog provider missing');
  });

  it('uses semantic model comparison without changing payload fingerprints', () => {
    const repository = {} as CatalogRepository;
    const service = new CatalogService(repository);
    const before = {
      providers: [{
        name: 'provider', baseUrl: 'https://example.invalid', apiKey: 'secret',
        models: [{ id: 'model', inputModalities: ['video', 'text', 'text'], compat: { z: true, a: 1 } }],
      }],
      defaultModel: 'provider/model', imageModel: null, compactionModel: null, fallbackModels: [],
    } as import('../services/llm-providers.js').LlmProvidersConfig;
    const reordered: import('../services/llm-providers.js').LlmProvidersConfig = {
      ...before,
      providers: [{
        ...before.providers[0],
        models: [{
          id: 'model', modelType: 'chat', protocol: 'openai-completions',
          inputModalities: ['text', 'video'], compat: { a: 1, z: true },
        }],
      }],
    };
    const semanticDiff = service.diffCompatibilitySnapshot(before, reordered);
    expect(semanticDiff.changedProviders).toEqual([]);
    expect(semanticDiff.changedModels).toEqual([]);
    expect(snapshotFingerprint(before)).not.toBe(snapshotFingerprint(reordered));

    const capabilityChange = structuredClone(reordered);
    capabilityChange.providers[0].models[0].contextWindow = 128_000;
    expect(service.diffCompatibilitySnapshot(before, capabilityChange).changedModels).toEqual(['provider/model']);
  });
});
