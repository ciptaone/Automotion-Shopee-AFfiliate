/**
 * PART 7 — End-to-end content generation with CONFIGURED providers.
 *
 * Proves the single, real path (no parallel pipeline):
 *
 *   catalog import → slot reservation → GenerationRouter → SELECTED provider
 *   adapter → HttpTransport → editorial validation → asset persistence →
 *   preview, and in the failure direction:
 *
 *   selected provider WITHOUT a credential → generation stops with an EXPLICIT
 *   reason on the preview/slots API, no fabricated success, no silent fallback
 *   to the environment mock, state preserved for a safe retry.
 *
 * Offline by construction (unit mock at the fetch/DNS boundary, labelled as
 * such): DNS goes through an injected lookup and every HTTP call goes through
 * an injected fetch stub imitating OpenAI-compatible endpoints. No request ever
 * leaves the process and nothing is published.
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
const SECRET_TEXT = 'sk-live-E2E-TEXT-SECRET-1234567890';
const SECRET_IMAGE = 'sk-live-E2E-IMAGE-SECRET-1234567890';

const BASE_ENV = loadEnv({
  AUTH_JWT_SECRET: 'test-secret-that-is-definitely-long-enough-123456',
  AUTH_JWT_ISSUER: 'test-issuer',
  AUTH_JWT_AUDIENCE: 'test-audience',
  CORS_ORIGINS: 'http://localhost:8080',
  NODE_ENV: 'test',
  SECRETS_ENCRYPTION_KEY: TEST_KEY_HEX,
});

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const HEADERS = [
  'Item ID',
  'Name',
  'Product URL',
  'Affiliate Link',
  'Image URL',
  'Category',
  'Price',
  'Commission Rate',
  'Rating',
  'Sold',
];

const AFFILIATE_URL = 'https://s.shopee.co.id/aff-e2e-1';
const REFERENCE_IMAGE_URL = 'https://cf.shopee.co.id/img/e2e-1.jpg';

function csvBody(): string {
  const row = [
    '1',
    'E2E Product 1',
    'https://shopee.co.id/product/1',
    AFFILIATE_URL,
    REFERENCE_IMAGE_URL,
    'Home & Living',
    '100000',
    '10',
    '4.8',
    '500',
  ];
  const text = [HEADERS, row].map((r) => r.join(',')).join('\n');
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * A caption that satisfies EVERY editorial + structural rule (CTA, verbatim
 * URL, prose disclosure, no first-person claim, no fabricated
 * price/discount/commission, mandatory `#ai #automation` ending). Modelled on
 * the built-in generator's proven shape but with NO numbers outside the URL,
 * so no fabrication guard can fire.
 */
const E2E_CAPTION = [
  'Lihat produk ini sekarang.',
  'Produknya: E2E Product 1. Cek detail dan ketersediaannya lewat link di bawah.',
  'Klik linknya, cek langsung di Shopee.',
  'Link di bawah adalah link afiliasi.',
  '#Shopee #E2EProduct',
  AFFILIATE_URL,
  '#ai #automation',
].join('\n\n');

/** Minimal PNG signature + payload (structural checks only; no vision). */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const TEXT_PROVIDER = {
  name: 'e2e-text',
  displayName: 'E2E Text',
  adapterType: 'openai_chat_completions',
  baseUrl: 'https://api.e2e.example/v1',
  model: 'e2e-text-model',
  auth: { type: 'bearer' },
};

const IMAGE_PROVIDER = {
  name: 'e2e-image',
  displayName: 'E2E Image',
  adapterType: 'openai_images',
  baseUrl: 'https://images.e2e.example/v1',
  model: 'e2e-image-model',
  auth: { type: 'bearer' },
};

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_e2e_1' },
  });
}

/** Every simulated outbound call, so the test can prove what was (not) sent. */
const outbound: string[] = [];
let imageDraw = 0;

/**
 * Unit mock of an OpenAI-compatible server: chat completions, image edits
 * (with the reference-image GET the adapter performs first) and generations.
 * Each image draw returns DIFFERENT bytes so two-image slots stay distinct.
 */
const fetchImpl: FetchLike = async (url, init) => {
  const method = init.method ?? 'GET';
  outbound.push(`${method} ${url}`);
  if (url.includes('/chat/completions')) {
    return jsonResponse({
      id: 'chatcmpl-e2e',
      choices: [{ message: { content: E2E_CAPTION } }],
    });
  }
  if (url.includes('/images/edits') || url.includes('/images/generations')) {
    imageDraw += 1;
    const bytes = Buffer.concat([PNG_BYTES, Buffer.from([imageDraw & 0xff])]);
    return jsonResponse({
      created: 1,
      data: [{ b64_json: bytes.toString('base64'), size: '1080x1920' }],
    });
  }
  if (url.includes('cf.shopee.co.id')) {
    // The product reference image the edits flow must fetch first.
    return new Response(Buffer.from(PNG_BYTES), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }
  throw new Error(`unexpected outbound request in test: ${method} ${url}`);
};

async function createApp(): Promise<{ app: FastifyInstance; container: AppContainer }> {
  outbound.length = 0;
  imageDraw = 0;
  // DNS always resolves to a public address; HTTP always hits the stub above.
  const endpointPolicy = new EndpointPolicy({ lookup: async () => ['93.184.216.34'] });
  const transport = new HttpTransport({ policy: endpointPolicy, fetchImpl });
  const container = buildContainer({
    env: BASE_ENV,
    logger: createNullLogger(),
    overrides: { endpointPolicy, transport },
  });
  const app = await buildServer(container);
  await app.ready();
  return { app, container };
}

function token(): string {
  return mintTokenFromOptions(
    {
      subject: 'apk-test',
      issuer: BASE_ENV.AUTH_JWT_ISSUER,
      audience: BASE_ENV.AUTH_JWT_AUDIENCE,
      ttlSeconds: 3600,
      scope: ['dashboard', 'read', 'control'],
    },
    BASE_ENV.AUTH_JWT_SECRET,
  );
}

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token()}` });

async function importSingleProduct(app: FastifyInstance): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/catalog/import',
    headers: auth(),
    payload: { filename: 'e2e.csv', contentBase64: csvBody() },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().catalog.total).toBe(1);
  expect(res.json().catalog.eligible).toBe(1);
}

async function createProvider(
  app: FastifyInstance,
  input: Record<string, unknown>,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/providers',
    headers: auth(),
    payload: input,
  });
  expect(res.statusCode).toBe(201);
  return res.json().provider.id as string;
}

async function storeSecret(app: FastifyInstance, id: string, secret: string): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: `/v1/providers/${id}/secret`,
    headers: auth(),
    payload: { secret },
  });
  expect(res.statusCode).toBe(200);
}

/* ========================================================================== */
/*  (A) Configured providers, credential present → real end-to-end generation */
/* ========================================================================== */

describe('end-to-end: configured text + image providers produce publish-ready content', () => {
  it('flows catalog → reservation → adapters → editorial → persistence → preview, honestly attributed', async () => {
    const { app } = await createApp();
    const bodies: string[] = [];
    try {
      await importSingleProduct(app);

      // Two images, so distinct complementary views are exercised.
      const settings = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { imageCountPolicy: 'two' },
      });
      expect(settings.statusCode).toBe(200);

      const textId = await createProvider(app, TEXT_PROVIDER);
      const imageId = await createProvider(app, IMAGE_PROVIDER);
      await storeSecret(app, textId, SECRET_TEXT);
      await storeSecret(app, imageId, SECRET_IMAGE);

      const selection = await app.inject({
        method: 'PUT',
        url: '/v1/providers/selection',
        headers: auth(),
        payload: { textProviderId: textId, imageProviderId: imageId },
      });
      expect(selection.statusCode).toBe(200);
      expect(selection.json().textProviderId).toBe(textId);
      expect(selection.json().imageProviderId).toBe(imageId);

      const run = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
      });
      bodies.push(run.body);
      expect(run.statusCode).toBe(200);
      const body = run.json();
      const preview = body.preview;

      /* --- Every required step succeeded; nothing was published ---------- */
      expect(body.stage).toBe('publish_ready');
      expect(preview.publishReady).toBe(true);
      expect(preview.lastError).toBeNull();
      expect(preview.product.affiliateUrl).toBe(AFFILIATE_URL);
      expect(preview.product.referenceAvailable).toBe(true);
      expect(preview.platforms.facebook.status).toBe('not_attempted');
      expect(preview.platforms.threads.status).toBe('not_attempted');

      /* --- Independent text/image selections actually used -------------- */
      expect(preview.providers).toEqual({
        image: { name: 'E2E Image', kind: 'live' },
        caption: { name: 'E2E Text', kind: 'live' },
      });

      /* --- Images: count persisted up-front, two distinct views --------- */
      expect(preview.imageCount).toBe(2);
      expect(preview.images).toHaveLength(2);
      const models = preview.images.map((i: { model: string }) => i.model);
      expect(models).toEqual(['e2e-image-model', 'e2e-image-model']);
      const kinds = preview.images.map((i: { providerKind: string }) => i.providerKind);
      expect(kinds).toEqual(['live', 'live']);
      const checksums = preview.images.map((i: { checksumSha256: string }) => i.checksumSha256);
      expect(new Set(checksums).size).toBe(2);
      // The real product reference was handed to the provider (edits flow).
      expect(outbound.some((o) => o.startsWith('GET ') && o.includes('cf.shopee.co.id'))).toBe(true);
      expect(outbound.some((o) => o.includes('/images/edits'))).toBe(true);
      // ...and only to the configured image provider host.
      expect(outbound.every((o) => o.includes('e2e.example') || o.includes('cf.shopee.co.id'))).toBe(true);

      /* --- Caption: actual provider/model + editorial rules enforced ----- */
      expect(preview.caption.platforms.length).toBeGreaterThan(0);
      for (const platform of preview.caption.platforms) {
        expect(platform.provider).toBe('E2E Text');
        expect(platform.providerKind).toBe('live');
        expect(platform.model).toBe('e2e-text-model');
        expect(platform.validationPassed).toBe(true);
        expect(platform.blocking).toEqual([]);
        expect(platform.fullText.includes(AFFILIATE_URL)).toBe(true);
        expect(platform.fullText.trimEnd().endsWith('#ai #automation')).toBe(true);
      }
      expect(preview.caption.mandatoryEndingPresent).toBe(true);
      expect(preview.editorial.passed).toBe(true);
      expect(preview.editorial.disclosurePresent).toBe(true);
      expect(preview.editorial.blocking).toEqual([]);
      expect(preview.imageQuality.automatedFidelityScore).toBeNull();

      /* --- Usage ledger: honest attribution, never an invented cost ------ */
      const usageRes = await app.inject({
        method: 'GET',
        url: '/v1/usage/summary',
        headers: auth(),
      });
      bodies.push(usageRes.body);
      expect(usageRes.statusCode).toBe(200);
      const usage = usageRes.json();
      // 2 image generations + 1 caption generation.
      expect(usage.day.requests).toBe(3);
      expect(usage.recent).toHaveLength(3);
      const textRow = usage.recent.find((r: { operation: string }) => r.operation === 'text_generation');
      expect(textRow).toMatchObject({
        providerName: 'E2E Text',
        adapterType: 'openai_chat_completions',
        model: 'e2e-text-model',
        status: 'success',
        costKind: 'unknown',
      });
      const imageRows = usage.recent.filter(
        (r: { operation: string }) => r.operation === 'image_generation',
      );
      expect(imageRows).toHaveLength(2);
      for (const row of imageRows) {
        expect(row).toMatchObject({
          providerName: 'E2E Image',
          adapterType: 'openai_images',
          model: 'e2e-image-model',
          status: 'success',
          costKind: 'unknown',
        });
      }

      /* --- Re-running is idempotent: terminal, no regeneration ----------- */
      const rerun = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: body.slotKey },
      });
      bodies.push(rerun.body);
      expect(rerun.statusCode).toBe(200);
      expect(rerun.json().stage).toBe('publish_ready');
      expect(rerun.json().actions).toEqual([]);
      expect(rerun.json().preview.images).toHaveLength(2);

      // No credential ever appears in any response body.
      for (const recorded of bodies) {
        expect(recorded).not.toContain(SECRET_TEXT);
        expect(recorded).not.toContain(SECRET_IMAGE);
        expect(recorded).not.toContain('E2E-TEXT-SECRET-1234');
        expect(recorded).not.toContain('E2E-IMAGE-SECRET-1234');
      }
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  (B) Selected provider without a credential → explicit blocked reason      */
/* ========================================================================== */

describe('end-to-end: a missing credential blocks with an explicit reason (no mock, no fabrication)', () => {
  it('surfaces the reason on the preview and slots API and preserves state for a retry', async () => {
    const { app } = await createApp();
    try {
      await importSingleProduct(app);

      // Deterministic image count, persisted at reservation.
      const settings = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { imageCountPolicy: 'two' },
      });
      expect(settings.statusCode).toBe(200);

      const imageId = await createProvider(app, IMAGE_PROVIDER);
      const selection = await app.inject({
        method: 'PUT',
        url: '/v1/providers/selection',
        headers: auth(),
        // Selected — but the secret is deliberately NOT stored.
        payload: { textProviderId: null, imageProviderId: imageId },
      });
      expect(selection.statusCode).toBe(200);

      const run = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
      });
      expect(run.statusCode).toBe(200);
      const body = run.json();
      const preview = body.preview;

      /* --- Blocked, with the EXPLICIT reason (PART 7 fix) ---------------- */
      expect(body.stage).toBe('failed');
      expect(preview.stage).toBe('failed');
      expect(preview.publishReady).toBe(false);
      expect(preview.lastError).toBeTypeOf('string');
      expect(preview.lastError).toMatch(/credential/i);
      expect(preview.lastError).toContain(IMAGE_PROVIDER.displayName);

      /* --- Nothing was fabricated and no mock substituted ---------------- */
      expect(preview.images).toEqual([]);
      expect(preview.caption.fullText).toBe('');
      // If the env mock had silently produced content, providers would name it.
      expect(preview.providers).toEqual({ image: null, caption: null });
      // Fail-closed BEFORE any HTTP: not one request left the process.
      expect(outbound).toEqual([]);

      /* --- The same reason is on the slots list API ---------------------- */
      const slots = await app.inject({
        method: 'GET',
        url: '/v1/pipeline/slots',
        headers: auth(),
      });
      expect(slots.statusCode).toBe(200);
      const listed = slots.json().slots[0];
      expect(listed.stage).toBe('failed');
      expect(listed.lastError).toMatch(/credential/i);
      expect(listed.blockers).toEqual([]);

      /* --- State preserved; a later retry resumes the same reservation --- */
      const retry = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: body.slotKey },
      });
      expect(retry.statusCode).toBe(200);
      const retryBody = retry.json();
      expect(retryBody.stage).toBe('failed');
      expect(retryBody.preview.lastError).toMatch(/credential/i);
      expect(retryBody.preview.product.sourceProductId).toBe(preview.product.sourceProductId);
      expect(retryBody.preview.attempts).toBeGreaterThan(preview.attempts);

      /* --- No request was ever billed or recorded ------------------------ */
      const usage = await app.inject({
        method: 'GET',
        url: '/v1/usage/summary',
        headers: auth(),
      });
      expect(usage.json().day.requests).toBe(0);

      // Adding the credential makes the SAME slot succeed — proof the failure
      // was configuration, not content, and that retry-after-fix works.
      await storeSecret(app, imageId, SECRET_IMAGE);
      // Text provider is still unselected, so the caption step would use the
      // environment default; configure one too so the whole run is live.
      const textId = await createProvider(app, TEXT_PROVIDER);
      await storeSecret(app, textId, SECRET_TEXT);
      await app.inject({
        method: 'PUT',
        url: '/v1/providers/selection',
        headers: auth(),
        payload: { textProviderId: textId, imageProviderId: imageId },
      });

      const fixed = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: body.slotKey },
      });
      expect(fixed.statusCode).toBe(200);
      expect(fixed.json().stage).toBe('publish_ready');
      expect(fixed.json().preview.lastError).toBeNull();
      // The image count decided at reservation survived the failed attempts.
      expect(fixed.json().preview.imageCount).toBe(2);
      expect(fixed.json().preview.images).toHaveLength(2);
      expect(fixed.json().preview.providers.image).toEqual({
        name: 'E2E Image',
        kind: 'live',
      });
      expect(outbound.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
