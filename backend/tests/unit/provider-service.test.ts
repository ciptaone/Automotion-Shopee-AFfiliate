/**
 * PART 6 §2/§4/§5 — provider workspace service.
 *
 * Covers: configuration validation (slug, adapter contract, SSRF endpoint),
 * explicit capability readiness (never `ready` without a test), write-only
 * secrets with masking and fail-closed behaviour, independent text/image
 * selection with `fallback: "none"`, in-use protection, and bounded test
 * actions that never publish and always record usage.
 *
 * Offline: DNS is a labelled mock resolver and every HTTP call goes through a
 * real `HttpTransport` whose `fetch` is a labelled mock.
 */
import { describe, it, expect } from 'vitest';
import { ProviderService } from '../../src/providers/provider-service.js';
import { InMemoryProviderStore } from '../../src/providers/provider-store.js';
import { EndpointPolicy } from '../../src/providers/endpoint-policy.js';
import { HttpTransport, type FetchLike } from '../../src/providers/transport.js';
import {
  InMemorySecretStore,
  SecretCipher,
} from '../../src/secrets/secret-store.js';
import { InMemoryUsageStore } from '../../src/usage/usage-store.js';
import { UsageService } from '../../src/usage/usage-service.js';
import {
  CapabilityUnsupportedError,
  EndpointRejectedError,
  ProviderConfigError,
  ProviderNotFoundError,
} from '../../src/core/errors.js';

const KEY = Buffer.alloc(32, 7);

const TEXT_INPUT = {
  name: 'my-openai',
  displayName: 'My OpenAI',
  adapterType: 'openai_chat_completions',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-test',
  auth: { type: 'bearer' as const },
};

const IMAGE_INPUT = {
  name: 'my-images',
  displayName: 'My Images',
  adapterType: 'openai_images' as const,
  baseUrl: 'https://images.example.com/v1',
  model: 'image-test',
  auth: { type: 'bearer' as const },
};

const OLLAMA_INPUT = {
  name: 'local-ollama',
  displayName: 'Local Ollama',
  adapterType: 'ollama_chat' as const,
  baseUrl: 'http://ollama.example.test:11434',
  model: 'llama-test',
  auth: { type: 'none' as const },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test_1' },
  });
}

function makeService(
  options: {
    fetchImpl?: FetchLike;
    cipher?: SecretCipher | null;
    allowlist?: string[];
    resolvesTo?: string[];
  } = {},
): {
  service: ProviderService;
  usage: UsageService;
  secrets: InMemorySecretStore;
} {
  const policy = new EndpointPolicy({
    lookup: async () => options.resolvesTo ?? ['93.184.216.34'],
    allowlist: options.allowlist ?? [],
  });
  const transport = new HttpTransport({
    policy,
    fetchImpl: options.fetchImpl ?? (async () => jsonResponse({ ok: true })),
  });
  const secrets = new InMemorySecretStore(
    options.cipher === undefined ? new SecretCipher(KEY) : options.cipher,
  );
  const usage = new UsageService(
    new InMemoryUsageStore(),
    () => ({ dailyBudgetUsd: null, monthlyBudgetUsd: null }),
    'Asia/Jakarta',
  );
  return {
    service: new ProviderService({
      store: new InMemoryProviderStore(),
      secrets,
      policy,
      transport,
      usage,
    }),
    usage,
    secrets,
  };
}

/* ========================================================================== */
/*  Configuration validation                                                  */
/* ========================================================================== */

describe('provider configuration validation', () => {
  it('accepts a valid provider and reports honest readiness', async () => {
    const { service } = makeService();
    const view = await service.create(TEXT_INPUT);

    expect(view.id).toBeTruthy();
    expect(view.adapterLabel).toBe('OpenAI-compatible chat completions');
    expect(view.supportedTasks).toEqual(['text']);
    expect(view.capabilities).toMatchObject({
      text_generation: true,
      image_generation: false,
      structured_output: true,
    });
    expect(view.readiness['configuration']?.status).toBe('ready');
    expect(view.readiness['text_generation']?.status).toBe('not_configured'); // never "ready" without a test
    expect(view.readiness['image_generation']?.status).toBe('capability_unsupported');
    expect(view.selectedFor).toEqual([]);
    expect(view.secret).toMatchObject({ present: false, masked: null });
  });

  it('rejects a name that is not a slug', async () => {
    const { service } = makeService();
    await expect(service.create({ ...TEXT_INPUT, name: 'My Provider!' })).rejects.toThrow(
      ProviderConfigError,
    );
  });

  it('rejects a duplicate display name', async () => {
    const { service } = makeService();
    await service.create(TEXT_INPUT);
    await expect(service.create({ ...TEXT_INPUT })).rejects.toThrow(/already exists/);
  });

  it('rejects a parameter the adapter cannot translate', async () => {
    const { service } = makeService();
    await expect(
      service.create({ ...TEXT_INPUT, params: { nonsense_parameter: true } }),
    ).rejects.toThrow(/does not support parameter/);
  });

  it('rejects widening a capability the adapter does not provide', async () => {
    const { service } = makeService();
    await expect(
      service.create({ ...TEXT_INPUT, capabilityOverrides: { image_generation: true } }),
    ).rejects.toThrow(/cannot be enabled/);
  });

  it('rejects credentials supplied as static headers', async () => {
    const { service } = makeService();
    await expect(
      service.create({ ...TEXT_INPUT, extraHeaders: { Authorization: 'Bearer leaked' } }),
    ).rejects.toThrow(/carries credentials/);
  });

  it('rejects a private endpoint (SSRF) before it is stored', async () => {
    const { service } = makeService();
    await expect(
      service.create({ ...TEXT_INPUT, baseUrl: 'http://169.254.169.254/latest' }),
    ).rejects.toThrow(EndpointRejectedError);
    expect(await service.list()).toHaveLength(0);
  });

  it('accepts a self-hosted private endpoint ONLY when the operator allowlisted it', async () => {
    // DNS resolves the host to a private address; only the allowlist entry lets
    // it through (self-hosted escape hatch).
    const { service } = makeService({
      allowlist: ['ollama.internal.test:11434'],
      resolvesTo: ['10.1.2.3'],
    });
    const view = await service.create({
      ...OLLAMA_INPUT,
      baseUrl: 'http://ollama.internal.test:11434',
    });
    expect(view.readiness['configuration']?.status).toBe('ready');

    // Same host, but a port the operator did NOT allowlist → rejected.
    const { service: strict } = makeService({
      allowlist: ['ollama.internal.test:11434'],
      resolvesTo: ['10.1.2.3'],
    });
    await expect(
      strict.create({ ...OLLAMA_INPUT, baseUrl: 'http://ollama.internal.test:9999' }),
    ).rejects.toThrow(EndpointRejectedError);

    // And without any allowlist, the same private address is rejected outright.
    const { service: noAllowlist } = makeService({ resolvesTo: ['10.1.2.3'] });
    await expect(
      noAllowlist.create({ ...OLLAMA_INPUT, baseUrl: 'http://ollama.internal.test:11434' }),
    ).rejects.toThrow(EndpointRejectedError);
  });

  it('rejects an unknown provider id', async () => {
    const { service } = makeService();
    await expect(service.update('missing-id', TEXT_INPUT)).rejects.toThrow(ProviderNotFoundError);
    await expect(service.remove('missing-id')).rejects.toThrow(ProviderNotFoundError);
  });

  it('keeps capabilities honest after narrowing an adapter', async () => {
    const { service } = makeService();
    const view = await service.create({
      ...IMAGE_INPUT,
      capabilityOverrides: { image_editing: false },
    });
    expect(view.capabilities).toMatchObject({
      image_generation: true,
      image_reference_input: true,
      image_editing: false,
    });
    expect(view.readiness['image_editing']?.status).toBe('capability_unsupported');
  });
});

/* ========================================================================== */
/*  Secrets (write-only)                                                      */
/* ========================================================================== */

describe('provider secrets', () => {
  it('stores a secret and returns only masked metadata — never the value', async () => {
    const { service } = makeService();
    const provider = await service.create(TEXT_INPUT);

    const metadata = await service.setSecret(provider.id, { secret: 'sk-live-abcdefghij123456' });
    expect(metadata).toMatchObject({ present: true, updated: true, keyConfigured: true });
    expect(metadata.masked).toBe('sk-••••56');

    // Nothing anywhere in the API surface exposes the secret.
    const views = await service.list();
    expect(JSON.stringify(views)).not.toContain('sk-live-abcdefghij123456');
    expect(JSON.stringify(await service.get(provider.id))).not.toContain('sk-live-abcdefghij123456');

    // Server-side decryption still works for outbound requests.
    const config = await service.requireProvider(provider.id);
    expect(await service.secretFor(config)).toBe('sk-live-abcdefghij123456');
  });

  it('replaces and deletes a secret safely', async () => {
    const { service } = makeService();
    const provider = await service.create(TEXT_INPUT);

    await service.setSecret(provider.id, { secret: 'first-secret-value-1111111' });
    await service.setSecret(provider.id, { secret: 'second-secret-value-222222' });
    const config = await service.requireProvider(provider.id);
    expect(await service.secretFor(config)).toBe('second-secret-value-222222');

    const removed = await service.deleteSecret(provider.id);
    expect(removed).toMatchObject({ present: false, deleted: true });
    expect(await service.secretFor(config)).toBeNull();
  });

  it('rejects an empty or oversized secret', async () => {
    const { service } = makeService();
    const provider = await service.create(TEXT_INPUT);
    await expect(service.setSecret(provider.id, { secret: '' })).rejects.toThrow(
      ProviderConfigError,
    );
    await expect(service.setSecret(provider.id, { secret: 'x'.repeat(4097) })).rejects.toThrow(
      ProviderConfigError,
    );
  });

  it('rejects a secret for an auth-less provider', async () => {
    const { service } = makeService();
    const provider = await service.create(OLLAMA_INPUT);
    await expect(service.setSecret(provider.id, { secret: 'anything' })).rejects.toThrow(
      /auth.type "none"/,
    );
  });

  it('fails closed when no encryption key is configured', async () => {
    const { service, secrets } = makeService({ cipher: null });
    expect(secrets.keyConfigured).toBe(false);

    const provider = await service.create(TEXT_INPUT);
    // Honest configuration state instead of pretending it is usable.
    expect(provider.readiness['configuration']?.status).toBe('configuration_invalid');
    expect(provider.readiness['configuration']?.detail).toMatch(/SECRETS_ENCRYPTION_KEY/);

    await expect(
      service.setSecret(provider.id, { secret: 'sk-anything-1234567890' }),
    ).rejects.toThrow(/SECRETS_ENCRYPTION_KEY/);
    expect((await service.get(provider.id)).secret.keyConfigured).toBe(false);
  });
});

/* ========================================================================== */
/*  Selection                                                                 */
/* ========================================================================== */

describe('provider selection', () => {
  it('selects text and image providers independently with fallback "none"', async () => {
    const { service } = makeService();
    const text = await service.create(TEXT_INPUT);
    const image = await service.create(IMAGE_INPUT);

    const selection = await service.setSelection({
      textProviderId: text.id,
      imageProviderId: image.id,
    });
    expect(selection).toMatchObject({
      textProviderId: text.id,
      imageProviderId: image.id,
      fallback: 'none',
    });
    expect(selection.note).toMatch(/never switches provider/i);

    expect((await service.get(text.id)).selectedFor).toEqual(['text']);
    expect((await service.get(image.id)).selectedFor).toEqual(['image']);
  });

  it('refuses to select a provider for a task it does not support', async () => {
    const { service } = makeService();
    const image = await service.create(IMAGE_INPUT);
    await expect(
      service.setSelection({ textProviderId: image.id, imageProviderId: null }),
    ).rejects.toThrow(CapabilityUnsupportedError);
  });

  it('refuses to select a disabled provider', async () => {
    const { service } = makeService();
    const provider = await service.create({ ...TEXT_INPUT, enabled: false });
    await expect(
      service.setSelection({ textProviderId: provider.id, imageProviderId: null }),
    ).rejects.toThrow(/disabled/);
  });

  it('rejects a malformed selection payload', async () => {
    const { service } = makeService();
    await expect(service.setSelection({ textProviderId: 42 })).rejects.toThrow(ProviderConfigError);
  });

  it('protects a selected provider from being disabled or deleted', async () => {
    const { service } = makeService();
    const provider = await service.create(TEXT_INPUT);
    await service.setSelection({ textProviderId: provider.id, imageProviderId: null });

    await expect(service.update(provider.id, { ...TEXT_INPUT, enabled: false })).rejects.toThrow(
      /selected for text/,
    );
    await expect(service.remove(provider.id)).rejects.toThrow(/selected for text/);

    // Deselect first: now both operations are allowed.
    await service.setSelection({ textProviderId: null, imageProviderId: null });
    await expect(service.remove(provider.id)).resolves.toEqual({ deleted: true });
  });

  it('deleting a provider also removes its credential', async () => {
    const { service, secrets } = makeService();
    const provider = await service.create(TEXT_INPUT);
    await service.setSecret(provider.id, { secret: 'sk-deletable-1234567890' });
    expect(await secrets.has(provider.id)).toBe(true);

    await service.remove(provider.id);
    expect(await secrets.has(provider.id)).toBe(false);
  });
});

/* ========================================================================== */
/*  Test actions                                                              */
/* ========================================================================== */

describe('connection test', () => {
  it('reports ready with a sanitized, non-publishing note', async () => {
    const { service } = makeService({ fetchImpl: async () => jsonResponse({ ok: true }) });
    const provider = await service.create(TEXT_INPUT);

    const result = await service.testConnection(provider.id);
    expect(result).toMatchObject({ ok: true, kind: 'connection', status: 'ready' });
    expect(result.detail).toMatch(/Endpoint reachable \(HTTP 200\)/);
    expect(result.note).toMatch(/no content was generated/i);
    expect(result.readiness['configuration']?.status).toBe('ready');
    expect(result.readiness['configuration']?.testedAt).not.toBeNull();
    expect(result.requestId).toBe('req_test_1');
  });

  it('classifies HTTP 401 as an authentication failure', async () => {
    const { service } = makeService({
      fetchImpl: async () =>
        jsonResponse({ error: { message: 'invalid api key' } }, 401),
    });
    const provider = await service.create(TEXT_INPUT);

    const result = await service.testConnection(provider.id);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('authentication_failed');
    expect(result.readiness['authentication']?.status).toBe('authentication_failed');
    expect(result.detail).not.toContain('sk-live'); // never leaks a credential
  });

  it('reports an unreachable endpoint as temporarily unavailable', async () => {
    const { service } = makeService({
      fetchImpl: async () => {
        throw new Error('fetch failed: connect ECONNREFUSED 93.184.216.34:443');
      },
    });
    const provider = await service.create(TEXT_INPUT);
    const result = await service.testConnection(provider.id);
    // Reachable configuration-wise but the connection failed: temporary, and
    // never silently "ready".
    expect(result.status).toBe('temporarily_unavailable');
    expect(result.ok).toBe(false);
    expect(result.readiness['configuration']?.status).toBe('temporarily_unavailable');
  });

  it('rejects a test for a provider that was never configured', async () => {
    const { service } = makeService();
    await expect(service.testConnection('missing-id')).rejects.toThrow(ProviderNotFoundError);
    await expect(service.testText('missing-id')).rejects.toThrow(ProviderNotFoundError);
    await expect(service.testImage('missing-id')).rejects.toThrow(ProviderNotFoundError);
  });
});

describe('text generation test', () => {
  const chatResponse = (content: string) =>
    jsonResponse({ choices: [{ message: { content } }] });

  it('marks the text capability ready only after a real successful test', async () => {
    const { service, usage } = makeService({
      fetchImpl: async () => chatResponse('Uji coba provider.\n\n#ai #automation'),
    });
    const provider = await service.create(TEXT_INPUT);
    await service.setSecret(provider.id, { secret: 'sk-live-abcdefghij123456' });

    expect(provider.readiness['text_generation']?.status).toBe('not_configured');

    const result = await service.testText(provider.id);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.text?.endsWithMandatory).toBe(true);
    expect(result.text?.model).toBe('gpt-test');
    expect(result.note).toMatch(/fixture data/i);
    expect(result.note).toMatch(/never.*published|nothing was uploaded/i);
    expect(result.readiness['text_generation']?.status).toBe('ready');
    expect(result.readiness['authentication']?.status).toBe('ready');

    // The test was recorded in the usage ledger with an unknown cost.
    const summary = await usage.summary(5);
    expect(summary.day.requests).toBe(1);
    expect(summary.day.unknownCostRequests).toBe(1);
  });

  it('classifies HTTP 401 as authentication_failed', async () => {
    const { service } = makeService({
      fetchImpl: async () => jsonResponse({ error: { message: 'bad key' } }, 401),
    });
    const provider = await service.create(TEXT_INPUT);
    await service.setSecret(provider.id, { secret: 'sk-live-abcdefghij123456' });

    const result = await service.testText(provider.id);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('authentication_failed');
    expect(result.readiness['authentication']?.status).toBe('authentication_failed');
    expect(result.readiness['text_generation']?.status).toBe('authentication_failed');
  });

  it('classifies HTTP 429 as rate_limited', async () => {
    const { service } = makeService({
      fetchImpl: async () => jsonResponse({ error: { message: 'slow down' } }, 429),
    });
    const provider = await service.create(TEXT_INPUT);
    await service.setSecret(provider.id, { secret: 'sk-live-abcdefghij123456' });

    const result = await service.testText(provider.id);
    expect(result.status).toBe('rate_limited');
    expect(result.readiness['text_generation']?.status).toBe('rate_limited');
  });

  it('classifies a timeout as temporarily_unavailable', async () => {
    const { service } = makeService({
      // Labelled mock: behaves exactly like the transport's own abort.
      fetchImpl: async () => {
        const abort = new Error('The operation was aborted.');
        abort.name = 'AbortError';
        throw abort;
      },
    });
    const provider = await service.create({ ...TEXT_INPUT, timeoutMs: 1_000 });
    await service.setSecret(provider.id, { secret: 'sk-live-abcdefghij123456' });

    const result = await service.testText(provider.id);
    expect(result.status).toBe('temporarily_unavailable');
    expect(result.readiness['text_generation']?.status).toBe('temporarily_unavailable');
  });

  it('fails closed when the credential was never stored', async () => {
    const { service } = makeService();
    const provider = await service.create(TEXT_INPUT);

    const result = await service.testText(provider.id);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('authentication_failed');
    expect(result.detail).toMatch(/credential/i);
  });

  it('reports capability_unsupported for an image-only provider', async () => {
    const { service } = makeService();
    const provider = await service.create(IMAGE_INPUT);

    const result = await service.testText(provider.id);
    expect(result.status).toBe('capability_unsupported');
    expect(result.readiness['text_generation']?.status).toBe('capability_unsupported');
  });
});

describe('image generation test', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

  it('marks the image capability ready after a bounded test generation', async () => {
    const { service, usage } = makeService({
      fetchImpl: async () =>
        jsonResponse({
          data: [{ b64_json: Buffer.from(png).toString('base64'), size: '512x512' }],
        }),
    });
    const provider = await service.create(IMAGE_INPUT);
    await service.setSecret(provider.id, { secret: 'sk-live-abcdefghij123456' });

    const result = await service.testImage(provider.id);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.image).toMatchObject({ mimeType: 'image/png', width: 512, height: 512 });
    expect(result.image?.previewDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.readiness['image_generation']?.status).toBe('ready');
    expect(result.note).toMatch(/nothing was uploaded, stored or published/i);

    const summary = await usage.summary(5);
    expect(summary.day.images).toBe(1);
    expect(summary.day.unknownCostRequests).toBe(1); // cost honestly unknown
  });

  it('reports capability_unsupported for a text-only provider', async () => {
    const { service } = makeService();
    const provider = await service.create(TEXT_INPUT);
    const result = await service.testImage(provider.id);
    expect(result.status).toBe('capability_unsupported');
    expect(result.readiness['image_generation']?.status).toBe('capability_unsupported');
  });

  it('classifies an upstream 500 as temporarily_unavailable', async () => {
    const { service } = makeService({
      fetchImpl: async () => jsonResponse({ error: { message: 'boom' } }, 500),
    });
    const provider = await service.create(IMAGE_INPUT);
    await service.setSecret(provider.id, { secret: 'sk-live-abcdefghij123456' });

    const result = await service.testImage(provider.id);
    expect(result.status).toBe('temporarily_unavailable');
  });
});

/* ========================================================================== */
/*  Readiness invalidation                                                    */
/* ========================================================================== */

describe('readiness stays honest across configuration changes', () => {
  it('resets tested capabilities when the configuration changes', async () => {
    const { service } = makeService({
      fetchImpl: async () =>
        jsonResponse({ choices: [{ message: { content: 'ok #ai #automation' } }] }),
    });
    const provider = await service.create(TEXT_INPUT);
    await service.setSecret(provider.id, { secret: 'sk-live-abcdefghij123456' });

    const before = await service.testText(provider.id);
    expect(before.readiness['text_generation']?.status).toBe('ready');

    const updated = await service.update(provider.id, {
      ...TEXT_INPUT,
      baseUrl: 'https://api.example.com/v2',
    });
    expect(updated.readiness['text_generation']?.status).toBe('not_configured');
    expect(updated.readiness['text_generation']?.detail).toMatch(/Configuration changed/);
    // The endpoint itself is still structurally valid.
    expect(updated.readiness['configuration']?.status).toBe('ready');
  });
});

/* ========================================================================== */
/*  Workspace persistence                                                     */
/* ========================================================================== */

describe('provider workspace persistence', () => {
  it('reloads providers, selections and readiness from the store (restart)', async () => {
    const store = new InMemoryProviderStore();
    const policy = new EndpointPolicy({ lookup: async () => ['93.184.216.34'] });
    const transport = new HttpTransport({ policy, fetchImpl: async () => jsonResponse({ ok: true }) });
    const usage = new UsageService(
      new InMemoryUsageStore(),
      () => ({ dailyBudgetUsd: null, monthlyBudgetUsd: null }),
      'Asia/Jakarta',
    );

    const first = new ProviderService({
      store,
      secrets: new InMemorySecretStore(new SecretCipher(KEY)),
      policy,
      transport,
      usage,
    });
    const provider = await first.create(TEXT_INPUT);
    await first.setSelection({ textProviderId: provider.id, imageProviderId: null });
    await first.testConnection(provider.id);

    // Simulated restart: a fresh service instance over the same store.
    const restarted = new ProviderService({
      store,
      secrets: new InMemorySecretStore(new SecretCipher(KEY)),
      policy,
      transport,
      usage,
    });
    const reloaded = await restarted.get(provider.id);
    expect(reloaded.readiness['configuration']?.status).toBe('ready');
    expect((await restarted.selection()).textProviderId).toBe(provider.id);
    expect(await restarted.list()).toHaveLength(1);
  });
});
