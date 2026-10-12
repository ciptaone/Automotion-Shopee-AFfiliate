/**
 * PART 4 — resilient AI provider adapter layer.
 *
 * Covers: timeout enforcement, cancellation signal, bounded retries with
 * exponential backoff, explicit rate-limit handling (honoring retryAfterMs,
 * clamped), permanent-failure fast path, usage/cost accounting, redacted
 * single-line error logging, and the honest mock-vs-live provider labelling
 * (including the unavailable-live adapter that fails fast and never claims a
 * call happened).
 *
 * Credential-free: all providers are deterministic stubs/mocks. NO network, NO
 * paid API call. Time/sleep are injected so every scenario is deterministic.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ResilientCaptionGenerator,
  ResilientImageGenerator,
  silentProviderLogger,
  type ProviderLogger,
  type ProviderUsage,
} from '../../src/integrations/ai/provider-runner.js';
import {
  UnavailableCaptionGenerator,
  UnavailableImageGenerator,
} from '../../src/integrations/ai/unavailable-provider.js';
import { MockCaptionGenerator, MockImageGenerator } from '../../src/integrations/ai/mock-ai.js';
import { AiProviderError, RateLimitError } from '../../src/core/errors.js';
import type {
  CaptionGenerationRequest,
  GeneratedImage,
  ImageGenerationRequest,
} from '../../src/contracts/index.js';

/** The affiliate URL used across these scenarios (verbatim-preservation rule). */
const AFFILIATE_URL = 'https://s.shopee.co.id/aff-1';

/* -------------------------------------------------------------------------- */
/*  Test doubles                                                              */
/* -------------------------------------------------------------------------- */

/** Records every attempted call; behavior varies per attempt (1-based). */
function scriptedImage(
  fn: (attempt: number, signal: AbortSignal) => GeneratedImage | Promise<GeneratedImage>,
): { generator: ImageGeneratorStub; calls: () => number } {
  let calls = 0;
  const generator: ImageGeneratorStub = {
    info: {
      name: 'scripted_image',
      kind: 'mock',
      model: 'scripted-v1',
      ready: true,
      detail: 'Deterministic scripted image provider for tests.',
    },
    async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
      calls += 1;
      return fn(calls, request.signal ?? new AbortController().signal);
    },
  };
  return { generator, calls: () => calls };
}

interface ImageGeneratorStub {
  readonly info: {
    readonly name: string;
    readonly kind: 'mock' | 'live';
    readonly model?: string;
    readonly ready: boolean;
    readonly detail: string;
  };
  generate(request: ImageGenerationRequest): Promise<GeneratedImage>;
}

const okImage: GeneratedImage = {
  bytes: new Uint8Array([137, 80, 78, 71]),
  mimeType: 'image/png',
  width: 1080,
  height: 1920,
  seed: 7,
  model: 'scripted-v1',
  estimatedCostUsd: 0.02,
};

const imageRequest: ImageGenerationRequest = {
  prompt: 'product image',
  seed: 7,
  width: 1080,
  height: 1920,
  referenceImageUrls: ['https://cf.shopee.co.id/img/1.jpg'],
  timeoutMs: 5_000,
};

function capturingLogger(): {
  logger: ProviderLogger;
  warnings: Array<Record<string, unknown>>;
} {
  const warnings: Array<Record<string, unknown>> = [];
  return {
    warnings,
    logger: {
      info: () => undefined,
      warn: (fields) => warnings.push(fields),
      error: () => undefined,
    },
  };
}

/** sleep() that never actually waits — tests assert the requested delays. */
function instantRuntime(): {
  runtime: { sleep: (ms: number) => Promise<void>; now: () => number };
  delays: number[];
} {
  const delays: number[] = [];
  let t = 1_000;
  return {
    delays,
    runtime: {
      sleep: async (ms: number) => {
        delays.push(ms);
        t += ms;
      },
      now: () => t,
    },
  };
}

const captionRequest: CaptionGenerationRequest = {
  product: {
    id: 'p1',
    name: 'Tumbler Stainless 500ml',
    marketplace: 'shopee',
    productUrl: 'https://s.shopee.co.id/p1',
    affiliateUrl: 'https://s.shopee.co.id/aff-1',
    price: 150000,
    currency: 'Rp',
    commissionRate: null,
    imageUrl: 'https://cf.shopee.co.id/img/1.jpg',
    category: 'Health & Beauty',
    rating: null,
    soldCount: null,
    raw: {},
  },
  affiliateUrl: 'https://s.shopee.co.id/aff-1',
  language: 'id',
  tone: 'soft_sell',
};

/* -------------------------------------------------------------------------- */
/*  Timeouts + cancellation                                                   */
/* -------------------------------------------------------------------------- */

describe('provider runner — timeouts', () => {
  it('fails a hung provider call after the timeout with a typed AI_TIMEOUT error', async () => {
    const never: ImageGeneratorStub = {
      info: {
        name: 'hung_image',
        kind: 'mock',
        ready: true,
        detail: 'Never resolves.',
      },
      generate: () => new Promise<GeneratedImage>(() => undefined),
    };
    const runner = new ResilientImageGenerator(never, {
      policy: { maxAttempts: 1, defaultTimeoutMs: 15, baseDelayMs: 1, maxDelayMs: 2 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });

    await expect(runner.generate({ ...imageRequest, timeoutMs: 15 })).rejects.toThrow(
      /timed out|failed after/i,
    );
    const usage = runner.getUsage();
    expect(usage.timeouts).toBeGreaterThanOrEqual(1);
    expect(usage.failures).toBe(1);
  });

  it('aborts the cooperative cancellation signal when the timeout fires', async () => {
    let observed: AbortSignal | null = null;
    const hung: ImageGeneratorStub = {
      info: {
        name: 'hung_image',
        kind: 'mock',
        ready: true,
        detail: 'Never resolves.',
      },
      generate: (request) => {
        observed = request.signal ?? null;
        return new Promise<GeneratedImage>(() => undefined);
      },
    };
    const runner = new ResilientImageGenerator(hung, {
      policy: { maxAttempts: 1, defaultTimeoutMs: 15, baseDelayMs: 1, maxDelayMs: 2 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });

    await expect(runner.generate({ ...imageRequest, timeoutMs: 15 })).rejects.toThrow();
    expect(observed).not.toBeNull();
    expect((observed as unknown as AbortSignal).aborted).toBe(true);
  });

  it('uses the request timeoutMs over the default policy timeout', async () => {
    const { generator, calls } = scriptedImage(async () => okImage);
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 1, defaultTimeoutMs: 60_000 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });
    // A generous request timeout must not trip.
    await runner.generate({ ...imageRequest, timeoutMs: 1_000 });
    expect(calls()).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Bounded retries                                                           */
/* -------------------------------------------------------------------------- */

describe('provider runner — bounded retries', () => {
  it('retries a transient failure and succeeds within the bound', async () => {
    const { generator, calls } = scriptedImage(async (attempt) => {
      if (attempt < 3) {
        throw new AiProviderError(
          'upstream hiccup',
          { service: 'scripted_image', operation: 'generate', upstreamCode: 'ECONNRESET' },
          { retryable: true },
        );
      }
      return okImage;
    });
    const { runtime, delays } = instantRuntime();
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1_000 },
      runtime,
      logger: silentProviderLogger,
    });

    const image = await runner.generate(imageRequest);
    expect(image).toBe(okImage);
    expect(calls()).toBe(3);
    expect(delays).toEqual([10, 20]); // exponential backoff, bounded
    const usage = runner.getUsage();
    expect(usage.retries).toBe(2);
    expect(usage.calls).toBe(3);
  });

  it('STOPS at maxAttempts and rethrows when every attempt fails', async () => {
    const { generator, calls } = scriptedImage(async () => {
      throw new AiProviderError(
        'always down',
        { service: 'scripted_image', operation: 'generate', upstreamCode: 'UPSTREAM_5XX' },
        { retryable: true },
      );
    });
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });

    await expect(runner.generate(imageRequest)).rejects.toThrow(/failed after 3 attempt/i);
    expect(calls()).toBe(3); // exactly the bound — never unbounded
  });

  it('does NOT retry a permanent (non-retryable) failure', async () => {
    const { generator, calls } = scriptedImage(async () => {
      throw new AiProviderError(
        'invalid request',
        { service: 'scripted_image', operation: 'generate', upstreamCode: 'AI_INVALID_REQUEST' },
        { retryable: false },
      );
    });
    const { runtime, delays } = instantRuntime();
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10 },
      runtime,
      logger: silentProviderLogger,
    });

    await expect(runner.generate(imageRequest)).rejects.toThrow(/failed after/i);
    expect(calls()).toBe(1);
    expect(delays).toEqual([]); // no backoff for a permanent failure
  });

  it('treats unknown thrown errors as transient but still bounded', async () => {
    const { generator, calls } = scriptedImage(async () => {
      throw new TypeError('socket exploded');
    });
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });

    await expect(runner.generate(imageRequest)).rejects.toThrow(AiProviderError);
    expect(calls()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  Rate limiting                                                             */
/* -------------------------------------------------------------------------- */

describe('provider runner — rate limits', () => {
  it('honors retryAfterMs from a rate-limit error', async () => {
    const { generator, calls } = scriptedImage(async (attempt) => {
      if (attempt === 1) {
        throw new RateLimitError(
          { service: 'scripted_image', operation: 'generate' },
          1_500,
        );
      }
      return okImage;
    });
    const { runtime, delays } = instantRuntime();
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10_000 },
      runtime,
      logger: silentProviderLogger,
    });

    const image = await runner.generate(imageRequest);
    expect(image).toBe(okImage);
    expect(calls()).toBe(2);
    expect(delays).toEqual([1_500]); // provider's own wait, not the default backoff
    expect(runner.getUsage().rateLimits).toBe(1);
  });

  it('clamps a huge retryAfterMs to maxDelayMs (never wedges the worker)', async () => {
    const { generator } = scriptedImage(async (attempt) => {
      if (attempt === 1) {
        throw new RateLimitError(
          { service: 'scripted_image', operation: 'generate' },
          99_999_999,
        );
      }
      return okImage;
    });
    const { runtime, delays } = instantRuntime();
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 8_000 },
      runtime,
      logger: silentProviderLogger,
    });

    await runner.generate(imageRequest);
    expect(delays).toEqual([8_000]);
  });

  it('falls back to exponential backoff when no retryAfterMs is given', async () => {
    const { generator } = scriptedImage(async (attempt) => {
      if (attempt === 1) {
        throw new RateLimitError({ service: 'scripted_image', operation: 'generate' });
      }
      return okImage;
    });
    const { runtime, delays } = instantRuntime();
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 2, baseDelayMs: 25, maxDelayMs: 10_000 },
      runtime,
      logger: silentProviderLogger,
    });

    await runner.generate(imageRequest);
    expect(delays).toEqual([25]);
  });

  it('gives up after the bound when rate-limited every time', async () => {
    const { generator, calls } = scriptedImage(async () => {
      throw new RateLimitError({ service: 'scripted_image', operation: 'generate' }, 1);
    });
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });

    await expect(runner.generate(imageRequest)).rejects.toThrow(AiProviderError);
    expect(calls()).toBe(3);
    expect(runner.getUsage().rateLimits).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  Usage + cost metadata                                                     */
/* -------------------------------------------------------------------------- */

describe('provider runner — usage and cost accounting', () => {
  it('accumulates calls, retries and provider-reported cost', async () => {
    const { generator } = scriptedImage(async (attempt) => {
      if (attempt === 1) {
        throw new AiProviderError(
          'flaky',
          { service: 'scripted_image', operation: 'generate', upstreamCode: 'ECONNRESET' },
          { retryable: true },
        );
      }
      return { ...okImage, estimatedCostUsd: 0.02 };
    });
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });

    await runner.generate(imageRequest);
    const usage: ProviderUsage = runner.getUsage();
    expect(usage.calls).toBe(2);
    expect(usage.failures).toBe(1);
    expect(usage.retries).toBe(1);
    expect(usage.estimatedCostUsdTotal).toBeCloseTo(0.02, 10);
    expect(usage.lastLatencyMs).not.toBeNull();
  });

  it('marks the cost total unknown when ANY call omits cost (no fabricated totals)', async () => {
    const { generator } = scriptedImage(async (attempt) =>
      attempt === 1 ? okImage : { ...okImage, estimatedCostUsd: null },
    );
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });

    await runner.generate(imageRequest);
    await runner.generate(imageRequest);
    expect(runner.getUsage().estimatedCostUsdTotal).toBeNull();
  });

  it('starts with a zeroed usage snapshot', async () => {
    const { generator } = scriptedImage(async () => okImage);
    const runner = new ResilientImageGenerator(generator, { logger: silentProviderLogger });
    expect(runner.getUsage()).toMatchObject({
      calls: 0,
      failures: 0,
      retries: 0,
      timeouts: 0,
      rateLimits: 0,
      estimatedCostUsdTotal: 0,
      lastLatencyMs: null,
    });
  });

  it('tracks caption usage separately from image usage', async () => {
    const runner = new ResilientCaptionGenerator(new MockCaptionGenerator(), {
      logger: silentProviderLogger,
    });
    const caption = await runner.generate(captionRequest);
    expect(caption.fullText).toContain(AFFILIATE_URL);
    expect(runner.getUsage().calls).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Redacted logging                                                          */
/* -------------------------------------------------------------------------- */

describe('provider runner — redacted error logging', () => {
  it('logs one warning per failed attempt with provider, attempt and retry intent', async () => {
    const { generator } = scriptedImage(async () => {
      throw new AiProviderError(
        'boom',
        { service: 'scripted_image', operation: 'generate', upstreamCode: 'UPSTREAM_5XX' },
        { retryable: true },
      );
    });
    const { logger, warnings } = capturingLogger();
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      runtime: instantRuntime().runtime,
      logger,
    });

    await expect(runner.generate(imageRequest)).rejects.toThrow();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({
      provider: 'scripted_image',
      providerKind: 'mock',
      operation: 'generate_image',
      attempt: 1,
      maxAttempts: 2,
      failureKind: 'transient',
      willRetry: true,
    });
    expect(warnings[1]).toMatchObject({ attempt: 2, willRetry: false });
    // Single-line, bounded message; never a multi-line stack dump.
    expect(typeof warnings[0]?.error).toBe('string');
    expect((warnings[0]?.error as string).includes('\n')).toBe(false);
    expect((warnings[0]?.error as string).length).toBeLessThanOrEqual(200);
  });

  it('redacts credentials embedded in provider error messages', async () => {
    const { generator } = scriptedImage(async () => {
      throw new AiProviderError(
        'auth failed for key sk-1234567890abcdef1234567890abcdef with Bearer abcdef0123456789abcdef0123456789',
        { service: 'scripted_image', operation: 'generate', upstreamCode: 'AI_UNAUTHORIZED' },
        { retryable: false },
      );
    });
    const { logger, warnings } = capturingLogger();
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 1 },
      runtime: instantRuntime().runtime,
      logger,
    });

    await expect(runner.generate(imageRequest)).rejects.toThrow();
    const logged = String(warnings[0]?.error ?? '');
    expect(logged).not.toContain('sk-1234567890abcdef1234567890abcdef');
    expect(logged).not.toContain('abcdef0123456789abcdef0123456789');
    expect(logged).toContain('[REDACTED]');
  });

  it('the rethrown error message is also redacted', async () => {
    const { generator } = scriptedImage(async () => {
      throw new AiProviderError(
        'auth failed api_key=super-secret-value-42',
        { service: 'scripted_image', operation: 'generate', upstreamCode: 'AI_UNAUTHORIZED' },
        { retryable: false },
      );
    });
    const runner = new ResilientImageGenerator(generator, {
      policy: { maxAttempts: 1 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });

    const error = await runner.generate(imageRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(String((error as Error).message)).not.toContain('super-secret-value-42');
  });
});

/* -------------------------------------------------------------------------- */
/*  Mock vs live distinction                                                  */
/* -------------------------------------------------------------------------- */

describe('provider runner — honest mock/live labelling', () => {
  it('preserves the wrapped provider kind and model on the resilient facade', async () => {
    const runner = new ResilientImageGenerator(new MockImageGenerator(), {
      logger: silentProviderLogger,
    });
    expect(runner.info.kind).toBe('mock');
    expect(runner.info.model).toBe('mock-image-v1');
    expect(runner.info.ready).toBe(true);
    expect(runner.info.detail).toMatch(/resilient/i);
  });

  it('labels a live-kind provider as live without ever calling a network', async () => {
    const liveStub: ImageGeneratorStub = {
      info: {
        name: 'live_stub',
        kind: 'live',
        model: 'some-live-model',
        ready: false,
        detail: 'Not configured in this environment.',
      },
      generate: async () => okImage,
    };
    const runner = new ResilientImageGenerator(liveStub, { logger: silentProviderLogger });
    expect(runner.info.kind).toBe('live');
    expect(runner.info.ready).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Unavailable (configured-but-unimplemented) live adapters                  */
/* -------------------------------------------------------------------------- */

describe('unavailable live adapters — fail fast, never pretend', () => {
  it('reports ready:false and a BLOCKED/NOT_TESTED detail', () => {
    const image = new UnavailableImageGenerator('openai');
    expect(image.info.ready).toBe(false);
    expect(image.info.kind).toBe('live');
    expect(image.info.detail).toMatch(/BLOCKED|NOT_TESTED/);
    expect(image.info.detail).toMatch(/No API call was made/i);

    const caption = new UnavailableCaptionGenerator('google');
    expect(caption.info.ready).toBe(false);
    expect(caption.info.detail).toMatch(/BLOCKED|NOT_TESTED/);
  });

  it('throws a typed, NON-retryable AI_PROVIDER_UNAVAILABLE on every call', async () => {
    const image = new UnavailableImageGenerator('openai');
    const error = await image.generate(imageRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    const aiError = error as AiProviderError;
    expect(aiError.context.upstreamCode).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(aiError.retryable).toBe(false);
    expect(aiError.message).toMatch(/no API call was attempted/i);
  });

  it('is not retried by the resilience layer (permanent => single attempt)', async () => {
    const spy = vi.fn();
    const unavailable = new UnavailableImageGenerator('openai');
    const passthrough: ImageGeneratorStub = {
      info: unavailable.info,
      generate: async (request) => {
        spy();
        return unavailable.generate(request);
      },
    };
    const runner = new ResilientImageGenerator(passthrough, {
      policy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      runtime: instantRuntime().runtime,
      logger: silentProviderLogger,
    });

    await expect(runner.generate(imageRequest)).rejects.toThrow(/unavailable/i);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(runner.getUsage().failures).toBe(1);
    expect(runner.getUsage().retries).toBe(0);
  });

  it('the caption adapter also fails fast with an explicit reason', async () => {
    const caption = new UnavailableCaptionGenerator('openai');
    await expect(caption.generate(captionRequest)).rejects.toThrow(/unavailable/i);
  });
});
