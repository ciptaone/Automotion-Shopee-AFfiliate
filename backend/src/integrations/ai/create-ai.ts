/**
 * Honest AI provider factory (Part 4).
 *
 * Resolves the configured `AI_IMAGE_PROVIDER` / `AI_TEXT_PROVIDER` into a
 * concrete contract implementation:
 *
 *  - 'mock'      -> deterministic offline mock (wrapped in the resilience layer),
 *  - 'disabled'  -> deterministic mock labelled `model:'disabled'` (unchanged
 *                   Part 1/2 behaviour; used to keep the pipeline inert),
 *  - 'openai' /
 *    'google'    -> an UNAVAILABLE adapter that fails fast and reports
 *                   `ready:false`. No live adapter is shipped in this part, so
 *                   naming a live vendor must NEVER silently degrade to mock
 *                   output while the health endpoint claims a live provider.
 *
 * Every returned generator is wrapped in the resilience layer (timeout, bounded
 * retries, rate-limit handling, usage accounting, redacted logging).
 */
import type { CaptionGenerator, ImageGenerator } from '../../contracts/index.js';
import type { Env } from '../../core/env.js';
import { MockCaptionGenerator, MockImageGenerator } from './mock-ai.js';
import {
  ResilientCaptionGenerator,
  ResilientImageGenerator,
  type ProviderLogger,
  type ResilientRunnerOptions,
} from './provider-runner.js';
import { UnavailableCaptionGenerator, UnavailableImageGenerator } from './unavailable-provider.js';

export interface AiFactoryOptions {
  readonly logger?: ProviderLogger;
  readonly runner?: ResilientRunnerOptions;
}

export function createImageGenerator(env: Env, options: AiFactoryOptions = {}): ImageGenerator {
  const base = resolveBaseImageGenerator(env);
  return new ResilientImageGenerator(base, {
    logger: options.logger,
    ...options.runner,
  });
}

export function createCaptionGenerator(env: Env, options: AiFactoryOptions = {}): CaptionGenerator {
  const base = resolveBaseCaptionGenerator(env);
  return new ResilientCaptionGenerator(base, {
    logger: options.logger,
    ...options.runner,
  });
}

function resolveBaseImageGenerator(env: Env): ImageGenerator {
  switch (env.AI_IMAGE_PROVIDER) {
    case 'openai':
    case 'google':
      return new UnavailableImageGenerator(env.AI_IMAGE_PROVIDER);
    case 'disabled':
      return new MockImageGenerator({ model: 'disabled' });
    case 'mock':
    default:
      return new MockImageGenerator({ model: env.AI_IMAGE_MODEL });
  }
}

function resolveBaseCaptionGenerator(env: Env): CaptionGenerator {
  switch (env.AI_TEXT_PROVIDER) {
    case 'openai':
    case 'google':
      return new UnavailableCaptionGenerator(env.AI_TEXT_PROVIDER);
    case 'disabled':
      return new MockCaptionGenerator({ model: 'disabled' });
    case 'mock':
    default:
      return new MockCaptionGenerator({ model: env.AI_TEXT_MODEL });
  }
}
