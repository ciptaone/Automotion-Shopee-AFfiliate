/**
 * PART 6 §2/§5/§6/§10 — provider-aware generation router.
 *
 * Covers: independent text/image selection, attribution naming the provider
 * that actually produced the output, env-default ONLY when nothing is
 * selected, no silent fallback to a mock, capability narrowing, budget gating
 * before the request, and a usage record for every request (success or error).
 *
 * Offline: DNS is a labelled mock resolver and all HTTP is a labelled fetch
 * mock. Nothing is published.
 */
import { describe, it, expect } from 'vitest';
import { createGenerationRouter } from '../../src/providers/generation-router.js';
import { ProviderService } from '../../src/providers/provider-service.js';
import { InMemoryProviderStore } from '../../src/providers/provider-store.js';
import { EndpointPolicy } from '../../src/providers/endpoint-policy.js';
import { HttpTransport, type FetchLike } from '../../src/providers/transport.js';
import { InMemorySecretStore, SecretCipher } from '../../src/secrets/secret-store.js';
import { InMemoryUsageStore } from '../../src/usage/usage-store.js';
import { UsageService } from '../../src/usage/usage-service.js';
import type {
  CaptionGenerator,
  CaptionGenerationRequest,
  GeneratedCaption,
  GeneratedImage,
  ImageGenerator,
  ImageGenerationRequest,
} from '../../src/contracts/index.js';
import { BudgetExhaustedError, CapabilityUnsupportedError } from '../../src/core/errors.js';
import type { ProviderConfig } from '../../src/providers/types.js';

const KEY = Buffer.alloc(32, 11);
const AFFILIATE_URL = 'https://s.shopee.co.id/aff-router-1';

const TEXT_INPUT = {
  name: 'router-text',
  displayName: 'Router Text',
  adapterType: 'openai_chat_completions' as const,
  baseUrl: 'https://api.example.com/v1',
  model: 'router-text-model',
  auth: { type: 'bearer' as const },
};

const IMAGE_INPUT = {
  name: 'router-image',
  displayName: 'Router Image',
  adapterType: 'openai_images' as const,
  baseUrl: 'https://images.example.com/v1',
  model: 'router-image-model',
  auth: { type: 'bearer' as const },
};

const PRODUCT = {
  id: 'synthetic-router',
  name: 'Synthetic Router Product',
  marketplace: 'Shopee',
  productUrl: 'https://shopee.co.id/product/synthetic-router',
  affiliateUrl: AFFILIATE_URL,
  price: null,
  currency: null,
  commissionRate: null,
  imageUrl: null,
  category: 'Lainnya',
  rating: null,
  soldCount: null,
  raw: {},
};

function captionRequest(): CaptionGenerationRequest {
  return { product: PRODUCT, affiliateUrl: AFFILIATE_URL, language: 'id', tone: 'soft_sell', timeoutMs: 30_000 };
}

function imageRequest(): ImageGenerationRequest {
  return {
    seed: 1,
    prompt: 'Synthetic plain box photo.',
    width: 512,
    height: 512,
    referenceImageUrls: [],
    timeoutMs: 30_000,
  };
}

/* Labelled stub default generators (used only when NO provider is selected). */
function stubCaptionGenerator(): CaptionGenerator & { calls: number } {
  const stub = {
    calls: 0,
    info: { name: 'env default (AI_TEXT_PROVIDER)', kind: 'mock' as const, model: 'mock-text-v1', ready: true, detail: 'Env caption generator.' },
    async generate(_request: CaptionGenerationRequest): Promise<GeneratedCaption> {
      stub.calls += 1;
      return {
        hook: 'Hook.',
        body: 'Body.',
        hashtags: ['ai', 'automation'],
        embeddedUrl: AFFILIATE_URL,
        fullText: `Caption. ${AFFILIATE_URL}\n\n#ai #automation`,
        model: 'mock-text-v1',
        provider: { name: 'env default (AI_TEXT_PROVIDER)', kind: 'mock', model: 'mock-text-v1', ready: true, detail: '' },
        validation: { valid: true, errors: [], warnings: [] },
        attempts: 1,
        estimatedCostUsd: null,
      } as unknown as GeneratedCaption;
    },
  };
  return stub;
}

function stubImageGenerator(): ImageGenerator & { calls: number } {
  const stub = {
    calls: 0,
    info: { name: 'env default (AI_IMAGE_PROVIDER)', kind: 'mock' as const, model: 'mock-image-v1', ready: true, detail: 'Env image generator.' },
    async generate(_request: ImageGenerationRequest): Promise<GeneratedImage> {
      stub.calls += 1;
      return {
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'image/png',
        width: 512,
        height: 512,
        seed: 1,
        model: 'mock-image-v1',
        estimatedCostUsd: null,
      } as unknown as GeneratedImage;
    },
  };
  return stub;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_router_1' },
  });
}

function makeRouter(options: {
  fetchImpl?: FetchLike;
  budgets?: { dailyBudgetUsd: number | null; monthlyBudgetUsd: number | null };
} = {}) {
  const policy = new EndpointPolicy({ lookup: async () => ['93.184.216.34'] });
  const transport = new HttpTransport({
    policy,
    fetchImpl: options.fetchImpl ?? (async () => jsonResponse({ ok: true })),
  });
  const store = new InMemoryProviderStore();
  const usage = new UsageService(
    new InMemoryUsageStore(),
    () => options.budgets ?? { dailyBudgetUsd: null, monthlyBudgetUsd: null },
    'Asia/Jakarta',
  );
  const providers = new ProviderService({
    store,
    secrets: new InMemorySecretStore(new SecretCipher(KEY)),
    policy,
    transport,
    usage,
  });
  const defaultCaption = stubCaptionGenerator();
  const defaultImage = stubImageGenerator();
  const router = createGenerationRouter({ providers, usage, defaultCaption, defaultImage });
  return { router, providers, usage, defaultCaption, defaultImage, store, transport };
}

async function configure(providers: ProviderService): Promise<{ textId: string; imageId: string }> {
  const text = await providers.create(TEXT_INPUT);
  const image = await providers.create(IMAGE_INPUT);
  await providers.setSecret(text.id, { secret: 'sk-live-router-1234567890' });
  await providers.setSecret(image.id, { secret: 'sk-live-router-1234567890' });
  return { textId: text.id, imageId: image.id };
}

/** Router over a pre-seeded store (simulates a restored/edited workspace). */
function makeRouterWith(store: InMemoryProviderStore) {
  const policy = new EndpointPolicy({ lookup: async () => ['93.184.216.34'] });
  const transport = new HttpTransport({ policy, fetchImpl: async () => jsonResponse({ ok: true }) });
  const usage = new UsageService(
    new InMemoryUsageStore(),
    () => ({ dailyBudgetUsd: null, monthlyBudgetUsd: null }),
    'Asia/Jakarta',
  );
  const providers = new ProviderService({
    store,
    secrets: new InMemorySecretStore(new SecretCipher(KEY)),
    policy,
    transport,
    usage,
  });
  const defaultCaption = stubCaptionGenerator();
  const defaultImage = stubImageGenerator();
  const router = createGenerationRouter({ providers, usage, defaultCaption, defaultImage });
  return { router, defaultCaption, defaultImage };
}

/* ========================================================================== */

describe('generation router — env default only when nothing is selected', () => {
  it('uses the env default and labels the source honestly', async () => {
    const { router, defaultCaption } = makeRouter();
    const caption = await router.forCaption().generate(captionRequest());

    expect(defaultCaption.calls).toBe(1);
    expect(caption.attribution?.source).toBe('env_default');
    expect(caption.attribution?.adapterType).toBe('env_default');
    expect(caption.attribution?.warnings.join(' ')).toMatch(/No text provider selected/);
  });

  it('the env default info explains it is a configuration state, not a fallback', () => {
    const { router } = makeRouter();
    const info = router.forCaption().info;
    expect(info.detail).toMatch(/environment-configured default/);
    expect(info.detail).toMatch(/configuration state, not a fallback/);
    expect(info.kind).toBe('mock');
  });

  it('records the env-default request in the usage ledger', async () => {
    const { router, usage } = makeRouter();
    await router.forCaption().generate(captionRequest());

    const summary = await usage.summary(5);
    expect(summary.day.requests).toBe(1);
    expect(summary.recent[0]).toMatchObject({
      adapterType: 'env_default',
      operation: 'text_generation',
      costKind: 'unknown',
    });
  });
});

describe('generation router — configured provider selection', () => {
  const chatResponse = (content: string) =>
    jsonResponse({ choices: [{ message: { content } }] });

  it('routes to the SELECTED provider and attributes the result to it', async () => {
    const { router, providers, usage, defaultCaption } = makeRouter({
      fetchImpl: async () => chatResponse(`Coba cek. ${AFFILIATE_URL}\n\n#ai #automation`),
    });
    const { textId } = await configure(providers);
    await providers.setSelection({ textProviderId: textId, imageProviderId: null });

    const caption = await router.forCaption().generate(captionRequest());

    expect(defaultCaption.calls).toBe(0); // no fallback
    expect(caption.attribution?.source).toBe('configured_provider');
    expect(caption.attribution?.providerId).toBe(textId);
    expect(caption.attribution?.model).toBe('router-text-model');
    expect(caption.attribution?.adapterType).toBe('openai_chat_completions');
    expect(caption.fullText.endsWith('#ai #automation')).toBe(true);

    const summary = await usage.summary(5);
    expect(summary.recent[0]).toMatchObject({
      providerId: textId,
      adapterType: 'openai_chat_completions',
      operation: 'text_generation',
      status: 'success',
    });
  });

  it('selects text and image INDEPENDENTLY', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { router, providers, defaultCaption, defaultImage } = makeRouter({
      fetchImpl: async (url) => {
        if (url.includes('/images/generations')) {
          return jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64'), size: '512x512' }] });
        }
        return chatResponseLike();
      },
    });
    function chatResponseLike() {
      return jsonResponse({ choices: [{ message: { content: `Teks. ${AFFILIATE_URL}\n\n#ai #automation` } }] });
    }
    const { textId, imageId } = await configure(providers);
    await providers.setSelection({ textProviderId: textId, imageProviderId: imageId });

    const caption = await router.forCaption().generate(captionRequest());
    const image = await router.forImage().generate(imageRequest());

    expect(caption.attribution?.providerId).toBe(textId);
    expect(image.attribution?.providerId).toBe(imageId);
    expect(image.attribution?.model).toBe('router-image-model');
    expect(defaultCaption.calls).toBe(0);
    expect(defaultImage.calls).toBe(0);
  });

  it('the info getter names the selected provider, its model and endpoint', async () => {
    const { router, providers } = makeRouter();
    const { textId } = await configure(providers);
    await providers.setSelection({ textProviderId: textId, imageProviderId: null });
    await providers.init();

    const info = router.forCaption().info;
    expect(info.name).toBe('Router Text');
    expect(info.kind).toBe('live');
    expect(info.model).toBe('router-text-model');
    expect(info.detail).toMatch(/Selected text provider/);
  });
});

describe('generation router — no silent fallback, capability narrowing', () => {
  /** Build a full ProviderConfig without going through the service. */
  function providerConfig(
    overrides: Partial<ProviderConfig> & { id: string },
  ): ProviderConfig {
    return {
      name: overrides.id,
      displayName: 'Seeded Provider',
      adapterType: 'openai_chat_completions',
      baseUrl: 'https://api.example.com/v1',
      model: 'seeded-model',
      auth: { type: 'bearer' },
      extraHeaders: {},
      params: {},
      timeoutMs: 30_000,
      maxRetries: 0,
      enabled: true,
      capabilityOverrides: {},
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
      ...overrides,
    } as ProviderConfig;
  }

  it('an unsupported capability throws instead of falling back', async () => {
    // Pre-seed a workspace whose TEXT selection points at a text-less provider.
    // `setSelection` would refuse this; the router must ALSO refuse — never
    // silently substitute the env default.
    const seeded = providerConfig({ id: 'seed-image', adapterType: 'openai_images' });
    const store = new InMemoryProviderStore();
    await store.save({
      providers: [seeded],
      textProviderId: seeded.id,
      imageProviderId: null,
      readiness: {},
      updatedAt: new Date(0).toISOString(),
    });

    const { router, defaultCaption } = makeRouterWith(store);
    await expect(router.forCaption().generate(captionRequest())).rejects.toThrow(
      CapabilityUnsupportedError,
    );
    expect(defaultCaption.calls).toBe(0);
  });

  it('an upstream failure propagates; the default is never substituted', async () => {
    const { router, providers, defaultCaption, usage } = makeRouter({
      fetchImpl: async () => jsonResponse({ error: { message: 'bad key' } }, 401),
    });
    const { textId } = await configure(providers);
    await providers.setSelection({ textProviderId: textId, imageProviderId: null });

    await expect(router.forCaption().generate(captionRequest())).rejects.toThrow();
    expect(defaultCaption.calls).toBe(0);

    // The failure is recorded honestly in the ledger.
    const summary = await usage.summary(5);
    expect(summary.recent[0]).toMatchObject({ status: 'error', providerId: textId });
    expect(summary.recent[0]?.errorCode).toBeTruthy();
  });

  it('a missing credential fails closed (no request, no fallback)', async () => {
    const { router, providers, defaultCaption } = makeRouter();
    const text = await providers.create(TEXT_INPUT); // no secret stored
    await providers.setSelection({ textProviderId: text.id, imageProviderId: null });

    await expect(router.forCaption().generate(captionRequest())).rejects.toThrow(/credential/i);
    expect(defaultCaption.calls).toBe(0);
  });

  it('honours an operator-disabled capability (narrowing) even if selected', async () => {
    const seeded = providerConfig({
      id: 'seed-narrowed',
      capabilityOverrides: { image_generation: false },
    });
    const store = new InMemoryProviderStore();
    await store.save({
      providers: [seeded],
      textProviderId: null,
      imageProviderId: seeded.id,
      readiness: {},
      updatedAt: new Date(0).toISOString(),
    });

    const { router, defaultImage } = makeRouterWith(store);
    await expect(router.forImage().generate(imageRequest())).rejects.toThrow(
      CapabilityUnsupportedError,
    );
    expect(defaultImage.calls).toBe(0);
  });
});

describe('generation router — budget gating (§10)', () => {
  it('blocks generation before the request when the daily budget is spent', async () => {
    const store = new InMemoryUsageStore();
    await store.append({
      id: 'r1',
      at: new Date().toISOString(),
      providerId: null,
      providerName: 'x',
      adapterType: null,
      model: 'x',
      operation: 'text_generation',
      requestId: null,
      status: 'success',
      latencyMs: 1,
      inputTokens: null,
      outputTokens: null,
      images: null,
      costUsd: 10,
      costKind: 'actual',
      errorCode: null,
    });

    const policy = new EndpointPolicy({ lookup: async () => ['93.184.216.34'] });
    const usage = new UsageService(store, () => ({ dailyBudgetUsd: 1, monthlyBudgetUsd: null }), 'Asia/Jakarta');
    const providers = new ProviderService({
      store: new InMemoryProviderStore(),
      secrets: new InMemorySecretStore(new SecretCipher(KEY)),
      policy,
      transport: new HttpTransport({ policy, fetchImpl: async () => jsonResponse({}) }),
      usage,
    });
    const defaultCaption = stubCaptionGenerator();
    const router = createGenerationRouter({
      providers,
      usage,
      defaultCaption,
      defaultImage: stubImageGenerator(),
    });

    // No provider is selected, but even the env default is gated by the budget.
    await expect(router.forCaption().generate(captionRequest())).rejects.toThrow(BudgetExhaustedError);
    expect(defaultCaption.calls).toBe(0);

    await expect(router.forImage().generate(imageRequest())).rejects.toThrow(BudgetExhaustedError);
  });

  it('an unknown-cost request does not exhaust the budget', async () => {
    const store = new InMemoryUsageStore();
    await store.append({
      id: 'r1',
      at: new Date().toISOString(),
      providerId: null,
      providerName: 'x',
      adapterType: null,
      model: 'x',
      operation: 'text_generation',
      requestId: null,
      status: 'success',
      latencyMs: 1,
      inputTokens: null,
      outputTokens: null,
      images: null,
      costUsd: null, // unknown cost
      costKind: 'unknown',
      errorCode: null,
    });

    const policy = new EndpointPolicy({ lookup: async () => ['93.184.216.34'] });
    const usage = new UsageService(store, () => ({ dailyBudgetUsd: 0.0001, monthlyBudgetUsd: null }), 'Asia/Jakarta');
    const providers = new ProviderService({
      store: new InMemoryProviderStore(),
      secrets: new InMemorySecretStore(new SecretCipher(KEY)),
      policy,
      transport: new HttpTransport({ policy, fetchImpl: async () => jsonResponse({}) }),
      usage,
    });
    const defaultCaption = stubCaptionGenerator();
    const router = createGenerationRouter({
      providers,
      usage,
      defaultCaption,
      defaultImage: stubImageGenerator(),
    });

    await expect(router.forCaption().generate(captionRequest())).resolves.toBeTruthy();
    expect(defaultCaption.calls).toBe(1);
  });
});
