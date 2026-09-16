import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { LlmProvidersConfig, TenantModelSelection } from '../services/llm-providers.js';
import {
  RUNTIME_CONTRACT_V2_RENDERER_VERSION,
  RuntimeContractV2ValidationError,
  validateEnvelope,
  type RuntimeEnvelopeV2,
  type AgentRuntimePayloadV2,
} from '../domain/runtime-contract-v2.js';
import {
  canonicalFingerprint,
  deriveRuntimeKey,
  renderAgentEnvelope,
  renderAgentPayload,
  renderGatewayEnvelope,
  renderGatewayPayload,
  wrapEnvelope,
} from '../services/runtime-contract-v2.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const snapshot: LlmProvidersConfig = {
  providers: [
    {
      name: 'qwen',
      label: 'Qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      apiKey: 'sk-test-key',
      models: [
        { id: 'qwen-max', modelType: 'chat', contextWindow: 32768, maxOutputTokens: 8192, inputModalities: ['text'], reasoning: false, vision: false },
        { id: 'qwen-vl', modelType: 'chat', contextWindow: 32768, maxOutputTokens: 8192, inputModalities: ['text', 'image'], reasoning: false, vision: true },
      ],
    },
    {
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
      models: [
        { id: 'deepseek-chat', modelType: 'chat', contextWindow: 64000, maxOutputTokens: 4096, inputModalities: ['text'], reasoning: true, vision: false },
      ],
    },
  ],
  defaultModel: 'qwen/qwen-max',
  imageModel: 'qwen/qwen-vl',
  compactionModel: null,
  fallbackModels: ['deepseek/deepseek-chat'],
};

const release = { id: 'rel-001', version: 3, fingerprint: 'release-fp-abc' };

const tenantSelection: TenantModelSelection = {
  defaultModel: 'deepseek/deepseek-chat',
  imageModel: null,
  compactionModel: null,
  fallbackModels: ['qwen/qwen-max'],
  directMode: true,
};

// ── Tests ────────────────────────────────────────────────────────────────

describe('RuntimeContractV2 — domain types & schema validation', () => {
  it('validates a well-formed agent envelope', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 'tenant-42');
    const validated = validateEnvelope(envelope) as RuntimeEnvelopeV2<{
      schema: 'agent';
      payload: AgentRuntimePayloadV2;
    }>;
    expect(validated.schema).toBe('agent');
    expect(validated.schemaVersion).toBe(2);
    expect(validated.rendererVersion).toBe(RUNTIME_CONTRACT_V2_RENDERER_VERSION);
    expect(validated.releaseId).toBe('rel-001');
    expect(validated.releaseVersion).toBe(3);
    expect(validated.releaseFingerprint).toBe('release-fp-abc');
    expect(validated.tenantId).toBe('tenant-42');
    expect(validated.payload.providers).toHaveLength(2);
    expect(validated.payload.providers[0].providerId).toBe('deepseek');
    expect(validated.payload.providers[1].providerId).toBe('qwen');
    expect(validated.payload.primary).toEqual({
      providerId: 'qwen',
      modelId: 'qwen/qwen-max',
    });
    expect(validated.payload.image).toEqual({
      providerId: 'qwen',
      modelId: 'qwen/qwen-vl',
    });
    expect(validated.payload.compaction).toBeNull();
    expect(validated.payload.fallbacks).toEqual([
      { providerId: 'deepseek', modelId: 'deepseek/deepseek-chat' },
    ]);
  });

  it('validates a well-formed gateway envelope', () => {
    const envelope = renderGatewayEnvelope(snapshot, release);
    const validated = validateEnvelope(envelope);
    expect(validated.schema).toBe('gateway');
    expect(validated.tenantId).toBeNull();
    const payload = validated.payload as { routes: Array<{ runtimeKey: string; providerId: string }> };
    expect(payload.routes).toHaveLength(2);
    expect(payload.routes[0].runtimeKey).toBe('deepseek');
    expect(payload.routes[1].runtimeKey).toBe('qwen');
  });

  it('rejects unknown fields in the envelope', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 't1');
    (envelope as unknown as Record<string, unknown>).extra = 'bad';
    expect(() => validateEnvelope(envelope)).toThrow(RuntimeContractV2ValidationError);
  });

  it('rejects unknown fields in a provider', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 't1');
    (envelope.payload as unknown as { providers: Array<Record<string, unknown>> }).providers[0].extra = 'bad';
    expect(() => validateEnvelope(envelope)).toThrow(RuntimeContractV2ValidationError);
  });

  it('rejects schemaVersion !== 2', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 't1');
    (envelope as unknown as Record<string, unknown>).schemaVersion = 3;
    expect(() => validateEnvelope(envelope)).toThrow(RuntimeContractV2ValidationError);
  });

  it('rejects invalid modelType', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 't1');
    (envelope.payload as AgentRuntimePayloadV2).providers[0].models[0].modelType =
      'nonexistent' as never;
    expect(() => validateEnvelope(envelope)).toThrow(RuntimeContractV2ValidationError);
  });

  it('rejects non-boolean reasoning', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 't1');
    (envelope.payload as AgentRuntimePayloadV2).providers[0].models[0].reasoning =
      'yes' as never;
    expect(() => validateEnvelope(envelope)).toThrow(RuntimeContractV2ValidationError);
  });
});

describe('RuntimeContractV2 — canonical fingerprint determinism', () => {
  it('produces identical fingerprints for identical payloads', () => {
    const e1 = renderAgentEnvelope(snapshot, null, release, 't1');
    const e2 = renderAgentEnvelope(snapshot, null, release, 't1');
    expect(e1.materializationFingerprint).toBe(e2.materializationFingerprint);
  });

  it('produces different fingerprints when content differs', () => {
    const e1 = renderAgentEnvelope(snapshot, null, release, 't1');
    // Modify payload — change directMode.
    const modifiedSnapshot: LlmProvidersConfig = {
      ...snapshot,
      providers: [
        { ...snapshot.providers[0], apiKey: 'sk-changed' },
        ...snapshot.providers.slice(1),
      ],
    };
    const e2 = renderAgentEnvelope(modifiedSnapshot, null, release, 't1');
    expect(e1.materializationFingerprint).not.toBe(e2.materializationFingerprint);
  });

  it('excludes generatedAt from the envelope fingerprint', () => {
    const e1 = renderAgentEnvelope(snapshot, null, release, 't1');
    // Same content, different generatedAt.
    const e2 = renderAgentEnvelope(snapshot, null, release, 't1');
    e2.generatedAt = '2099-12-31T23:59:59.000Z';
    // The envelope-level canonicalFingerprint should be the same.
    expect(canonicalFingerprint(e1)).toBe(canonicalFingerprint(e2));
  });

  it('produces a 64-char hex fingerprint', () => {
    const e = renderAgentEnvelope(snapshot, null, release, 't1');
    expect(e.materializationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sorts providers by providerId in the payload', () => {
    const payload = renderAgentPayload(snapshot, null);
    const ids = payload.providers.map((p) => p.providerId);
    expect(ids).toEqual([...ids].sort());
  });

  it('sorts models by modelId within each provider', () => {
    const payload = renderAgentPayload(snapshot, null);
    for (const provider of payload.providers) {
      const ids = provider.models.map((m) => m.modelId);
      expect(ids).toEqual([...ids].sort());
    }
  });
});

describe('RuntimeContractV2 — envelope wrap/unwrap', () => {
  it('wrapEnvelope sets all provenance fields', () => {
    const payload = renderAgentPayload(snapshot, null);
    const envelope = wrapEnvelope(
      { schema: 'agent', payload },
      release,
      'tenant-99',
    );
    expect(envelope.schema).toBe('agent');
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.rendererVersion).toBe(RUNTIME_CONTRACT_V2_RENDERER_VERSION);
    expect(envelope.releaseId).toBe('rel-001');
    expect(envelope.releaseVersion).toBe(3);
    expect(envelope.releaseFingerprint).toBe('release-fp-abc');
    expect(envelope.tenantId).toBe('tenant-99');
    expect(envelope.payload).toBe(payload);
  });

  it('wrapEnvelope for gateway sets tenantId null', () => {
    const payload = renderGatewayPayload(snapshot);
    const envelope = wrapEnvelope(
      { schema: 'gateway', payload },
      release,
    );
    expect(envelope.tenantId).toBeNull();
    expect(envelope.schema).toBe('gateway');
  });

  it('validateEnvelope round-trips a wrapped envelope', () => {
    const envelope = renderAgentEnvelope(snapshot, tenantSelection, release, 't1');
    const validated = validateEnvelope(envelope);
    expect(validated).toEqual(envelope);
  });
});

describe('RuntimeContractV2 — tenant selection override', () => {
  it('tenant selection overrides primary and fallback', () => {
    const payload = renderAgentPayload(snapshot, tenantSelection);
    expect(payload.directMode).toBe(true);
    expect(payload.primary).toEqual({
      providerId: 'deepseek',
      modelId: 'deepseek/deepseek-chat',
    });
    expect(payload.fallbacks).toEqual([
      { providerId: 'qwen', modelId: 'qwen/qwen-max' },
    ]);
    // Image is overridden to null.
    expect(payload.image).toBeNull();
  });

  it('null selection uses global defaults', () => {
    const payload = renderAgentPayload(snapshot, null);
    expect(payload.directMode).toBe(false);
    expect(payload.primary).toEqual({
      providerId: 'qwen',
      modelId: 'qwen/qwen-max',
    });
    expect(payload.fallbacks).toEqual([
      { providerId: 'deepseek', modelId: 'deepseek/deepseek-chat' },
    ]);
  });

  it('selection with null fallbackModels falls back to global', () => {
    const sel: TenantModelSelection = {
      defaultModel: null,
      imageModel: null,
      compactionModel: null,
      fallbackModels: null,
      directMode: false,
    };
    const payload = renderAgentPayload(snapshot, sel);
    expect(payload.fallbacks).toEqual([
      { providerId: 'deepseek', modelId: 'deepseek/deepseek-chat' },
    ]);
  });
});

describe('RuntimeContractV2 — deriveRuntimeKey', () => {
  it('normalises provider names to slugs', () => {
    expect(deriveRuntimeKey('Qwen')).toBe('qwen');
    expect(deriveRuntimeKey('my-cool-provider')).toBe('my-cool-provider');
    expect(deriveRuntimeKey('My Cool Provider')).toBe('my-cool-provider');
    expect(deriveRuntimeKey('---')).toBe('provider');
    expect(deriveRuntimeKey('')).toBe('provider');
  });

  it('truncates long names to 32 chars', () => {
    const long = 'a'.repeat(50);
    expect(deriveRuntimeKey(long).length).toBe(32);
  });
});

describe('RuntimeContractV2 — gateway payload', () => {
  it('gateway routes never contain apiKey', () => {
    const payload = renderGatewayPayload(snapshot);
    for (const route of payload.routes) {
      expect(route).not.toHaveProperty('apiKey');
    }
  });

  it('gateway route runtimeKey matches agent provider runtimeKey', () => {
    const agentPayload = renderAgentPayload(snapshot, null);
    const gatewayPayload = renderGatewayPayload(snapshot);
    for (const route of gatewayPayload.routes) {
      const match = agentPayload.providers.find(
        (p) => p.runtimeKey === route.runtimeKey,
      );
      expect(match).toBeDefined();
      expect(match!.providerId).toBe(route.providerId);
    }
  });

  it('gateway models sorted by modelId', () => {
    const payload = renderGatewayPayload(snapshot);
    for (const route of payload.routes) {
      const ids = route.models.map((m) => m.modelId);
      expect(ids).toEqual([...ids].sort());
    }
  });
});

describe('RuntimeContractV2 — invalid schema fail-closed', () => {
  it('rejects null envelope', () => {
    expect(() => validateEnvelope(null)).toThrow(RuntimeContractV2ValidationError);
  });

  it('rejects array envelope', () => {
    expect(() => validateEnvelope([])).toThrow(RuntimeContractV2ValidationError);
  });

  it('rejects missing payload', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 't1');
    delete (envelope as Partial<RuntimeEnvelopeV2>).payload;
    expect(() => validateEnvelope(envelope)).toThrow(RuntimeContractV2ValidationError);
  });

  it('rejects missing materializationFingerprint', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 't1');
    delete (envelope as Partial<RuntimeEnvelopeV2>).materializationFingerprint;
    expect(() => validateEnvelope(envelope)).toThrow(RuntimeContractV2ValidationError);
  });

  it('rejects negative releaseVersion', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 't1');
    (envelope as unknown as Record<string, unknown>).releaseVersion = -1;
    expect(() => validateEnvelope(envelope)).toThrow(RuntimeContractV2ValidationError);
  });

  it('collects multiple issues at once', () => {
    const envelope = renderAgentEnvelope(snapshot, null, release, 't1');
    (envelope as unknown as Record<string, unknown>).schemaVersion = 1;
    (envelope as unknown as Record<string, unknown>).rendererVersion = -1;
    (envelope as unknown as Record<string, unknown>).releaseVersion = 0;
    try {
      validateEnvelope(envelope);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeContractV2ValidationError);
      const issues = (error as RuntimeContractV2ValidationError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});
