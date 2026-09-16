import type pg from 'pg';
import type {
  GlobalModelPolicyInput,
  GlobalModelPolicyRecord,
  ProviderModelRecord,
} from '../domain/model-catalog.js';
import { getGlobalLlmProviders, type LlmProvidersConfig } from './llm-providers.js';
import { CatalogRepository, type ProviderInstanceRecord } from './model-catalog.js';

export type GlobalPolicyReferenceKind =
  | 'defaultModel'
  | 'imageModel'
  | 'compactionModel'
  | 'fallbackModels';

export interface GlobalPolicyReferenceIssue {
  kind: GlobalPolicyReferenceKind;
  ref: string;
}

export interface GlobalPolicyAmbiguousReference extends GlobalPolicyReferenceIssue {
  candidateIds: string[];
}

export interface GlobalPolicyDisabledReference extends GlobalPolicyReferenceIssue {
  candidateIds: string[];
}

export interface GlobalPolicyBackfillPreview {
  sourceRefs: GlobalModelPolicyInput;
  resolvedIds: GlobalModelPolicyInput;
  missingRefs: GlobalPolicyReferenceIssue[];
  ambiguousRefs: GlobalPolicyAmbiguousReference[];
  disabledRefs: GlobalPolicyDisabledReference[];
  currentPolicy: GlobalModelPolicyRecord | null;
  ready: boolean;
  equivalent: boolean;
  overwriteBlocked: boolean;
}

export interface GlobalPolicyBackfillResult extends GlobalPolicyBackfillPreview {
  action: 'dry-run' | 'no-op' | 'applied';
  policy: GlobalModelPolicyRecord | null;
}

interface GlobalPolicyBackfillRepository {
  listCatalogReferenceCandidates(): Promise<Array<{
    provider: ProviderInstanceRecord;
    models: ProviderModelRecord[];
  }>>;
  getGlobalModelPolicy(): Promise<GlobalModelPolicyRecord | null>;
  updateGlobalModelPolicy(
    input: GlobalModelPolicyInput,
    expectedRevision: number,
    updatedBy: string | null,
  ): Promise<GlobalModelPolicyRecord>;
}

type LegacyLoader = (pool: pg.Pool) => Promise<LlmProvidersConfig | null>;

/** Domain error with a stable API-safe code. */
export class GlobalPolicyBackfillError extends Error {
  public constructor(
    public readonly code: 'BACKFILL_NOT_READY' | 'POLICY_ALREADY_CONFIGURED' | 'POLICY_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'GlobalPolicyBackfillError';
  }
}

function emptyPolicy(): GlobalModelPolicyInput {
  return { defaultModel: null, imageModel: null, compactionModel: null, fallbackModels: [] };
}

function policyValues(policy: GlobalModelPolicyInput): Array<string | null> {
  return [policy.defaultModel, policy.imageModel, policy.compactionModel, ...policy.fallbackModels];
}

function isEmptyPolicy(policy: GlobalModelPolicyInput): boolean {
  return policyValues(policy).every((value) => value === null);
}

function policiesEqual(left: GlobalModelPolicyInput, right: GlobalModelPolicyInput): boolean {
  return left.defaultModel === right.defaultModel &&
    left.imageModel === right.imageModel &&
    left.compactionModel === right.compactionModel &&
    left.fallbackModels.length === right.fallbackModels.length &&
    left.fallbackModels.every((value, index) => value === right.fallbackModels[index]);
}

function sourcePolicy(legacy: LlmProvidersConfig | null): GlobalModelPolicyInput {
  if (!legacy) return emptyPolicy();
  return {
    defaultModel: legacy.defaultModel,
    imageModel: legacy.imageModel,
    compactionModel: legacy.compactionModel,
    fallbackModels: [...legacy.fallbackModels],
  };
}

/** Safely previews and applies Legacy global model references to stable Catalog IDs. */
export class GlobalPolicyBackfillService {
  private readonly repository: GlobalPolicyBackfillRepository;
  private readonly loadLegacy: LegacyLoader;

  public constructor(
    private readonly pool: pg.Pool,
    repository?: GlobalPolicyBackfillRepository,
    loadLegacy: LegacyLoader = getGlobalLlmProviders,
  ) {
    this.repository = repository ?? new CatalogRepository(pool);
    this.loadLegacy = loadLegacy;
  }

  /** Resolve every configured Legacy reference without performing writes. */
  public async preview(force = false): Promise<GlobalPolicyBackfillPreview> {
    const [legacy, catalog, currentPolicy] = await Promise.all([
      this.loadLegacy(this.pool),
      this.repository.listCatalogReferenceCandidates(),
      this.repository.getGlobalModelPolicy(),
    ]);
    const sourceRefs = sourcePolicy(legacy);
    const resolvedIds = emptyPolicy();
    const missingRefs: GlobalPolicyReferenceIssue[] = [];
    const ambiguousRefs: GlobalPolicyAmbiguousReference[] = [];
    const disabledRefs: GlobalPolicyDisabledReference[] = [];

    const resolve = (kind: GlobalPolicyReferenceKind, ref: string | null): string | null => {
      if (ref === null) return null;
      const slashIndex = ref.indexOf('/');
      const providerName = slashIndex < 0 ? '' : ref.slice(0, slashIndex);
      const modelId = slashIndex < 0 ? '' : ref.slice(slashIndex + 1);
      const matches = catalog.flatMap(({ provider, models }) =>
        provider.legacyProviderName === providerName
          ? models.filter((model) => model.modelId === modelId)
          : [],
      );
      if (matches.length === 0) {
        missingRefs.push({ kind, ref });
        return null;
      }
      const candidateIds = matches.map((model) => model.id);
      if (matches.length > 1) {
        ambiguousRefs.push({ kind, ref, candidateIds });
        return null;
      }
      if (!matches[0].runtimeEnabled) {
        disabledRefs.push({ kind, ref, candidateIds });
        return null;
      }
      return matches[0].id;
    };

    resolvedIds.defaultModel = resolve('defaultModel', sourceRefs.defaultModel);
    resolvedIds.imageModel = resolve('imageModel', sourceRefs.imageModel);
    resolvedIds.compactionModel = resolve('compactionModel', sourceRefs.compactionModel);
    resolvedIds.fallbackModels = sourceRefs.fallbackModels
      .map((ref) => resolve('fallbackModels', ref))
      .filter((id): id is string => id !== null);

    const equivalent = currentPolicy !== null && policiesEqual(currentPolicy, resolvedIds);
    const overwriteBlocked = currentPolicy !== null && !isEmptyPolicy(currentPolicy) && !equivalent && !force;
    return {
      sourceRefs,
      resolvedIds,
      missingRefs,
      ambiguousRefs,
      disabledRefs,
      currentPolicy,
      ready: missingRefs.length === 0 && ambiguousRefs.length === 0 &&
        disabledRefs.length === 0 && !overwriteBlocked,
      equivalent,
      overwriteBlocked,
    };
  }

  /** Apply the resolved policy with CAS, or return a deterministic no-op. */
  public async apply(options: { dryRun?: boolean; force?: boolean; actor?: string | null } = {}): Promise<GlobalPolicyBackfillResult> {
    const dryRun = options.dryRun !== false;
    const preview = await this.preview(options.force === true);
    if (dryRun) return { ...preview, action: 'dry-run', policy: preview.currentPolicy };
    if (preview.equivalent) return { ...preview, action: 'no-op', policy: preview.currentPolicy };
    if (preview.overwriteBlocked) {
      throw new GlobalPolicyBackfillError(
        'POLICY_ALREADY_CONFIGURED',
        'Global model policy is already configured; use force=true to overwrite',
      );
    }
    if (!preview.ready) {
      throw new GlobalPolicyBackfillError(
        'BACKFILL_NOT_READY',
        'Legacy model references must each resolve uniquely to a runtime-enabled Catalog model',
      );
    }
    if (!preview.currentPolicy) {
      throw new GlobalPolicyBackfillError('POLICY_NOT_FOUND', 'Global model policy row not found');
    }
    const policy = await this.repository.updateGlobalModelPolicy(
      preview.resolvedIds,
      preview.currentPolicy.revision,
      options.actor ?? null,
    );
    return { ...preview, action: 'applied', policy };
  }
}
