/**
 * PART 6 §2/§3/§6 — HTTP contract for the provider workspace and usage ledger.
 *
 * Covers: authentication + scope requirements, provider CRUD with endpoint
 * validation, write-only credential endpoints (the value is NEVER in any
 * response body), independent text/image selection, provider deletion
 * protection, bounded test routes with sanitized results, and the usage/budget
 * summary.
 *
 * Credential-free by construction: DNS is a labelled mock resolver and the
 * transport is a stubbed HttpTransport — no request ever leaves the process,
 * and nothing is ever published.
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/app/server.js';
import { buildContainer, type AppContainer } from '../../src/app/container.js';
import { loadEnv } from '../../src/core/env.js';
import { createNullLogger } from '../../src/core/logger.js';
import { mintTokenFromOptions } from '../../src/core/auth.js';
import { EndpointPolicy } from '../../src/providers/endpoint-policy.js';
import { HttpTransport, type FetchLike } from '../../src/providers/transport.js';

/** A deterministic 32-byte key (hex) for AES-256-GCM — a TEST key only. */
const TEST_KEY_HEX = 'ab'.repeat(32);

const BASE_ENV = loadEnv({
  AUTH_JWT_SECRET: 'test-secret-that-is-definitely-long-enough-123456',
  AUTH_JWT_ISSUER: 'test-issuer',
  AUTH_JWT_AUDIENCE: 'test-audience',
  CORS_ORIGINS: 'http://localhost:8080',
  NODE_ENV: 'test',
  SECRETS_ENCRYPTION_KEY: TEST_KEY_HEX,
});

const SECRET_VALUE = 'sk-live-CONTRACT-SECRET-1234567890';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_contract_1' },
  });
}

async function createApp(options: { fetchImpl?: FetchLike } = {}): Promise<{
  app: FastifyInstance;
  container: AppContainer;
}> {
  // DNS always resolves to a public address; HTTP always hits the stub.
  const endpointPolicy = new EndpointPolicy({ lookup: async () => ['93.184.216.34'] });
  const transport = new HttpTransport({
    policy: endpointPolicy,
    fetchImpl: options.fetchImpl ?? (async () => jsonResponse({ ok: true })),
  });
  const container = buildContainer({
    env: BASE_ENV,
    logger: createNullLogger(),
    overrides: { endpointPolicy, transport },
  });
  const app = await buildServer(container);
  await app.ready();
  return { app, container };
}

function token(scope: string[] = ['dashboard', 'read', 'control']): string {
  return mintTokenFromOptions(
    {
      subject: 'apk-test',
      issuer: BASE_ENV.AUTH_JWT_ISSUER,
      audience: BASE_ENV.AUTH_JWT_AUDIENCE,
      ttlSeconds: 3600,
      scope,
    },
    BASE_ENV.AUTH_JWT_SECRET,
  );
}

const auth = (scope?: string[]): Record<string, string> => ({
  authorization: `Bearer ${token(scope)}`,
});

const TEXT_INPUT = {
  name: 'contract-text',
  displayName: 'Contract Text',
  adapterType: 'openai_chat_completions',
  baseUrl: 'https://api.contract.example/v1',
  model: 'contract-text-model',
  auth: { type: 'bearer' },
};

const IMAGE_INPUT = {
  name: 'contract-image',
  displayName: 'Contract Image',
  adapterType: 'openai_images',
  baseUrl: 'https://images.contract.example/v1',
  model: 'contract-image-model',
  auth: { type: 'bearer' },
};

/** Every response body ever seen, so we can assert no credential leaks. */
const seenBodies: string[] = [];
function record(body: string): string {
  seenBodies.push(body);
  return body;
}

function assertNoCredentialLeak(): void {
  for (const body of seenBodies) {
    expect(body).not.toContain(SECRET_VALUE);
    // Even the middle of the key must never appear.
    expect(body).not.toContain('CONTRACT-SECRET-1234');
  }
}

/* ========================================================================== */
/*  Auth + scopes                                                             */
/* ========================================================================== */

describe('provider API — authentication and scopes', () => {
  it('every provider endpoint requires authentication', async () => {
    const { app } = await createApp();
    try {
      const calls = [
        { method: 'GET' as const, url: '/v1/providers' },
        { method: 'POST' as const, url: '/v1/providers' },
        { method: 'GET' as const, url: '/v1/providers/selection' },
        { method: 'PUT' as const, url: '/v1/providers/selection' },
        { method: 'PUT' as const, url: '/v1/providers/x' },
        { method: 'DELETE' as const, url: '/v1/providers/x' },
        { method: 'PUT' as const, url: '/v1/providers/x/secret' },
        { method: 'DELETE' as const, url: '/v1/providers/x/secret' },
        { method: 'POST' as const, url: '/v1/providers/x/test/connection' },
        { method: 'POST' as const, url: '/v1/providers/x/test/text' },
        { method: 'POST' as const, url: '/v1/providers/x/test/image' },
        { method: 'GET' as const, url: '/v1/usage/summary' },
      ];
      for (const call of calls) {
        const res = await app.inject(call);
        expect(res.statusCode, `${call.method} ${call.url}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('reads need the read scope; mutations need control', async () => {
    const { app } = await createApp();
    try {
      // read-only token cannot mutate.
      const denied = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(['read']),
        payload: TEXT_INPUT,
      });
      expect(denied.statusCode).toBe(403);

      // control-only token cannot read.
      const listDenied = await app.inject({
        method: 'GET',
        url: '/v1/providers',
        headers: auth(['control']),
      });
      expect(listDenied.statusCode).toBe(403);

      // control can mutate.
      const allowed = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(['control']),
        payload: TEXT_INPUT,
      });
      expect(allowed.statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  CRUD + endpoint policy                                                    */
/* ========================================================================== */

describe('provider API — configuration lifecycle', () => {
  it('creates, lists, updates and deletes a provider', async () => {
    const { app } = await createApp();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT,
      });
      expect(created.statusCode).toBe(201);
      record(created.body);
      const provider = created.json().provider;
      expect(provider.id).toBeTruthy();
      expect(provider.name).toBe('contract-text');
      expect(provider.baseUrl).toBe('https://api.contract.example/v1');
      expect(provider.model).toBe('contract-text-model');
      // Honest initial readiness: configuration validated, capabilities NOT
      // ready until a real test produced them.
      expect(provider.readiness.configuration.status).toBe('ready');
      expect(provider.readiness.text_generation?.status).toBe('not_configured');
      // A text adapter declares no image capability: honest, explicit state.
      expect(provider.readiness.image_generation?.status).toBe('capability_unsupported');

      const listed = await app.inject({ method: 'GET', url: '/v1/providers', headers: auth() });
      expect(listed.statusCode).toBe(200);
      record(listed.body);
      const list = listed.json();
      expect(list.providers).toHaveLength(1);
      expect(list.selection.fallback).toBe('none');
      expect(list.capabilities).toContain('text_generation');
      expect(list.statuses).toContain('capability_unsupported');

      // Updates re-validate the FULL payload (no partial-patch surprises).
      const updated = await app.inject({
        method: 'PUT',
        url: `/v1/providers/${provider.id}`,
        headers: auth(),
        payload: { ...TEXT_INPUT, model: 'contract-text-v2' },
      });
      expect(updated.statusCode).toBe(200);
      record(updated.body);
      expect(updated.json().provider.model).toBe('contract-text-v2');

      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/providers/${provider.id}`,
        headers: auth(),
      });
      expect(removed.statusCode).toBe(200);
      record(removed.body);

      const after = await app.inject({ method: 'GET', url: '/v1/providers', headers: auth() });
      expect(after.json().providers).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid endpoint, a duplicate name and an unknown id', async () => {
    const { app } = await createApp();
    try {
      // Metadata endpoint (SSRF) — refused before it is stored.
      const ssrf = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: { ...TEXT_INPUT, name: 'bad', baseUrl: 'http://169.254.169.254/latest' },
      });
      expect(ssrf.statusCode).toBe(400);
      record(ssrf.body);

      const first = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT,
      });
      expect(first.statusCode).toBe(201);

      const duplicate = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT,
      });
      expect(duplicate.statusCode).toBe(400);
      record(duplicate.body);

      // Unknown id: the payload must still validate (full re-parse), then the
      // provider lookup fails with a clean 404.
      const missing = await app.inject({
        method: 'PUT',
        url: '/v1/providers/no-such-id',
        headers: auth(),
        payload: { ...TEXT_INPUT, model: 'contract-text-v3' },
      });
      expect(missing.statusCode).toBe(404);
      record(missing.body);

      // A malformed patch is rejected as a validation error, not a 404.
      const malformed = await app.inject({
        method: 'PUT',
        url: '/v1/providers/no-such-id',
        headers: auth(),
        payload: { model: 'x' },
      });
      expect(malformed.statusCode).toBe(400);
      record(malformed.body);
    } finally {
      await app.close();
    }
  });

  it('rejects a credential-bearing header config that would ship the key', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: {
          ...TEXT_INPUT,
          name: 'leaky',
          auth: { type: 'none' },
          extraHeaders: { Authorization: `Bearer ${SECRET_VALUE}` },
        },
      });
      expect(res.statusCode).toBe(400);
      record(res.body);
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Credentials — write-only, masked, never returned                          */
/* ========================================================================== */

describe('provider API — credential endpoints never echo the secret', () => {
  it('stores a secret and returns only masked metadata', async () => {
    const { app } = await createApp();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT,
      });
      const id = created.json().provider.id as string;

      const stored = await app.inject({
        method: 'PUT',
        url: `/v1/providers/${id}/secret`,
        headers: auth(),
        payload: { secret: SECRET_VALUE },
      });
      expect(stored.statusCode).toBe(200);
      record(stored.body);
      const meta = stored.json().secret;
      expect(meta.present).toBe(true);
      expect(meta.keyConfigured).toBe(true);
      expect(meta.masked).toBeTruthy();
      expect(meta.masked).not.toContain(SECRET_VALUE);

      // The list view also only exposes masked metadata.
      const listed = await app.inject({ method: 'GET', url: '/v1/providers', headers: auth() });
      record(listed.body);
      expect(listed.body).not.toContain(SECRET_VALUE);

      // Replacing the secret works and still never echoes it.
      const replaced = await app.inject({
        method: 'PUT',
        url: `/v1/providers/${id}/secret`,
        headers: auth(),
        payload: { secret: `${SECRET_VALUE}-replaced` },
      });
      expect(replaced.statusCode).toBe(200);
      record(replaced.body);

      // Deleting it clears presence.
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/providers/${id}/secret`,
        headers: auth(),
      });
      expect(deleted.statusCode).toBe(200);
      record(deleted.body);
      expect(deleted.json().secret.present).toBe(false);

      assertNoCredentialLeak();
    } finally {
      await app.close();
    }
  });

  it('rejects an empty secret and a secret for an unknown provider', async () => {
    const { app } = await createApp();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT,
      });
      const id = created.json().provider.id as string;

      const empty = await app.inject({
        method: 'PUT',
        url: `/v1/providers/${id}/secret`,
        headers: auth(),
        payload: { secret: '' },
      });
      expect(empty.statusCode).toBe(400);
      record(empty.body);

      const unknown = await app.inject({
        method: 'PUT',
        url: '/v1/providers/no-such-id/secret',
        headers: auth(),
        payload: { secret: SECRET_VALUE },
      });
      expect(unknown.statusCode).toBe(404);
      record(unknown.body);

      assertNoCredentialLeak();
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Selection — independent, no fallback                                      */
/* ========================================================================== */

describe('provider API — independent text/image selection', () => {
  it('selects text and image providers independently and protects them', async () => {
    const { app } = await createApp();
    try {
      const text = (
        await app.inject({
          method: 'POST',
          url: '/v1/providers',
          headers: auth(),
          payload: TEXT_INPUT,
        })
      ).json().provider;
      const image = (
        await app.inject({
          method: 'POST',
          url: '/v1/providers',
          headers: auth(),
          payload: IMAGE_INPUT,
        })
      ).json().provider;

      const selected = await app.inject({
        method: 'PUT',
        url: '/v1/providers/selection',
        headers: auth(),
        payload: { textProviderId: text.id, imageProviderId: image.id },
      });
      expect(selected.statusCode).toBe(200);
      record(selected.body);
      const selection = selected.json();
      expect(selection.textProviderId).toBe(text.id);
      expect(selection.imageProviderId).toBe(image.id);
      expect(selection.fallback).toBe('none');
      expect(selection.note).toMatch(/never switches provider/i);

      // A selected provider cannot be deleted until it is deselected.
      const blocked = await app.inject({
        method: 'DELETE',
        url: `/v1/providers/${text.id}`,
        headers: auth(),
      });
      expect(blocked.statusCode).toBe(409);
      record(blocked.body);

      // An image provider cannot be selected as the TEXT provider.
      const wrongTask = await app.inject({
        method: 'PUT',
        url: '/v1/providers/selection',
        headers: auth(),
        payload: { textProviderId: image.id, imageProviderId: image.id },
      });
      expect(wrongTask.statusCode).toBe(503); // configuration: capability unsupported
      record(wrongTask.body);

      // Deselect (env default), then deletion is allowed.
      await app.inject({
        method: 'PUT',
        url: '/v1/providers/selection',
        headers: auth(),
        payload: { textProviderId: null, imageProviderId: null },
      });
      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/providers/${text.id}`,
        headers: auth(),
      });
      expect(removed.statusCode).toBe(200);

      assertNoCredentialLeak();
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Test routes — bounded, sanitized, never publishing                        */
/* ========================================================================== */

describe('provider API — bounded test routes', () => {
  it('a successful connection test is honest and never claims publication', async () => {
    const { app } = await createApp({
      fetchImpl: async () => jsonResponse({ ok: true }),
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT,
      });
      const id = created.json().provider.id as string;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/providers/${id}/test/connection`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      record(res.body);
      const result = res.json();
      expect(result.ok).toBe(true);
      expect(result.status).toBe('ready');
      expect(result.kind).toBe('connection');
      expect(result.note).toMatch(/nothing was published/i);
      expect(result.readiness.configuration.status).toBe('ready');
      expect(result.requestId).toBe('req_contract_1');
    } finally {
      await app.close();
    }
  });

  it('a 401 from the provider becomes authentication_failed with no key leaked', async () => {
    const { app } = await createApp({
      fetchImpl: async () => jsonResponse({ error: { message: 'invalid api key' } }, 401),
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT,
      });
      const id = created.json().provider.id as string;
      await app.inject({
        method: 'PUT',
        url: `/v1/providers/${id}/secret`,
        headers: auth(),
        payload: { secret: SECRET_VALUE },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/providers/${id}/test/connection`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      record(res.body);
      const result = res.json();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('authentication_failed');
      expect(result.readiness.authentication.status).toBe('authentication_failed');
      // Sanitized: the response is bounded and contains no credential.
      expect(res.body.length).toBeLessThan(4_000);

      assertNoCredentialLeak();
    } finally {
      await app.close();
    }
  });

  it('a text test marks the capability ready and records honest usage', async () => {
    const { app } = await createApp({
      fetchImpl: async () =>
        jsonResponse({
          choices: [
            { message: { content: 'Coba cek produknya. https://s.shopee.co.id/aff-1\n\n#ai #automation' } },
          ],
        }),
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT,
      });
      const id = created.json().provider.id as string;
      await app.inject({
        method: 'PUT',
        url: `/v1/providers/${id}/secret`,
        headers: auth(),
        payload: { secret: SECRET_VALUE },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/providers/${id}/test/text`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      record(res.body);
      const result = res.json();
      expect(result.ok).toBe(true);
      expect(result.status).toBe('ready');
      expect(result.readiness.text_generation.status).toBe('ready');
      expect(result.readiness.authentication.status).toBe('ready');
      expect(result.text.endsWithMandatory).toBe(true);
      expect(result.note).toMatch(/fixture data/i);
      expect(result.note).toMatch(/nothing was uploaded, stored or published/i);

      // The test is recorded in the usage ledger with an UNKNOWN cost (honest:
      // the provider reported none).
      const usage = await app.inject({ method: 'GET', url: '/v1/usage/summary', headers: auth() });
      expect(usage.statusCode).toBe(200);
      record(usage.body);
      const summary = usage.json();
      expect(summary.day.requests).toBe(1);
      expect(summary.recent[0].operation).toBe('test_text');
      expect(summary.recent[0].costKind).toBe('unknown');
      expect(summary.note).toMatch(/unknown cost/i);

      assertNoCredentialLeak();
    } finally {
      await app.close();
    }
  });

  it('an image test on a text-only provider reports capability_unsupported', async () => {
    const { app } = await createApp();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT, // openai_chat_completions: no image capability
      });
      const id = created.json().provider.id as string;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/providers/${id}/test/image`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      record(res.body);
      const result = res.json();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('capability_unsupported');
      expect(result.readiness.image_generation.status).toBe('capability_unsupported');
    } finally {
      await app.close();
    }
  });

  it('a timeout becomes temporarily_unavailable (never a silent mock)', async () => {
    const { app } = await createApp({
      fetchImpl: async () => {
        const abort = new Error('The operation was aborted.');
        abort.name = 'AbortError';
        throw abort;
      },
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: auth(),
        payload: TEXT_INPUT,
      });
      const id = created.json().provider.id as string;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/providers/${id}/test/connection`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      record(res.body);
      const result = res.json();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('temporarily_unavailable');
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Usage summary                                                             */
/* ========================================================================== */

describe('GET /v1/usage/summary', () => {
  it('reports an empty, honest ledger before any generation', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/usage/summary', headers: auth() });
      expect(res.statusCode).toBe(200);
      record(res.body);
      const body = res.json();
      expect(body.timezone).toBe('Asia/Jakarta');
      expect(body.day.requests).toBe(0);
      expect(body.month.requests).toBe(0);
      expect(body.budget.dailyBudgetUsd).toBeNull(); // no configured budget
      expect(body.budget.monthlyBudgetUsd).toBeNull();
      expect(body.budget.blocked).toBe(false);
      expect(body.budget.day.exhausted).toBe(false);
      expect(body.budget.month.exhausted).toBe(false);
      expect(body.budget.unknownCostRequests).toBe(0);
      expect(Array.isArray(body.recent)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
