/**
 * Honest placeholder for a CONFIGURED but UNIMPLEMENTED live provider (Part 4).
 *
 * The environment can name a live vendor (e.g. `AI_IMAGE_PROVIDER=openai`)
 * and even supply an API key, but no live adapter is shipped in this part and
 * no real API call has ever been made or verified here. Two failure modes are
 * possible and this module chooses the honest one:
 *
 *  - DISHONEST (never done): silently return mock output while `/health`
 *    reports the live vendor — that would label fabricated content as real.
 *  - HONEST (this module): report `ready:false` and fail every call with a
 *    typed, non-retryable `AI_PROVIDER_UNAVAILABLE` error that names the
 *    configured vendor and states that no call was attempted.
 *
 * Selecting a live provider operationally requires, at minimum, credentials
 * AND a successful real API test — neither of which exists in this
 * environment, so these adapters stay BLOCKED and are marked NOT_TESTED.
 */
import { AiProviderError } from '../../core/errors.js';
import type {
  CaptionGenerationRequest,
  CaptionGenerator,
  GeneratedCaption,
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerator,
  ProviderInfo,
} from '../../contracts/index.js';

export class UnavailableImageGenerator implements ImageGenerator {
  readonly info: ProviderInfo;

  constructor(configuredProvider: string) {
    this.info = {
      name: `unavailable_image(${configuredProvider})`,
      kind: 'live',
      model: undefined,
      ready: false,
      detail:
        `Live image provider "${configuredProvider}" is configured but no live adapter is implemented ` +
        `in this environment; every call fails fast. No API call was made or verified. BLOCKED / NOT_TESTED.`,
    };
  }

  async generate(_request: ImageGenerationRequest): Promise<GeneratedImage> {
    throw new AiProviderError(
      `Live image provider is unavailable: no adapter is implemented for "${this.info.name}" in this environment; no API call was attempted.`,
      { service: 'ai_image', operation: 'generate', upstreamCode: 'AI_PROVIDER_UNAVAILABLE' },
      { retryable: false },
    );
  }
}

export class UnavailableCaptionGenerator implements CaptionGenerator {
  readonly info: ProviderInfo;

  constructor(configuredProvider: string) {
    this.info = {
      name: `unavailable_caption(${configuredProvider})`,
      kind: 'live',
      model: undefined,
      ready: false,
      detail:
        `Live caption provider "${configuredProvider}" is configured but no live adapter is implemented ` +
        `in this environment; every call fails fast. No API call was made or verified. BLOCKED / NOT_TESTED.`,
    };
  }

  async generate(_request: CaptionGenerationRequest): Promise<GeneratedCaption> {
    throw new AiProviderError(
      `Live caption provider is unavailable: no adapter is implemented for "${this.info.name}" in this environment; no API call was attempted.`,
      { service: 'ai_text', operation: 'generate', upstreamCode: 'AI_PROVIDER_UNAVAILABLE' },
      { retryable: false },
    );
  }
}
