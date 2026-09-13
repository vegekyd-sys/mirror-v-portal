import { describe, expect, it } from 'vitest';
import { ModelMutationSchema, ModelRuntimeParamsV1Schema, mergeModelRuntimeParams } from '../domain/model-catalog.js';
import { encryptValue } from '../services/crypto.js';
import {
  CatalogRepository, CatalogService, snapshotFingerprint, stableProviderInstanceId, stableProviderModelId,
} from '../services/model-catalog.js';

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
