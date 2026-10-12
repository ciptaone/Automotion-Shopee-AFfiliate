/**
 * PART 3 — HTTP contract for catalog, categories, pipeline and the upgraded
 * content preview.
 *
 * Covers: feed import (valid + malformed + unrecognized), catalog listing and
 * filtering, category listing from the actual catalog, import status, pipeline
 * run/status, the real-vs-fixture preview split, selection-mode settings
 * (including unknown-category rejection), and the honest "no publication"
 * guarantee.
 *
 * Credential-free by construction: in-memory stores, deterministic mocks, and
 * Fastify `inject` — no request ever leaves the process.
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/app/server.js';
import { buildContainer, type AppContainer } from '../../src/app/container.js';
import { loadEnv } from '../../src/core/env.js';
import { createNullLogger } from '../../src/core/logger.js';
import { mintTokenFromOptions } from '../../src/core/auth.js';

const BASE_ENV = loadEnv({
  AUTH_JWT_SECRET: 'test-secret-that-is-definitely-long-enough-123456',
  AUTH_JWT_ISSUER: 'test-issuer',
  AUTH_JWT_AUDIENCE: 'test-audience',
  CORS_ORIGINS: 'http://localhost:8080',
  NODE_ENV: 'test',
});

async function createApp(): Promise<{ app: FastifyInstance; container: AppContainer }> {
  const container = buildContainer({ env: BASE_ENV, logger: createNullLogger() });
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

/* -------------------------------------------------------------------------- */
/*  Synthetic feed fixtures                                                   */
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

function row(id: string, category: string, imageUrl = `https://cf.shopee.co.id/img/${id}.jpg`): string[] {
  return [
    id,
    `Synthetic Product ${id}`,
    `https://shopee.co.id/product/${id}`,
    `https://s.shopee.co.id/aff-${id}`,
    imageUrl,
    category,
    '100000',
    '10',
    '4.8',
    '500',
  ];
}

function csvBody(rows: string[][]): string {
  const text = [HEADERS, ...rows].map((r) => r.join(',')).join('\n');
  return Buffer.from(text, 'utf8').toString('base64');
}

async function importFeed(app: FastifyInstance, rows: string[][]) {
  return app.inject({
    method: 'POST',
    url: '/v1/catalog/import',
    headers: auth(),
    payload: { filename: 'feed.csv', contentBase64: csvBody(rows) },
  });
}

/* ========================================================================== */
/*  Catalog import                                                            */
/* ========================================================================== */

describe('POST /v1/catalog/import', () => {
  it('requires authentication', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/catalog/import', payload: {} });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    } finally {
      await app.close();
    }
  });

  it('requires the control scope', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/catalog/import',
        headers: auth(['read']),
        payload: { filename: 'feed.csv', contentBase64: csvBody([row('1', 'Health & Beauty')]) },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    } finally {
      await app.close();
    }
  });

  it('imports a valid feed and reports batch + catalog totals', async () => {
    const { app, container } = await createApp();
    try {
      const res = await importFeed(app, [
        row('1', 'Health & Beauty'),
        row('2', 'Home & Living'),
      ]);
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.batch.newProducts).toBe(2);
      expect(body.batch.rejected).toBe(0);
      expect(body.batch.source).toBe('feed_import');
      expect(body.catalog).toEqual({
        total: 2,
        eligible: 2,
        categories: 2,
        storage: 'memory',
      });
      expect(container.catalog.total()).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed requests with a safe error', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/catalog/import',
        headers: auth(),
        payload: { filename: '', contentBase64: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_REQUEST');
    } finally {
      await app.close();
    }
  });

  it('rejects unknown extra body keys (strict schema)', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/catalog/import',
        headers: auth(),
        payload: {
          filename: 'feed.csv',
          contentBase64: csvBody([row('1', 'Health & Beauty')]),
          sneaky: 'value',
        },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('fails the import but PRESERVES the existing catalog when the file is garbage', async () => {
    const { app, container } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty'), row('2', 'Home & Living')]);
      expect(container.catalog.total()).toBe(2);

      const garbage = Buffer.from('x,y\n1,2\n', 'utf8').toString('base64');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/catalog/import',
        headers: auth(),
        payload: { filename: 'garbage.csv', contentBase64: garbage },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('FEED_NO_RECOGNIZED_COLUMNS');

      // The previously valid catalog is untouched.
      expect(container.catalog.total()).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('is idempotent: re-importing the same feed does not duplicate', async () => {
    const { app, container } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty'), row('2', 'Home & Living')]);
      const second = await importFeed(app, [row('1', 'Health & Beauty'), row('2', 'Home & Living')]);

      expect(second.statusCode).toBe(200);
      expect(second.json().batch.newProducts).toBe(0);
      expect(second.json().batch.updatedProducts).toBe(2);
      expect(container.catalog.total()).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('never exposes credentials in the response', async () => {
    const { app } = await createApp();
    try {
      const res = await importFeed(app, [row('1', 'Health & Beauty')]);
      const raw = res.body.toLowerCase();
      expect(raw).not.toContain('secret');
      expect(raw).not.toContain('password');
      expect(raw).not.toContain('api_key');
      expect(raw).not.toContain('token');
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Catalog listing / categories / status                                     */
/* ========================================================================== */

describe('GET /v1/catalog', () => {
  it('requires authentication', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/catalog' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('lists imported products with totals', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty'), row('2', 'Home & Living')]);
      const res = await app.inject({ method: 'GET', url: '/v1/catalog', headers: auth() });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(2);
      expect(body.total).toBe(2);
      expect(body.eligibleTotal).toBe(2);
      expect(body.storage).toBe('memory');
      expect(body.items[0]).toHaveProperty('sourceProductId');
      expect(body.items[0]).toHaveProperty('affiliateUrl');
      expect(body.items[0]).toHaveProperty('categoryId');
    } finally {
      await app.close();
    }
  });

  it('filters by category and eligibility', async () => {
    const { app } = await createApp();
    try {
      // Second product has no affiliate link -> ineligible.
      const noLink = row('3', 'Health & Beauty').map((v, i) => (i === 3 ? '' : v));
      await importFeed(app, [row('1', 'Health & Beauty'), row('2', 'Home & Living'), noLink]);

      const byCategory = await app.inject({
        method: 'GET',
        url: '/v1/catalog?category=home-living',
        headers: auth(),
      });
      expect(byCategory.json().count).toBe(1);

      const eligibleOnly = await app.inject({
        method: 'GET',
        url: '/v1/catalog?eligible=true',
        headers: auth(),
      });
      expect(eligibleOnly.json().count).toBe(2);
      expect(eligibleOnly.json().eligibleTotal).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('returns an empty list for an empty catalog', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/catalog', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ items: [], count: 0, total: 0 });
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/catalog/categories', () => {
  it('returns categories derived from the ACTUAL catalog', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [
        row('1', 'Health & Beauty'),
        row('2', 'Home & Living'),
        row('3', 'Home & Living'),
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/catalog/categories',
        headers: auth(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(2);
      const ids = body.categories.map((c: { id: string }) => c.id).sort();
      expect(ids).toEqual(['health-beauty', 'home-living']);
      const home = body.categories.find((c: { id: string }) => c.id === 'home-living');
      expect(home.productCount).toBe(2);
      expect(home.eligibleProductCount).toBe(2);
      expect(body.note).toMatch(/actual imported catalog/i);
    } finally {
      await app.close();
    }
  });

  it('returns an empty list (not a hardcoded list) for an empty catalog', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/catalog/categories',
        headers: auth(),
      });
      expect(res.json()).toMatchObject({ categories: [], count: 0 });
    } finally {
      await app.close();
    }
  });

  it('requires authentication', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/catalog/categories' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/catalog/status', () => {
  it('reports totals and recent imports', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty')]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/catalog/status',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ total: 1, eligible: 1, categories: 1, storage: 'memory' });
      expect(body.recentImports).toHaveLength(1);
      expect(body.recentImports[0]).toHaveProperty('filename', 'feed.csv');
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Selection-mode settings                                                   */
/* ========================================================================== */

describe('settings — selection mode', () => {
  it('exposes the new selection defaults and constraints', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.settings.selectionMode).toBe('auto');
      expect(body.settings.selectedCategoryIds).toEqual([]);
      expect(body.constraints.selectionModes).toEqual(['auto', 'selected_categories']);
    } finally {
      await app.close();
    }
  });

  it('persists a valid selection-mode change', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty'), row('2', 'Home & Living')]);
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: {
          selectionMode: 'selected_categories',
          selectedCategoryIds: ['home-living'],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().settings.selectionMode).toBe('selected_categories');
      expect(res.json().settings.selectedCategoryIds).toEqual(['home-living']);

      // It survives a reload (backend is the source of truth).
      const reread = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth() });
      expect(reread.json().settings.selectedCategoryIds).toEqual(['home-living']);
    } finally {
      await app.close();
    }
  });

  it('rejects unknown category ids', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty')]);
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: {
          selectionMode: 'selected_categories',
          selectedCategoryIds: ['does-not-exist'],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_SETTINGS');
      expect(res.json().error.issues[0].rule).toContain('does-not-exist');
    } finally {
      await app.close();
    }
  });

  it('rejects selected_categories with an empty category list', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { selectionMode: 'selected_categories', selectedCategoryIds: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/at least one category/i);
    } finally {
      await app.close();
    }
  });

  it('rejects an invalid selection mode value', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { selectionMode: 'chaos' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('switching back to auto clears the category restriction without a reimport', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty'), row('2', 'Home & Living')]);
      await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { selectionMode: 'selected_categories', selectedCategoryIds: ['home-living'] },
      });
      const back = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { selectionMode: 'auto', selectedCategoryIds: [] },
      });
      expect(back.statusCode).toBe(200);
      expect(back.json().settings.selectionMode).toBe('auto');
      // The catalog is untouched by a settings change.
      expect(back.json().settings.selectedCategoryIds).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('still rejects automationState in a settings patch', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { automationState: 'running' },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Pipeline                                                                  */
/* ========================================================================== */

describe('POST /v1/pipeline/run', () => {
  it('requires authentication and control scope', async () => {
    const { app } = await createApp();
    try {
      const anon = await app.inject({ method: 'POST', url: '/v1/pipeline/run', payload: {} });
      expect(anon.statusCode).toBe(401);
      const readOnly = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(['read']),
        payload: {},
      });
      expect(readOnly.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('blocks with an explicit reason when the catalog is empty', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#01' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.stage).toBe('blocked');
      expect(body.preview.blockers[0].code).toBe('empty_catalog');
      expect(body.preview.publishReady).toBe(false);
      expect(body.note).toMatch(/nothing is published/i);
    } finally {
      await app.close();
    }
  });

  it('generates content for a slot once a feed is imported', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty'), row('2', 'Home & Living')]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#01' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.slotKey).toBe('2026-10-12#01');
      expect(body.stage).toBe('publish_ready');
      expect(body.actions).toContain('reserve');
      expect(body.preview.source).toBe('pipeline');
      expect(body.preview.publishReady).toBe(true);
      expect(body.preview.images.length).toBe(body.preview.imageCount);
      expect(body.preview.product.source).toBe('catalog');
      // Honest provider labeling: mocks are labeled as mocks.
      expect(body.preview.providers.image.kind).toBe('mock');
      expect(body.preview.providers.caption.kind).toBe('mock');
      // Nothing was published.
      expect(body.preview.platforms.facebook.status).toBe('not_attempted');
      expect(body.preview.platforms.threads.status).toBe('not_attempted');
    } finally {
      await app.close();
    }
  });

  it('is idempotent for the same slot (no duplicate assets)', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty')]);
      const first = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#02' },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#02' },
      });
      expect(second.json().actions).toHaveLength(0);
      expect(second.json().preview.images.map((i: { publicUrl: string }) => i.publicUrl)).toEqual(
        first.json().preview.images.map((i: { publicUrl: string }) => i.publicUrl),
      );
    } finally {
      await app.close();
    }
  });

  it('supports explicit regeneration', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty')]);
      const first = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#03' },
      });
      const regen = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#03', regenerate: true },
      });
      expect(regen.json().actions).toContain('regenerate_requested');
      expect(regen.json().preview.generationRunId).not.toBe(
        first.json().preview.generationRunId,
      );
    } finally {
      await app.close();
    }
  });

  it('rejects unknown body keys', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: 'x', publishNow: true },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/pipeline/slots', () => {
  it('lists slot records with stage and image count', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty')]);
      await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#05' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/pipeline/slots',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(1);
      const slot = body.slots[0];
      expect(slot.slotKey).toBe('2026-10-12#05');
      expect(slot.stage).toBe('publish_ready');
      expect(slot.publishReady).toBe(true);
      expect([1, 2]).toContain(slot.imageCount);
      expect(slot.validationPassed).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('requires authentication', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/pipeline/slots' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Content preview: real pipeline vs fixture fallback                        */
/* ========================================================================== */

describe('GET /v1/content/preview', () => {
  it('serves the PART 2 fixture when the slot has no pipeline record', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/content/preview?slot=2026-10-12%2399',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Backward-compatible PART 2 shape.
      expect(body.source).toBe('fixture');
      expect(body).toHaveProperty('imageCount');
      expect(body).toHaveProperty('product');
      expect(body).toHaveProperty('caption');
      expect(body).toHaveProperty('validation');
      expect(body).toHaveProperty('platforms');
    } finally {
      await app.close();
    }
  });

  it('serves the REAL pipeline record once the slot has one', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty')]);
      await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#06' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/content/preview?slot=2026-10-12%2306',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.source).toBe('pipeline');
      expect(body.stage).toBe('publish_ready');
      expect(body.imageCountSource).toBe('pipeline_persisted');
      expect(body.images.length).toBe(body.imageCount);
      expect(body.product.source).toBe('catalog');
      expect(body.caption.source).toBe('generated');
      expect(body.publishReady).toBe(true);
      // Every image is a cURL-able URL, never a local path.
      for (const image of body.images) {
        expect(image.publicUrl).toMatch(/^https?:\/\//);
        expect(image.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      await app.close();
    }
  });

  it('keeps the fixture fallback available for an explicit slot with no record', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty')]);
      await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#07' },
      });

      const other = await app.inject({
        method: 'GET',
        url: '/v1/content/preview?slot=2026-10-12%2308',
        headers: auth(),
      });
      expect(other.json().source).toBe('fixture');
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Cross-cutting honesty guarantees                                          */
/* ========================================================================== */

describe('PART 3 honesty guarantees', () => {
  it('no endpoint ever reports a live publication', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty')]);
      const run = await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#09' },
      });
      expect(run.json().preview.platforms.facebook.url).toBeNull();
      expect(run.json().preview.platforms.threads.url).toBeNull();
      expect(run.json().preview.platforms.facebook.status).toBe('not_attempted');
    } finally {
      await app.close();
    }
  });

  it('never leaks storage or provider credentials in catalog/pipeline responses', async () => {
    const { app } = await createApp();
    try {
      await importFeed(app, [row('1', 'Health & Beauty')]);
      await app.inject({
        method: 'POST',
        url: '/v1/pipeline/run',
        headers: auth(),
        payload: { slot: '2026-10-12#10' },
      });

      for (const url of ['/v1/catalog', '/v1/catalog/status', '/v1/pipeline/slots']) {
        const res = await app.inject({ method: 'GET', url, headers: auth() });
        const raw = res.body.toLowerCase();
        expect(raw).not.toContain('secret');
        expect(raw).not.toContain('access_key');
        expect(raw).not.toContain('password');
        expect(raw).not.toContain('authorization');
      }
    } finally {
      await app.close();
    }
  });

  it('the health surface reports the empty catalog as degraded, not unready', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('ok');
      expect(body.degradedReasons.some((r: string) => /catalog is empty/i.test(r))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
