import type {
  DiscoveryCandidate,
  DiscoveryInput,
  ModelParamSourceAdapter,
} from './types.js';
import { ModelParamSourceUnavailableError } from './types.js';

/**
 * Conservative OpenAI-compatible source.
 *
 * The standard /models shape proves model visibility only. It does not expose
 * token limits or modalities, so this adapter deliberately emits no guessed
 * runtime parameters. Network discovery will be added only with an approved
 * same-origin/SSRF policy and a verified provider response contract.
 */
export class OpenAiCompatibleModelParamSource implements ModelParamSourceAdapter {
  public readonly name = 'provider-api' as const;

  public async preview(_input: DiscoveryInput): Promise<{
    candidates: DiscoveryCandidate[];
    source: {
      kind: 'provider-api';
      observedAt: string;
      rawSha256: string;
    };
  }> {
    throw new ModelParamSourceUnavailableError(
      'Provider API parameter discovery is unsupported until an approved same-origin adapter is configured',
    );
  }
}
