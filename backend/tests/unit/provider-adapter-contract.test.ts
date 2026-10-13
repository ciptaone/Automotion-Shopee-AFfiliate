/**
 * PART 6 §2/§6 — adapter contract.
 *
 * Proves that capabilities are explicit (no "OpenAI-compatible means images"),
 * that validation widens nothing, that adapters forward only whitelisted
 * parameters, that the mandatory `#ai #automation` ending and the exact
 * affiliate URL are guaranteed centrally, and that failures surface instead of
 * silently falling back to a mock. Offline: the transport is a labelled stub.
 */
import { describe, it, expect } from 'vitest';
import {
  ADAPTER_REGISTRY,
  applyCaptionEnding,
  buildCaptionMessages,
  capabilitiesOf,
  createCaptionClient,
  createImageClient,
  getAdapter,
  validateAgainstAdapter,
} from '../../src/providers/adapters.js';
import type { HttpTransport, TransportRequest } from '../../src/providers/transport.js';
import {
  ADAPTER_TYPES,
  type AdapterType,
  type ProviderConfig,
} from '../../src/providers/types.js';
import type {
  CaptionGenerationRequest,
  GeneratedImage,
  ImageGenerationRequest,
} from '../../src/contracts/index.js';
import { AiProviderError, CapabilityUnsupportedError, ProviderConfigError } from '../../src/core/errors.js';

/* -------------------------------------------------------------------------- */
/*  Fixtures (synthetic test data only)                                       */
/* -------------------------------------------------------------------------- */

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'cfg-1',
    name: 'test-provider',
    displayName: 'Test Provider',
    adapterType: 'openai_chat_completions',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model-1',
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
  };
}

const PRODUCT = {
  id: 'synthetic-1',
  name: 'Synthetic Test Product',
  marketplace: 'Shopee',
  productUrl: 'https://shopee.co.id/product/synthetic-1',
  affiliateUrl: 'https://s.shopee.co.id/aff-synthetic-1',
  price: null,
  currency: null,
  commissionRate: null,
  imageUrl: null,
  category: 'Lainnya',
  rating: null,
  soldCount: null,
  raw: {},
};

const AFFILIATE_URL = 'https://s.shopee.co.id/aff-synthetic-1';

function captionRequest(overrides: Partial<CaptionGenerationRequest> = {}): CaptionGenerationRequest {
  return {
    product: PRODUCT,
    affiliateUrl: AFFILIATE_URL,
    language: 'id',
    tone: 'soft_sell',
    timeoutMs: 30_000,
    ...overrides,
  };
}

function imageRequest(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    seed: 1,
    prompt: 'A synthetic product photo of a plain cardboard box on white.',
    width: 512,
    height: 512,
    referenceImageUrls: [],
    timeoutMs: 30_000,
    ...overrides,
  };
}

type StubCall = TransportRequest;

/** Labelled stub transport: records calls and replays scripted responses. */
function stubTransport(
  handler: (request: TransportRequest, index: number) => unknown,
): { transport: HttpTransport; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const transport = {
    async request(request: TransportRequest) {
      const index = calls.length;
      calls.push(request);
      const out = handler(request, index);
      if (out instanceof Error) throw out;
      if (
        out &&
        typeof out === 'object' &&
        'status' in out &&
        'json' in out &&
        'bytes' in out
      ) {
        return out;
      }
      return {
        status: 200,
        requestId: 'req_stub_1',
        retryAfterMs: null,
        json: out ?? null,
        bytes: null,
        contentType: 'application/json',
        latencyMs: 1,
      };
    },
  } as unknown as HttpTransport;
  return { transport, calls };
}

function expectThrows(fn: () => unknown, ctor: unknown): Error {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ctor as new (...args: never[]) => Error);
  return caught as Error;
}

/* ========================================================================== */
/*  Registry + capability contract                                            */
/* ========================================================================== */

describe('adapter registry', () => {
  it('declares exactly the supported adapter types', () => {
    expect(Object.keys(ADAPTER_REGISTRY).sort()).toEqual([...ADAPTER_TYPES].sort());
    for (const type of ADAPTER_TYPES) {
      expect(getAdapter(type).type).toBe(type);
    }
  });

  it('never claims image generation for a text-only adapter', () => {
    expect(ADAPTER_REGISTRY.openai_chat_completions.capabilities.image_generation).toBe(false);
    expect(ADAPTER_REGISTRY.ollama_chat.capabilities.image_generation).toBe(false);
    expect(ADAPTER_REGISTRY.openai_chat_completions.createImageGenerator).toBeUndefined();
    expect(ADAPTER_REGISTRY.ollama_chat.createImageGenerator).toBeUndefined();
  });

  it('never claims text generation for the images adapter', () => {
    expect(ADAPTER_REGISTRY.openai_images.capabilities.text_generation).toBe(false);
    expect(ADAPTER_REGISTRY.openai_images.createCaptionGenerator).toBeUndefined();
  });

  it('reports capabilities for a stored config (declaration ∩ narrowing)', () => {
    const caps = capabilitiesOf(config({ capabilityOverrides: { image_editing: false } }));
    // text adapter cannot be widened to images by an override…
    expect(caps).toMatchObject({
      text_generation: true,
      image_generation: false,
      structured_output: true,
    });

    const images = capabilitiesOf(
      config({ adapterType: 'openai_images', capabilityOverrides: { image_editing: false } }),
    );
    expect(images).toMatchObject({
      text_generation: false,
      image_generation: true,
      image_reference_input: true,
      image_editing: false, // narrowed by the operator
    });
  });
});

describe('validateAgainstAdapter — narrowing allowed, widening rejected', () => {
  it('rejects an auth type the adapter does not speak', () => {
    const error = expectThrows(
      () =>
        validateAgainstAdapter(
          config({ adapterType: 'ollama_chat', auth: { type: 'header', headerName: 'x-api-key' } }),
        ),
        ProviderConfigError,
    );
    expect(error.message).toMatch(/supports auth types \[none, bearer\]/);
  });

  it('rejects parameters the adapter cannot translate', () => {
    const error = expectThrows(
      () => validateAgainstAdapter(config({ params: { temperature: 0.2, totally_fake: 1 } })),
      ProviderConfigError,
    );
    expect(error.message).toMatch(/totally_fake/);
  });

  it('rejects enabling a capability the adapter does not support', () => {
    const error = expectThrows(
      () =>
        validateAgainstAdapter(
          config({ adapterType: 'openai_chat_completions', capabilityOverrides: { image_generation: true } }),
        ),
        ProviderConfigError,
    );
    expect(error.message).toMatch(/Capability "image_generation" cannot be enabled/);
  });

  it('allows disabling a supported capability (narrowing)', () => {
    expect(() =>
      validateAgainstAdapter(config({ capabilityOverrides: { structured_output: false } })),
    ).not.toThrow();
  });
});

describe('client factories — unsupported capabilities fail loudly', () => {
  const contextWithout = (cfg: ProviderConfig) => ({
    config: cfg,
    secret: null,
    transport: stubTransport(() => ({})).transport,
  });

  it('refuses to build an image client for a text adapter', () => {
    expectThrows(() => createImageClient(contextWithout(config())), CapabilityUnsupportedError);
  });

  it('refuses to build a caption client for the images adapter', () => {
    expectThrows(
      () => createCaptionClient(contextWithout(config({ adapterType: 'openai_images' }))),
      CapabilityUnsupportedError,
    );
  });

  it('refuses when the operator narrowed the capability off', () => {
    expectThrows(
      () =>
        createCaptionClient(
          contextWithout(config({ capabilityOverrides: { text_generation: false } })),
        ),
      CapabilityUnsupportedError,
    );
  });
});

/* ========================================================================== */
/*  Centralized caption guarantees                                            */
/* ========================================================================== */

describe('applyCaptionEnding — mandatory hashtags are a backend guarantee', () => {
  it('appends the ending when the provider omitted it', () => {
    expect(applyCaptionEnding('Caption tanpa hashtag')).toBe(
      'Caption tanpa hashtag #ai #automation',
    );
  });

  it('keeps an already-correct ending byte-for-byte', () => {
    const text = 'Caption.\n\n#ai #automation';
    expect(applyCaptionEnding(text)).toBe(text);
  });

  it('strips everything after the mandatory ending', () => {
    expect(applyCaptionEnding('Caption\n#ai #automation\n#extra #tags')).toBe(
      'Caption\n#ai #automation',
    );
  });

  it('removes markdown code fences providers sometimes wrap output in', () => {
    expect(applyCaptionEnding('```text\nCaption.\n#ai #automation\n```')).toBe(
      'Caption.\n#ai #automation',
    );
  });
});

describe('buildCaptionMessages — editorial brief for every provider alike', () => {
  it('embeds the exact affiliate URL, the ending and the disclosure instruction', () => {
    const messages = buildCaptionMessages(captionRequest());
    const all = messages.map((m) => m.content).join('\n');
    expect(all).toContain(AFFILIATE_URL);
    expect(all).toContain('#ai #automation');
    expect(all).toMatch(/affiliate disclosure/i);
    expect(all).toMatch(/Never invent/i);
    expect(all).toMatch(/Never imply the account owner owns, received, tried, used/i);
    expect(messages[0]?.role).toBe('system');
  });

  it('passes exact rejection feedback on a regeneration attempt', () => {
    const messages = buildCaptionMessages(
      captionRequest({
        regenerationAttempt: 2,
        previousIssues: [{ rule: 'affiliate_url', message: 'URL missing' }],
      }),
    );
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('attempt 2');
    expect(user).toContain('[affiliate_url] URL missing');
  });

  it('uses the pipeline brief when one is supplied', () => {
    const messages = buildCaptionMessages(
      captionRequest({
        editorialBrief: {
          mandatoryFinalHashtags: ['#uji', '#automation'],
          disclosureHint: 'Wajib tulis "icicic afiliasi".',
          claimPolicy: 'Dilarang keras menyebut "saya punya".',
        } as unknown as NonNullable<CaptionGenerationRequest['editorialBrief']>,
      }),
    );
    const system = messages[0]?.content ?? '';
    expect(system).toContain('#uji #automation');
    expect(system).toContain('icicic afiliasi');
    expect(system).toContain('Dilarang keras menyebut "saya punya".');
  });
});

/* ========================================================================== */
/*  openai_chat_completions                                                   */
/* ========================================================================== */

describe('openai_chat_completions adapter', () => {
  it('produces a caption that ends exactly with the mandatory hashtags', async () => {
    const { transport, calls } = stubTransport(() => ({
      choices: [
        {
          message: {
            content: `Cek produknya sekarang ya. ${AFFILIATE_URL}\n\n#ai #automation`,
          },
        },
      ],
    }));
    const client = createCaptionClient({ config: config(), secret: 'sk-test', transport });
    const caption = await client.generate(captionRequest());

    expect(caption.fullText.endsWith('#ai #automation')).toBe(true);
    expect(caption.model).toBe('test-model-1');
    expect(caption.embeddedUrl).toBe(AFFILIATE_URL);
    expect(caption.estimatedCostUsd).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('appends the ending when the model forgot it, without touching the rest', async () => {
    const { transport } = stubTransport(() => ({
      choices: [{ message: { content: 'Klik linknya ya.\n\n#Shopee' } }],
    }));
    const client = createCaptionClient({ config: config(), secret: null, transport });
    const caption = await client.generate(captionRequest());
    expect(caption.fullText).toBe('Klik linknya ya.\n\n#Shopee #ai #automation');
  });

  it('forwards only whitelisted parameters and the auth header', async () => {
    const { transport, calls } = stubTransport(() => ({
      choices: [{ message: { content: 'ok #ai #automation' } }],
    }));
    const client = createCaptionClient({
      config: config({
        params: { temperature: 0.3, response_format: { type: 'text' }, made_up_param: 'x' },
      }),
      secret: 'sk-live-value-1234567890',
      transport,
    });
    await client.generate(captionRequest());

    const body = JSON.parse(calls[0]?.body as string) as Record<string, unknown>;
    expect(body['temperature']).toBe(0.3);
    expect(body['response_format']).toEqual({ type: 'text' });
    expect(body['made_up_param']).toBeUndefined();
    expect(body['model']).toBe('test-model-1');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-live-value-1234567890');
  });

  it('reports an empty completion instead of inventing text', async () => {
    const { transport } = stubTransport(() => ({ choices: [{ message: { content: '   ' } }] }));
    const client = createCaptionClient({ config: config(), secret: null, transport });
    const error = await client.generate(captionRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as Error).message).toMatch(/empty completion/);
  });

  it('reports an unexpected response shape instead of guessing', async () => {
    const { transport } = stubTransport(() => ({ totally: 'different' }));
    const client = createCaptionClient({ config: config(), secret: null, transport });
    const error = await client.generate(captionRequest()).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/did not contain a text completion/);
  });

  it('propagates transport failures (no silent mock fallback)', async () => {
    const failing = new AiProviderError('upstream exploded', {
      service: 'Test Provider',
      operation: 'generate_caption',
    }, { retryable: false });
    const { transport } = stubTransport(() => failing);
    const client = createCaptionClient({ config: config(), secret: null, transport });
    await expect(client.generate(captionRequest())).rejects.toBeInstanceOf(AiProviderError);
  });
});

/* ========================================================================== */
/*  ollama_chat                                                               */
/* ========================================================================== */

describe('ollama_chat adapter (self-hosted text)', () => {
  it('POSTs /api/chat with stream:false and mapped options', async () => {
    const { transport, calls } = stubTransport(() => ({
      message: { content: 'Hasil uji.' },
    }));
    const client = createCaptionClient({
      config: config({
        adapterType: 'ollama_chat',
        baseUrl: 'http://ollama.internal.test:11434',
        params: { temperature: 0.1, num_predict: 256 },
      }),
      secret: null,
      transport,
    });
    const caption = await client.generate(captionRequest());

    expect(calls[0]?.url).toBe('http://ollama.internal.test:11434/api/chat');
    expect(calls[0]?.headers['Authorization']).toBeUndefined();
    const body = JSON.parse(calls[0]?.body as string) as Record<string, unknown>;
    expect(body['stream']).toBe(false);
    expect(body['options']).toMatchObject({ temperature: 0.1, num_predict: 256 });
    expect(caption.fullText.endsWith('#ai #automation')).toBe(true);
  });

  it('fails when the response has no message content', async () => {
    const { transport } = stubTransport(() => ({ done: true }));
    const client = createCaptionClient({
      config: config({ adapterType: 'ollama_chat' }),
      secret: null,
      transport,
    });
    const error = await client.generate(captionRequest()).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/message content/);
  });
});

/* ========================================================================== */
/*  openai_images                                                             */
/* ========================================================================== */

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
}

describe('openai_images adapter', () => {
  const imageConfig = (overrides: Partial<ProviderConfig> = {}): ProviderConfig =>
    config({
      adapterType: 'openai_images',
      model: 'image-model-1',
      capabilityOverrides: {},
      ...overrides,
    });

  it('decodes base64 image data and reports honest dimensions', async () => {
    const { transport, calls } = stubTransport(() => ({
      data: [
        {
          b64_json: Buffer.from(pngBytes()).toString('base64'),
          size: '512x512',
        },
      ],
    }));
    const client = createImageClient({ config: imageConfig(), secret: 'sk-test', transport });
    const image: GeneratedImage = await client.generate(imageRequest());

    expect(image.bytes).toEqual(pngBytes());
    expect(image.mimeType).toBe('image/png');
    expect(image.width).toBe(512);
    expect(image.height).toBe(512);
    expect(image.model).toBe('image-model-1');
    expect(image.estimatedCostUsd).toBeNull(); // never fabricate a price
    expect(calls[0]?.url).toBe('https://api.example.com/v1/images/generations');
  });

  it('downloads a returned URL through the bounded transport', async () => {
    const { transport, calls } = stubTransport((request) => {
      if (request.operation === 'download_image') {
        return {
          status: 200,
          requestId: null,
          retryAfterMs: null,
          json: null,
          bytes: pngBytes(),
          contentType: 'image/png',
          latencyMs: 1,
        };
      }
      return { data: [{ url: 'https://cdn.example.com/generated/1.png' }] };
    });
    const client = createImageClient({ config: imageConfig(), secret: null, transport });
    const image = await client.generate(imageRequest());
    expect(image.bytes).toEqual(pngBytes());
    const download = calls.find((call) => call.operation === 'download_image');
    expect(download?.url).toBe('https://cdn.example.com/generated/1.png');
    expect(download?.responseKind).toBe('binary');
  });

  it('fails when the response has neither b64 nor a URL', async () => {
    const { transport } = stubTransport(() => ({ data: [{ revised_prompt: 'x' }] }));
    const client = createImageClient({ config: imageConfig(), secret: null, transport });
    const error = await client.generate(imageRequest()).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/neither base64 image data nor a download URL/);
  });

  it('fails when the response contains no image data at all', async () => {
    const { transport } = stubTransport(() => ({ data: [] }));
    const client = createImageClient({ config: imageConfig(), secret: null, transport });
    const error = await client.generate(imageRequest()).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/did not contain any image data/);
  });

  it('uses the edits endpoint ONLY when reference input + editing are enabled', async () => {
    const { transport, calls } = stubTransport((request) => {
      if (request.operation === 'fetch_reference_image') {
        return {
          status: 200,
          requestId: null,
          retryAfterMs: null,
          json: null,
          bytes: pngBytes(),
          contentType: 'image/png',
          latencyMs: 1,
        };
      }
      if (request.url.endsWith('/images/edits')) {
        return { data: [{ b64_json: Buffer.from(pngBytes()).toString('base64'), size: '512x512' }] };
      }
      return { data: [{ b64_json: Buffer.from(pngBytes()).toString('base64') }] };
    });
    const client = createImageClient({ config: imageConfig(), secret: null, transport });
    await client.generate(imageRequest({ referenceImageUrls: ['https://cf.example.com/ref-1.jpg'] }));

    expect(calls.map((call) => call.operation)).toEqual([
      'fetch_reference_image',
      'generate_image',
    ]);
    expect(calls[1]?.url).toBe('https://api.example.com/v1/images/edits');
    expect(calls[1]?.body).toBeInstanceOf(FormData);
  });

  it('ignores the reference when the operator narrowed image_editing off', async () => {
    const { transport, calls } = stubTransport(() => ({
      data: [{ b64_json: Buffer.from(pngBytes()).toString('base64') }],
    }));
    const client = createImageClient({
      config: imageConfig({ capabilityOverrides: { image_editing: false } }),
      secret: null,
      transport,
    });
    await client.generate(imageRequest({ referenceImageUrls: ['https://cf.example.com/ref-1.jpg'] }));

    // Plain generation — the edit capability was explicitly disabled.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example.com/v1/images/generations');
  });

  it('aborts when a reference image cannot be fetched (no substitution)', async () => {
    const { transport } = stubTransport((request) => {
      if (request.operation === 'fetch_reference_image') {
        return {
          status: 200,
          requestId: null,
          retryAfterMs: null,
          json: null,
          bytes: new Uint8Array(0),
          contentType: 'image/png',
          latencyMs: 1,
        };
      }
      return { data: [{ b64_json: Buffer.from(pngBytes()).toString('base64') }] };
    });
    const client = createImageClient({ config: imageConfig(), secret: null, transport });
    const error = await client
      .generate(imageRequest({ referenceImageUrls: ['https://cf.example.com/ref-1.jpg'] }))
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/could not fetch reference image #1/);
    expect((error as Error).message).toMatch(/rather than substituting/i);
  });
});

/* ========================================================================== */
/*  Misc                                                                      */
/* ========================================================================== */

describe('adapter types are exhaustive', () => {
  it('every ADAPTER_TYPES entry resolves to a definition', () => {
    const types: readonly AdapterType[] = ADAPTER_TYPES;
    expect(types.every((type) => getAdapter(type).label.length > 0)).toBe(true);
  });
});
