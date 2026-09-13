import { describe, expect, it } from 'vitest';
import { ModelMutationSchema, ModelRuntimeParamsV1Schema, mergeModelRuntimeParams } from '../domain/model-catalog.js';
import { stableProviderInstanceId, stableProviderModelId } from '../services/model-catalog.js';

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

  it('generates stable versioned identifiers', () => {
    const providerId = stableProviderInstanceId('deepseek');
    expect(providerId).toMatch(/^lpi_[a-f0-9]{24}$/);
    expect(stableProviderInstanceId('deepseek')).toBe(providerId);
    expect(stableProviderModelId(providerId, 'deepseek-v4')).toMatch(/^lpm_[a-f0-9]{24}$/);
  });
});
