import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { GlobalModelPolicyRecord, ProviderModelRecord } from '../domain/model-catalog.js';
import { GlobalPolicyBackfillService } from '../services/global-policy-backfill.js';
import type { LlmProvidersConfig } from '../services/llm-providers.js';
import type { ProviderInstanceRecord } from '../services/model-catalog.js';

const legacy: LlmProvidersConfig = {
  providers: [],
  defaultModel: 'provider-a/chat',
  imageModel: 'provider-a/vision',
  compactionModel: 'provider-b/compact',
  fallbackModels: ['provider-b/fallback'],
};

const emptyCurrent: GlobalModelPolicyRecord = {
  defaultModel: null,
  imageModel: null,
  compactionModel: null,
  fallbackModels: [],
  revision: 0,
  updatedAt: new Date(0),
};

function provider(name: string, id: string): ProviderInstanceRecord {
  return {
    id,
    legacyProviderName: name,
    templateKey: 'custom-openai',
    protocol: 'openai-completions',
    baseUrl: 'https://example.test',
    encryptedApiKey: 'not-used',
    source: 'legacy-import',
    enabled: true,
  };
}

function model(id: string, providerInstanceId: string, modelId: string, runtimeEnabled = true): ProviderModelRecord {
  return {
    id,
    providerInstanceId,
    modelId,
    modelType: 'chat',
    runtimeEnabled,
    effectiveParams: {},
    paramsStatus: 'incomplete',
    schemaVersion: 1,
  };
}

function catalog() {
  return [
    {
      provider: provider('provider-a', 'lpi_a'),
      models: [model('lpm_chat', 'lpi_a', 'chat'), model('lpm_vision', 'lpi_a', 'vision')],
    },
    {
      provider: provider('provider-b', 'lpi_b'),
      models: [model('lpm_compact', 'lpi_b', 'compact'), model('lpm_fallback', 'lpi_b', 'fallback')],
    },
  ];
}

function setup(options: {
  legacy?: LlmProvidersConfig;
  current?: GlobalModelPolicyRecord | null;
  catalog?: ReturnType<typeof catalog>;
} = {}) {
  const update = vi.fn(async (input, revision) => ({
    ...input,
    revision: revision + 1,
    updatedAt: new Date(1),
  }));
  const repository = {
    listCatalogReferenceCandidates: vi.fn(async () => options.catalog ?? catalog()),
    getGlobalModelPolicy: vi.fn(async () => options.current === undefined ? emptyCurrent : options.current),
    updateGlobalModelPolicy: update,
  };
  const loadLegacy = vi.fn(async () => options.legacy ?? legacy);
  const service = new GlobalPolicyBackfillService(
    {} as pg.Pool,
    repository,
    loadLegacy,
  );
  return { service, repository, update, loadLegacy };
}

describe('GlobalPolicyBackfillService', () => {
  it('previews a complete unique mapping without writing', async () => {
    const { service, update } = setup();
    const result = await service.preview();
    expect(result.ready).toBe(true);
    expect(result.resolvedIds).toEqual({
      defaultModel: 'lpm_chat',
      imageModel: 'lpm_vision',
      compactionModel: 'lpm_compact',
      fallbackModels: ['lpm_fallback'],
    });
    expect(result.missingRefs).toEqual([]);
    expect(result.ambiguousRefs).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('reports missing, ambiguous, and disabled references', async () => {
    const duplicateCatalog = catalog();
    duplicateCatalog[1].models.push(model('lpm_chat_duplicate', 'lpi_b', 'unused'));
    duplicateCatalog.push({
      provider: provider('provider-a', 'lpi_duplicate'),
      models: [model('lpm_chat_duplicate_2', 'lpi_duplicate', 'chat')],
    });
    duplicateCatalog[0].models[1].runtimeEnabled = false;
    const brokenLegacy = {
      ...legacy,
      compactionModel: 'provider-b/missing',
    };
    const { service } = setup({ legacy: brokenLegacy, catalog: duplicateCatalog });
    const result = await service.preview();
    expect(result.ready).toBe(false);
    expect(result.missingRefs).toEqual([{ kind: 'compactionModel', ref: 'provider-b/missing' }]);
    expect(result.ambiguousRefs).toEqual([{
      kind: 'defaultModel',
      ref: 'provider-a/chat',
      candidateIds: ['lpm_chat', 'lpm_chat_duplicate_2'],
    }]);
    expect(result.disabledRefs).toEqual([{
      kind: 'imageModel',
      ref: 'provider-a/vision',
      candidateIds: ['lpm_vision'],
    }]);
  });

  it('blocks overwrite unless forced', async () => {
    const current = { ...emptyCurrent, defaultModel: 'lpm_other', revision: 4 };
    const { service, update } = setup({ current });
    const preview = await service.preview();
    expect(preview.overwriteBlocked).toBe(true);
    await expect(service.apply({ dryRun: false })).rejects.toMatchObject({
      code: 'POLICY_ALREADY_CONFIGURED',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('returns an idempotent no-op when the policy is equivalent', async () => {
    const current = {
      ...emptyCurrent,
      defaultModel: 'lpm_chat', imageModel: 'lpm_vision', compactionModel: 'lpm_compact',
      fallbackModels: ['lpm_fallback'], revision: 7,
    };
    const { service, update } = setup({ current });
    const result = await service.apply({ dryRun: false });
    expect(result.action).toBe('no-op');
    expect(result.policy).toBe(current);
    expect(update).not.toHaveBeenCalled();
  });

  it('dry-run defaults true and never updates', async () => {
    const { service, update } = setup();
    const result = await service.apply();
    expect(result.action).toBe('dry-run');
    expect(update).not.toHaveBeenCalled();
  });

  it('applies using the current revision and actor', async () => {
    const { service, update } = setup({ current: { ...emptyCurrent, revision: 12 } });
    const result = await service.apply({ dryRun: false, actor: 'admin' });
    expect(result.action).toBe('applied');
    expect(update).toHaveBeenCalledWith(result.resolvedIds, 12, 'admin');
  });

  it('rejects apply when any reference is unresolved', async () => {
    const { service, update } = setup({ legacy: { ...legacy, defaultModel: 'missing/model' } });
    await expect(service.apply({ dryRun: false })).rejects.toMatchObject({
      code: 'BACKFILL_NOT_READY',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('never treats unresolved references as equivalent to an empty policy', async () => {
    const { service, update } = setup({
      legacy: {
        providers: [],
        defaultModel: 'missing/model',
        imageModel: null,
        compactionModel: null,
        fallbackModels: [],
      },
      catalog: [],
    });
    const preview = await service.preview();
    expect(preview).toMatchObject({ ready: false, equivalent: false });
    expect(preview.missingRefs).toEqual([{ kind: 'defaultModel', ref: 'missing/model' }]);
    await expect(service.apply({ dryRun: false })).rejects.toMatchObject({
      code: 'BACKFILL_NOT_READY',
    });
    expect(update).not.toHaveBeenCalled();
  });
});
