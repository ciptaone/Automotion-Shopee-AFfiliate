/**
 * Generation router (Part 6 §2/§5/§6/§10).
 *
 * Sits between the content pipeline and the concrete generators:
 *
 *   pipeline ─▶ router ─▶ selected provider adapter (configured)  ── or ──
 *                        └▶ environment default (only when NO selection)
 *
 * Rules enforced here:
 *  - the text provider and the image provider are selected INDEPENDENTLY,
 *  - an unsupported capability fails with `CAPABILITY_UNSUPPORTED` — the router
 *    never rewrites the request to a different provider or to a mock,
 *  - a missing/undecryptable credential fails closed,
 *  - the budget is checked BEFORE the request (§10),
 *  - every request is recorded in the usage ledger with honest cost class,
 *  - the result carries `attribution` naming the provider/model that actually
 *    produced it (`env_default` when nothing was selected).
 */
import type {
  CaptionGenerationRequest,
  CaptionGenerator,
  GeneratedCaption,
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerator,
  ProviderInfo,
  GenerationAttribution,
} from '../contracts/index.js';
import { errorCodeOf } from '../core/errors.js';
import {
  ResilientCaptionGenerator,
  ResilientImageGenerator,
} from '../integrations/ai/provider-runner.js';
import type { UsageService } from '../usage/usage-service.js';
import { createCaptionClient, createImageClient } from './adapters.js';
import type { ProviderService } from './provider-service.js';

export interface GenerationRouterDeps {
  readonly providers: ProviderService;
  readonly usage: UsageService;
  /** Env-configured default used ONLY when no provider is selected for a task. */
  readonly defaultCaption: CaptionGenerator;
  readonly defaultImage: ImageGenerator;
}

export interface GenerationRouter {
  /** CaptionGenerator view (its `info` reflects the current text selection). */
  forCaption(): CaptionGenerator;
  /** ImageGenerator view (its `info` reflects the current image selection). */
  forImage(): ImageGenerator;
}

export function createGenerationRouter(deps: GenerationRouterDeps): GenerationRouter {
  return {
    forCaption: () => new RouterCaptionGenerator(deps),
    forImage: () => new RouterImageGenerator(deps),
  };
}

/* -------------------------------------------------------------------------- */

abstract class BaseRouter {
  protected readonly providers: ProviderService;
  protected readonly usage: UsageService;

  constructor(protected readonly deps: GenerationRouterDeps) {
    this.providers = deps.providers;
    this.usage = deps.usage;
  }

  protected async record(input: {
    providerId: string | null;
    providerName: string;
    adapterType: string | null;
    model: string;
    operation: 'text_generation' | 'image_generation';
    status: 'success' | 'error';
    latencyMs: number;
    requestId: string | null;
    images: number | null;
    costUsd: number | null;
    costKind: 'actual' | 'estimated' | 'unknown';
    errorCode?: string;
  }): Promise<void> {
    await this.usage.record({ ...input });
  }

  protected attribution(input: {
    providerId: string | null;
    providerName: string;
    source: 'configured_provider' | 'env_default';
    adapterType: string | null;
    model: string;
    requestId: string | null;
    costUsd: number | null;
    costKind: 'actual' | 'estimated' | 'unknown';
    images?: number | null;
    warnings?: readonly string[];
  }): GenerationAttribution {
    return {
      providerId: input.providerId,
      providerName: input.providerName,
      source: input.source,
      adapterType: input.adapterType,
      model: input.model,
      requestId: input.requestId,
      usage: {
        inputTokens: null,
        outputTokens: null,
        images: input.images ?? null,
        costUsd: input.costUsd,
        costKind: input.costKind,
      },
      warnings: input.warnings ?? [],
    };
  }
}

class RouterCaptionGenerator extends BaseRouter implements CaptionGenerator {
  get info(): ProviderInfo {
    const provider = this.providers.selectedForSync('text');
    if (!provider) {
      const base = this.deps.defaultCaption.info;
      return {
        ...base,
        detail:
          `${base.detail} — no text provider is selected in the provider workspace, so the ` +
          'environment-configured default is used (this is a configuration state, not a fallback).',
      };
    }
    return {
      name: provider.displayName,
      kind: 'live',
      model: provider.model,
      ready: provider.enabled,
      detail: `Selected text provider "${provider.displayName}" (${provider.adapterType}, model ${provider.model}) at ${provider.baseUrl}.`,
    };
  }

  async generate(request: CaptionGenerationRequest): Promise<GeneratedCaption> {
    await this.usage.assertWithinBudget();
    const provider = await this.providers.selectedFor('text');

    if (!provider) {
      const startedAt = Date.now();
      const result = await this.deps.defaultCaption.generate(request);
      await this.record({
        providerId: null,
        providerName: this.deps.defaultCaption.info.name,
        adapterType: 'env_default',
        model: result.model,
        operation: 'text_generation',
        status: 'success',
        latencyMs: Date.now() - startedAt,
        requestId: null,
        images: null,
        costUsd: null,
        costKind: 'unknown',
      });
      return {
        ...result,
        attribution: this.attribution({
          providerId: null,
          providerName: this.deps.defaultCaption.info.name,
          source: 'env_default',
          adapterType: 'env_default',
          model: result.model,
          requestId: null,
          costUsd: null,
          costKind: 'unknown',
          warnings: [
            'No text provider selected: the environment-configured default (AI_TEXT_PROVIDER) produced this caption.',
          ],
        }),
      };
    }

    this.providers.assertCapability(provider, 'text');
    const context = await this.providers.contextFor(provider);
    const inner = createCaptionClient(context);
    const client = new ResilientCaptionGenerator(inner, {
      policy: {
        maxAttempts: Math.max(1, provider.maxRetries + 1),
        defaultTimeoutMs: provider.timeoutMs,
      },
    });

    const startedAt = Date.now();
    try {
      const result = await client.generate({ ...request, timeoutMs: request.timeoutMs ?? provider.timeoutMs });
      const costKind: 'actual' | 'estimated' | 'unknown' =
        typeof result.estimatedCostUsd === 'number' ? 'estimated' : 'unknown';
      await this.record({
        providerId: provider.id,
        providerName: provider.displayName,
        adapterType: provider.adapterType,
        model: provider.model,
        operation: 'text_generation',
        status: 'success',
        latencyMs: Date.now() - startedAt,
        requestId: null,
        images: null,
        costUsd: result.estimatedCostUsd,
        costKind,
      });
      return {
        ...result,
        attribution: this.attribution({
          providerId: provider.id,
          providerName: provider.displayName,
          source: 'configured_provider',
          adapterType: provider.adapterType,
          model: provider.model,
          requestId: null,
          costUsd: result.estimatedCostUsd,
          costKind,
        }),
      };
    } catch (error) {
      await this.record({
        providerId: provider.id,
        providerName: provider.displayName,
        adapterType: provider.adapterType,
        model: provider.model,
        operation: 'text_generation',
        status: 'error',
        latencyMs: Date.now() - startedAt,
        requestId: null,
        images: null,
        costUsd: null,
        costKind: 'unknown',
        errorCode: errorCodeOf(error),
      });
      throw error;
    }
  }
}

class RouterImageGenerator extends BaseRouter implements ImageGenerator {
  get info(): ProviderInfo {
    const provider = this.providers.selectedForSync('image');
    if (!provider) {
      const base = this.deps.defaultImage.info;
      return {
        ...base,
        detail:
          `${base.detail} — no image provider is selected in the provider workspace, so the ` +
          'environment-configured default is used (this is a configuration state, not a fallback).',
      };
    }
    return {
      name: provider.displayName,
      kind: 'live',
      model: provider.model,
      ready: provider.enabled,
      detail: `Selected image provider "${provider.displayName}" (${provider.adapterType}, model ${provider.model}) at ${provider.baseUrl}.`,
    };
  }

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    await this.usage.assertWithinBudget();
    const provider = await this.providers.selectedFor('image');

    if (!provider) {
      const startedAt = Date.now();
      const result = await this.deps.defaultImage.generate(request);
      await this.record({
        providerId: null,
        providerName: this.deps.defaultImage.info.name,
        adapterType: 'env_default',
        model: result.model,
        operation: 'image_generation',
        status: 'success',
        latencyMs: Date.now() - startedAt,
        requestId: null,
        images: 1,
        costUsd: null,
        costKind: 'unknown',
      });
      return {
        ...result,
        attribution: this.attribution({
          providerId: null,
          providerName: this.deps.defaultImage.info.name,
          source: 'env_default',
          adapterType: 'env_default',
          model: result.model,
          requestId: null,
          costUsd: null,
          costKind: 'unknown',
          warnings: [
            'No image provider selected: the environment-configured default (AI_IMAGE_PROVIDER) produced this image.',
          ],
        }),
      };
    }

    this.providers.assertCapability(provider, 'image');
    const context = await this.providers.contextFor(provider);
    const inner = createImageClient(context);
    const client = new ResilientImageGenerator(inner, {
      policy: {
        maxAttempts: Math.max(1, provider.maxRetries + 1),
        defaultTimeoutMs: provider.timeoutMs,
      },
    });

    const startedAt = Date.now();
    try {
      const result = await client.generate({ ...request, timeoutMs: request.timeoutMs ?? provider.timeoutMs });
      const costKind: 'actual' | 'estimated' | 'unknown' =
        typeof result.estimatedCostUsd === 'number' ? 'estimated' : 'unknown';
      await this.record({
        providerId: provider.id,
        providerName: provider.displayName,
        adapterType: provider.adapterType,
        model: provider.model,
        operation: 'image_generation',
        status: 'success',
        latencyMs: Date.now() - startedAt,
        requestId: null,
        images: 1,
        costUsd: result.estimatedCostUsd,
        costKind,
      });
      return {
        ...result,
        attribution: this.attribution({
          providerId: provider.id,
          providerName: provider.displayName,
          source: 'configured_provider',
          adapterType: provider.adapterType,
          model: provider.model,
          requestId: null,
          costUsd: result.estimatedCostUsd,
          costKind,
        }),
      };
    } catch (error) {
      await this.record({
        providerId: provider.id,
        providerName: provider.displayName,
        adapterType: provider.adapterType,
        model: provider.model,
        operation: 'image_generation',
        status: 'error',
        latencyMs: Date.now() - startedAt,
        requestId: null,
        images: null,
        costUsd: null,
        costKind: 'unknown',
        errorCode: errorCodeOf(error),
      });
      throw error;
    }
  }
}
