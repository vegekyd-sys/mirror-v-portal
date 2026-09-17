export const MODEL_TYPES = [
  'chat', 'embedding', 'rerank', 'image-generation', 'image-edit', 'speech',
  'transcription', 'audio-generation', 'video-generation', 'multimodal-embedding', 'unknown',
] as const;
export const MODEL_MODALITIES = ['text', 'image', 'audio', 'video'] as const;

export type ModelType = (typeof MODEL_TYPES)[number];
export type ModelModality = (typeof MODEL_MODALITIES)[number];
export type ParamsStatus = 'complete' | 'incomplete' | 'fallback' | 'invalid';
export interface ModelRuntimeParamsV1 {
  contextWindow?: number; maxInputTokens?: number; maxOutputTokens?: number; maxReasoningTokens?: number;
  inputModalities?: ModelModality[]; outputModalities?: ModelModality[];
  reasoning?: boolean; vision?: boolean; toolCalling?: boolean; structuredOutput?: boolean;
  compat?: Record<string, boolean | string | number>;
  embedding?: { dimensions?: number; maxBatchSize?: number };
  rerank?: { maxDocuments?: number; maxDocumentTokens?: number };
  image?: { sizes?: string[]; qualities?: string[] };
  audio?: { formats?: string[]; voices?: string[]; maxSeconds?: number };
  video?: { maxSeconds?: number; resolutions?: string[]; fps?: number[] };
}

export interface ValidationIssue { path: Array<string | number>; message: string }
export class CatalogValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`).join('; '));
    this.name = 'CatalogValidationError';
  }
}
interface Schema<T> {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: CatalogValidationError };
}
function schema<T>(validator: (value: unknown) => T): Schema<T> {
  return {
    parse: validator,
    safeParse(value) {
      try { return { success: true, data: validator(value) }; }
      catch (error) { return { success: false, error: error instanceof CatalogValidationError ? error : new CatalogValidationError([{ path: [], message: String(error) }]) }; }
    },
  };
}
function object(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'expected object' }); return {};
  }
  return value as Record<string, unknown>;
}
function strict(record: Record<string, unknown>, allowed: readonly string[], path: Array<string | number>, issues: ValidationIssue[]): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) issues.push({ path: [...path, key], message: 'unknown field' });
}
function positive(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) issues.push({ path, message: 'expected positive safe integer' });
  return typeof value === 'number' ? value : undefined;
}
function strings(value: unknown, path: Array<string | number>, issues: ValidationIssue[], max = 100): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 128)) {
    issues.push({ path, message: `expected at most ${max} non-empty strings` }); return undefined;
  }
  return [...value];
}
function params(value: unknown): ModelRuntimeParamsV1 {
  const issues: ValidationIssue[] = [];
  const raw = object(value, [], issues);
  const allowed = ['contextWindow','maxInputTokens','maxOutputTokens','maxReasoningTokens','inputModalities','outputModalities','reasoning','vision','toolCalling','structuredOutput','compat','embedding','rerank','image','audio','video'];
  strict(raw, allowed, [], issues);
  const result: ModelRuntimeParamsV1 = {};
  for (const key of ['contextWindow','maxInputTokens','maxOutputTokens','maxReasoningTokens'] as const) {
    const parsed = positive(raw[key], [key], issues); if (parsed !== undefined) result[key] = parsed;
  }
  for (const key of ['reasoning','vision','toolCalling','structuredOutput'] as const) {
    if (raw[key] !== undefined) { if (typeof raw[key] !== 'boolean') issues.push({ path: [key], message: 'expected boolean' }); else result[key] = raw[key]; }
  }
  for (const key of ['inputModalities','outputModalities'] as const) {
    if (raw[key] !== undefined) {
      if (!Array.isArray(raw[key]) || raw[key].length > 4 || raw[key].some((item) => !MODEL_MODALITIES.includes(item as ModelModality))) issues.push({ path: [key], message: 'invalid modality list' });
      else result[key] = [...raw[key]] as ModelModality[];
    }
  }
  if (raw.compat !== undefined) {
    const compat = object(raw.compat, ['compat'], issues); const parsed: Record<string, boolean|string|number> = {};
    for (const [key, item] of Object.entries(compat)) {
      if (!['boolean','string','number'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item)) || (typeof item === 'string' && item.length > 256)) issues.push({ path: ['compat', key], message: 'expected finite number, boolean or string <= 256' });
      else parsed[key] = item as boolean|string|number;
    }
    result.compat = parsed;
  }
  const nested = (key: 'embedding'|'rerank'|'image'|'audio'|'video', allowedKeys: string[]): Record<string, unknown> | undefined => {
    if (raw[key] === undefined) return undefined; const item = object(raw[key], [key], issues); strict(item, allowedKeys, [key], issues); return item;
  };
  const embedding = nested('embedding',['dimensions','maxBatchSize']); if (embedding) result.embedding = { dimensions: positive(embedding.dimensions,['embedding','dimensions'],issues), maxBatchSize: positive(embedding.maxBatchSize,['embedding','maxBatchSize'],issues) };
  const rerank = nested('rerank',['maxDocuments','maxDocumentTokens']); if (rerank) result.rerank = { maxDocuments: positive(rerank.maxDocuments,['rerank','maxDocuments'],issues), maxDocumentTokens: positive(rerank.maxDocumentTokens,['rerank','maxDocumentTokens'],issues) };
  const image = nested('image',['sizes','qualities']); if (image) result.image = { sizes: strings(image.sizes,['image','sizes'],issues), qualities: strings(image.qualities,['image','qualities'],issues) };
  const audio = nested('audio',['formats','voices','maxSeconds']); if (audio) result.audio = { formats: strings(audio.formats,['audio','formats'],issues), voices: strings(audio.voices,['audio','voices'],issues), maxSeconds: positive(audio.maxSeconds,['audio','maxSeconds'],issues) };
  const video = nested('video',['maxSeconds','resolutions','fps']); if (video) {
    let fps: number[] | undefined;
    if (video.fps !== undefined) { if (!Array.isArray(video.fps) || video.fps.length > 20) issues.push({ path:['video','fps'],message:'invalid fps list' }); else fps = video.fps.map((item,index) => positive(item,['video','fps',index],issues)).filter((item): item is number => item !== undefined); }
    result.video = { maxSeconds: positive(video.maxSeconds,['video','maxSeconds'],issues), resolutions: strings(video.resolutions,['video','resolutions'],issues), fps };
  }
  if (result.contextWindow !== undefined) for (const key of ['maxInputTokens','maxOutputTokens'] as const) if (result[key] !== undefined && result[key]! > result.contextWindow) issues.push({ path:[key],message:`${key} must not exceed contextWindow` });
  if (result.vision === true && !result.inputModalities?.includes('image')) issues.push({ path:['inputModalities'],message:'vision=true requires image input modality' });
  if (issues.length) throw new CatalogValidationError(issues);
  return result;
}
export const ModelRuntimeParamsV1Schema = schema<ModelRuntimeParamsV1>(params);
export interface ProviderModelRecord { id:string; providerInstanceId:string; modelId:string; displayName?:string; modelType:ModelType; runtimeEnabled:boolean; discoveredParams?:ModelRuntimeParamsV1; overrideParams?:ModelRuntimeParamsV1; effectiveParams:ModelRuntimeParamsV1; paramsStatus:ParamsStatus; snapshotApproved?:boolean; schemaVersion:1; revision?:number; source?:string }
export interface EffectiveParamsResult { effectiveParams:ModelRuntimeParamsV1; status:ParamsStatus; fallbackFields:string[] }
const SAFE_FALLBACK: ModelRuntimeParamsV1 = { inputModalities:['text'], outputModalities:['text'] };
function isPlain(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function merge(discovered:Record<string,unknown>,override:Record<string,unknown>,fallback:Record<string,unknown>,prefix:string,fallbackFields:string[]):Record<string,unknown> {
  const result:Record<string,unknown>={}; for (const key of new Set([...Object.keys(fallback),...Object.keys(discovered),...Object.keys(override)])) {
    const path=prefix?`${prefix}.${key}`:key; const o=override[key], d=discovered[key], f=fallback[key];
    if (o!==undefined) result[key]=isPlain(o)?merge(isPlain(d)?d:{},o,isPlain(f)?f:{},path,fallbackFields):o;
    else if (d!==undefined) result[key]=d; else if (f!==undefined) { result[key]=f; fallbackFields.push(path); }
  } return result;
}
export function mergeModelRuntimeParams(discovered?:ModelRuntimeParamsV1,override?:ModelRuntimeParamsV1):EffectiveParamsResult {
  const d=discovered?params(discovered):{}, o=override?params(override):{}, fallbackFields:string[]=[];
  const effectiveParams=params(merge(d as Record<string,unknown>,o as Record<string,unknown>,SAFE_FALLBACK as Record<string,unknown>,'',fallbackFields));
  return { effectiveParams, status:fallbackFields.length?'fallback':effectiveParams.contextWindow&&effectiveParams.maxOutputTokens?'complete':'incomplete', fallbackFields };
}
export interface ModelMutation { modelId:string; modelType:ModelType; runtimeEnabled:boolean; discoveredParams?:ModelRuntimeParamsV1; overrideParams?:ModelRuntimeParamsV1 }
export const ModelMutationSchema = schema<ModelMutation>((value) => {
  const issues:ValidationIssue[]=[]; const raw=object(value,[],issues); strict(raw,['modelId','modelType','runtimeEnabled','discoveredParams','overrideParams'],[],issues);
  if (typeof raw.modelId!=='string'||raw.modelId.length<1||raw.modelId.length>100) issues.push({path:['modelId'],message:'expected string length 1..100'});
  if (!MODEL_TYPES.includes(raw.modelType as ModelType)) issues.push({path:['modelType'],message:'invalid model type'});
  if (raw.runtimeEnabled!==undefined&&typeof raw.runtimeEnabled!=='boolean') issues.push({path:['runtimeEnabled'],message:'expected boolean'});
  let discoveredParams:ModelRuntimeParamsV1|undefined, overrideParams:ModelRuntimeParamsV1|undefined;
  try { if(raw.discoveredParams!==undefined) discoveredParams=params(raw.discoveredParams); } catch(error) { if(error instanceof CatalogValidationError) issues.push(...error.issues.map((issue)=>({...issue,path:['discoveredParams',...issue.path]}))); }
  try { if(raw.overrideParams!==undefined) overrideParams=params(raw.overrideParams); } catch(error) { if(error instanceof CatalogValidationError) issues.push(...error.issues.map((issue)=>({...issue,path:['overrideParams',...issue.path]}))); }
  if(issues.length) throw new CatalogValidationError(issues);
  return { modelId:raw.modelId as string, modelType:raw.modelType as ModelType, runtimeEnabled:raw.runtimeEnabled===true, ...(discoveredParams?{discoveredParams}:{}), ...(overrideParams?{overrideParams}:{}) };
});

// ── Provider CRUD domain types ──────────────────────────────────────────

export const PROVIDER_TEMPLATE_KEYS = ['custom-openai','anthropic-compatible','azure-openai','google-vertex','ollama'] as const
export type ProviderTemplateKey = (typeof PROVIDER_TEMPLATE_KEYS)[number]
export const PROVIDER_PROTOCOLS = ['openai-completions'] as const
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number]

export interface ProviderInstanceInput {
  legacyProviderName: string
  displayName?: string
  templateKey: string
  protocol: string
  baseUrl: string
  apiKey?: string
  enabled: boolean
  metadata?: Record<string, unknown>
}

export interface ProviderMutation {
  displayName?: string
  templateKey?: string
  protocol?: string
  baseUrl?: string
  apiKey?: string
  enabled?: boolean
  metadata?: Record<string, unknown>
}

function optionalString(value: unknown, path: Array<string | number>, issues: ValidationIssue[], max = 256): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    issues.push({ path, message: `expected string length 1..${max}` })
    return undefined
  }
  return value
}

function optionalBoolean(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    issues.push({ path, message: 'expected boolean' })
    return undefined
  }
  return value
}

function optionalRecord(value: unknown, path: Array<string | number>, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'expected object' })
    return undefined
  }
  return value as Record<string, unknown>
}

export const ProviderInstanceInputSchema = schema<ProviderInstanceInput>((value) => {
  const issues: ValidationIssue[] = []
  const raw = object(value, [], issues)
  strict(raw, ['legacyProviderName','displayName','templateKey','protocol','baseUrl','apiKey','enabled','metadata'], [], issues)
  if (typeof raw.legacyProviderName !== 'string' || raw.legacyProviderName.length < 1 || raw.legacyProviderName.length > 100)
    issues.push({ path: ['legacyProviderName'], message: 'expected string length 1..100' })
  const displayName = optionalString(raw.displayName, ['displayName'], issues, 256)
  if (typeof raw.templateKey !== 'string' || !PROVIDER_TEMPLATE_KEYS.includes(raw.templateKey as ProviderTemplateKey))
    issues.push({ path: ['templateKey'], message: `expected one of: ${PROVIDER_TEMPLATE_KEYS.join(', ')}` })
  if (typeof raw.protocol !== 'string' || !PROVIDER_PROTOCOLS.includes(raw.protocol as ProviderProtocol))
    issues.push({ path: ['protocol'], message: `expected one of: ${PROVIDER_PROTOCOLS.join(', ')}` })
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.replace(/\/+$/, '') : ''
  if (typeof raw.baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(baseUrl))
    issues.push({ path: ['baseUrl'], message: 'expected valid http(s):// URL' })
  const apiKey = optionalString(raw.apiKey, ['apiKey'], issues, 4096)
  if (typeof raw.enabled !== 'boolean')
    issues.push({ path: ['enabled'], message: 'expected boolean' })
  const metadata = optionalRecord(raw.metadata, ['metadata'], issues)
  if (issues.length) throw new CatalogValidationError(issues)
  return {
    legacyProviderName: raw.legacyProviderName as string,
    ...(displayName ? { displayName } : {}),
    templateKey: raw.templateKey as string,
    protocol: raw.protocol as string,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    enabled: raw.enabled as boolean,
    ...(metadata ? { metadata } : {}),
  }
})

export const ProviderMutationSchema = schema<ProviderMutation>((value) => {
  const issues: ValidationIssue[] = []
  const raw = object(value, [], issues)
  strict(raw, ['displayName','templateKey','protocol','baseUrl','apiKey','enabled','metadata'], [], issues)
  const displayName = optionalString(raw.displayName, ['displayName'], issues, 256)
  let templateKey: string | undefined
  if (raw.templateKey !== undefined) {
    if (typeof raw.templateKey !== 'string' || !PROVIDER_TEMPLATE_KEYS.includes(raw.templateKey as ProviderTemplateKey))
      issues.push({ path: ['templateKey'], message: `expected one of: ${PROVIDER_TEMPLATE_KEYS.join(', ')}` })
    else templateKey = raw.templateKey
  }
  let protocol: string | undefined
  if (raw.protocol !== undefined) {
    if (typeof raw.protocol !== 'string' || !PROVIDER_PROTOCOLS.includes(raw.protocol as ProviderProtocol))
      issues.push({ path: ['protocol'], message: `expected one of: ${PROVIDER_PROTOCOLS.join(', ')}` })
    else protocol = raw.protocol
  }
  let baseUrl: string | undefined
  if (raw.baseUrl !== undefined) {
    const trimmed = typeof raw.baseUrl === 'string' ? raw.baseUrl.replace(/\/+$/, '') : ''
    if (typeof raw.baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/.test(trimmed))
      issues.push({ path: ['baseUrl'], message: 'expected valid http(s):// URL' })
    else baseUrl = trimmed
  }
  const apiKey = optionalString(raw.apiKey, ['apiKey'], issues, 4096)
  const enabled = optionalBoolean(raw.enabled, ['enabled'], issues)
  const metadata = optionalRecord(raw.metadata, ['metadata'], issues)
  if (issues.length) throw new CatalogValidationError(issues)
  return {
    ...(displayName ? { displayName } : {}),
    ...(templateKey ? { templateKey } : {}),
    ...(protocol ? { protocol } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(metadata ? { metadata } : {}),
  }
})

// ── Global Model Policy domain types ─────────────────────────────────────

export interface GlobalModelPolicyInput {
  defaultModel: string | null
  imageModel: string | null
  compactionModel: string | null
  fallbackModels: string[]
}

export interface GlobalModelPolicyRecord extends GlobalModelPolicyInput {
  revision: number
  updatedAt: Date
}

export const GlobalModelPolicyInputSchema = schema<GlobalModelPolicyInput>((value) => {
  const issues: ValidationIssue[] = []
  const raw = object(value, [], issues)
  strict(raw, ['defaultModel','imageModel','compactionModel','fallbackModels'], [], issues)
  const nullableString = (v: unknown, path: Array<string | number>): string | null => {
    if (v === null || v === undefined) return null
    if (typeof v !== 'string' || v.length < 1 || v.length > 128) {
      issues.push({ path, message: 'expected string or null' })
      return null
    }
    return v
  }
  const defaultModel = nullableString(raw.defaultModel, ['defaultModel'])
  const imageModel = nullableString(raw.imageModel, ['imageModel'])
  const compactionModel = nullableString(raw.compactionModel, ['compactionModel'])
  let fallbackModels: string[] = []
  if (raw.fallbackModels !== undefined) {
    if (!Array.isArray(raw.fallbackModels) || raw.fallbackModels.length > 20 ||
        raw.fallbackModels.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 128)) {
      issues.push({ path: ['fallbackModels'], message: 'expected array of non-empty strings (max 20)' })
    } else {
      fallbackModels = [...new Set(raw.fallbackModels as string[])]
    }
  }
  if (issues.length) throw new CatalogValidationError(issues)
  return { defaultModel, imageModel, compactionModel, fallbackModels }
})
