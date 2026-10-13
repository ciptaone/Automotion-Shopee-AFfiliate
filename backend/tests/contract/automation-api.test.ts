/**
 * Part 2 — HTTP contract for the APK control surface.
 *
 * Covers: automation status, settings (read/validate/persist), start-pause-
 * resume, fixture content preview, fixture publishing history and the enriched
 * integration health payload.
 *
 * Credential-free by construction: the container is built with the default
 * in-memory settings store and in-memory queue, and no request ever leaves the
 * process (Fastify `inject`).
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/app/server.js';
import { buildContainer, type AppContainer } from '../../src/app/container.js';
import { loadEnv } from '../../src/core/env.js';
import { createNullLogger } from '../../src/core/logger.js';
import { mintTokenFromOptions } from '../../src/core/auth.js';
import { INTEGRATION_HEALTH_VALUES } from '../../src/app/integration-health.js';

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

/* ========================================================================== */
/*  Automation status                                                         */
/* ========================================================================== */

describe('GET /v1/automation/status', () => {
  it('requires authentication', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/automation/status' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    } finally {
      await app.close();
    }
  });

  it('reports state, slot capacity and honest content state', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/automation/status',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.state).toBe('paused'); // nothing runs until an operator starts it
      expect(typeof body.degraded).toBe('boolean');
      expect(Array.isArray(body.degradedReasons)).toBe(true);
      expect(body.timezone).toBe('Asia/Jakarta');
      expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // PART 6 §7: one slot per selected WIB window (default target 4).
      expect(body.slotsScheduled).toBe(4);
      expect(body.slotsUsed).toBe(0);
      expect(body.slotsRemaining).toBe(4);

      // Publication counters come from the live job queue, not fixtures.
      expect(body.publications).toEqual({
        succeeded: 0,
        failed: 0,
        retrying: 0,
        source: 'job_queue',
      });

      // No content has been generated yet — say so instead of faking a preview.
      expect(body.latestContent).toBeNull();
      expect(body.latestContentNote).toMatch(/not implemented/i);

      expect(Array.isArray(body.recentActivity)).toBe(true);
      expect(body.recentActivitySource).toBe('job_queue');
      expect(typeof body.serverTime).toBe('string');
    } finally {
      await app.close();
    }
  });

  it('counts today slots and publication outcomes from the queue', async () => {
    const { app, container } = await createApp();
    try {
      const today = container.schedulerStatus().today;
      await container.queue.enqueue({
        kind: 'publish',
        uniqueKey: `${today}#01`,
        scheduledFor: new Date().toISOString(),
        payload: {},
      });
      const running = await container.queue.enqueue({
        kind: 'publish',
        uniqueKey: `${today}#02`,
        scheduledFor: new Date().toISOString(),
        payload: {},
      });
      const claimed = await container.queue.claim('worker');
      if (claimed) {
        await container.queue.complete(claimed.id);
      }
      const failed = await container.queue.enqueue({
        kind: 'publish',
        uniqueKey: `${today}#03`,
        scheduledFor: new Date().toISOString(),
        payload: {},
      });
      await container.queue.fail(failed.id, 'sample failure', false);
      void running;

      const res = await app.inject({
        method: 'GET',
        url: '/v1/automation/status',
        headers: auth(),
      });
      const body = res.json();
      expect(body.slotsUsed).toBe(3);
      // PART 6 §7: the day holds 4 window slots, so 3 used leaves 1.
      expect(body.slotsRemaining).toBe(1);
      expect(body.publications.succeeded).toBe(1);
      expect(body.publications.failed).toBe(1);
      expect(body.recentActivity.length).toBe(3);
      expect(body.recentActivity[0]).toHaveProperty('slotKey');
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Settings                                                                  */
/* ========================================================================== */

describe('GET /v1/settings', () => {
  it('requires authentication', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/settings' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns the locked defaults plus machine-readable constraints', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.settings).toMatchObject({
        intervalMinutes: 60,
        maxSlotsPerDay: 24,
        facebookEnabled: true,
        threadsEnabled: true,
        imageCountPolicy: 'random_1_or_2',
        telegramNotificationsEnabled: true,
        automationState: 'paused',
      });
      expect(body.storage.kind).toBe('memory');
      expect(body.warning).toBeNull();
      expect(body.constraints.maxSlotsPerDay).toBe(24);
      expect(body.constraints.imageCountPolicies).toContain('random_1_or_2');
      expect(body.controls).toEqual(['start', 'pause', 'resume']);
      expect(JSON.stringify(body)).not.toContain(BASE_ENV.AUTH_JWT_SECRET);
    } finally {
      await app.close();
    }
  });
});

describe('PUT /v1/settings', () => {
  it('requires the control scope', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(['read']),
        payload: { intervalMinutes: 90 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    } finally {
      await app.close();
    }
  });

  it('validates, persists and returns the new settings', async () => {
    const { app } = await createApp();
    try {
      const put = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: {
          intervalMinutes: 90,
          maxSlotsPerDay: 12,
          facebookEnabled: false,
          imageCountPolicy: 'one',
          // PART 6 §7: pick the 3-window target and prove the scheduler follows.
          dailyPostTarget: 3,
        },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().settings).toMatchObject({
        intervalMinutes: 90,
        maxSlotsPerDay: 12,
        facebookEnabled: false,
        threadsEnabled: true, // untouched keys keep their previous value
        imageCountPolicy: 'one',
        dailyPostTarget: 3,
      });

      // Persistence: a subsequent GET reflects the change.
      const get = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth() });
      expect(get.json().settings.intervalMinutes).toBe(90);

      // The scheduler follows the settings.
      const status = await app.inject({
        method: 'GET',
        url: '/v1/scheduler/status',
        headers: auth(),
      });
      expect(status.json().intervalMinutes).toBe(90);
      expect(status.json().maxSlotsPerDay).toBe(12);
      expect(status.json().dailyPostTarget).toBe(3);
      // PART 6 §7: legacy interval/slot fields no longer drive the schedule;
      // the daily target does — 3 windows (06, 12, 16) for target 3.
      expect(status.json().slotsToday).toBe(3);
      expect(status.json().todayWindows).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  it('rejects a slot limit above the locked maximum', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { maxSlotsPerDay: 25 },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('INVALID_SETTINGS');
      expect(JSON.stringify(body.error.issues)).toContain('settings.maxSlotsPerDay');
    } finally {
      await app.close();
    }
  });

  it('rejects a schedule that cannot fit one day', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { intervalMinutes: 720, maxSlotsPerDay: 24 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_SETTINGS');
    } finally {
      await app.close();
    }
  });

  it('rejects unknown keys and wrongly typed values', async () => {
    const { app } = await createApp();
    try {
      const unknown = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { postingInterval: 90 },
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error.code).toBe('INVALID_REQUEST');

      const wrongType = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { threadsEnabled: 'yes' },
      });
      expect(wrongType.statusCode).toBe(400);
      expect(wrongType.json().error.code).toBe('INVALID_REQUEST');
    } finally {
      await app.close();
    }
  });

  it('refuses to change the run state through the settings endpoint', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { automationState: 'running' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_REQUEST');
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Start / pause / resume                                                    */
/* ========================================================================== */

describe('POST /v1/automation/control', () => {
  it('requires authentication and the control scope', async () => {
    const { app } = await createApp();
    try {
      const anon = await app.inject({
        method: 'POST',
        url: '/v1/automation/control',
        payload: { action: 'start' },
      });
      expect(anon.statusCode).toBe(401);

      const readOnly = await app.inject({
        method: 'POST',
        url: '/v1/automation/control',
        headers: auth(['read']),
        payload: { action: 'start' },
      });
      expect(readOnly.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown action', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/automation/control',
        headers: auth(),
        payload: { action: 'explode' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_REQUEST');
    } finally {
      await app.close();
    }
  });

  it('transitions paused -> running and reports idempotency', async () => {
    const { app } = await createApp();
    try {
      const start = await app.inject({
        method: 'POST',
        url: '/v1/automation/control',
        headers: auth(),
        payload: { action: 'start' },
      });
      expect(start.statusCode).toBe(200);
      expect(start.json()).toMatchObject({ action: 'start', changed: true, state: 'running' });

      const again = await app.inject({
        method: 'POST',
        url: '/v1/automation/control',
        headers: auth(),
        payload: { action: 'start' },
      });
      expect(again.json().changed).toBe(false);

      const settings = await app.inject({ method: 'GET', url: '/v1/settings', headers: auth() });
      expect(settings.json().settings.automationState).toBe('running');

      const pause = await app.inject({
        method: 'POST',
        url: '/v1/automation/control',
        headers: auth(),
        payload: { action: 'pause' },
      });
      expect(pause.json()).toMatchObject({ changed: true, state: 'paused' });

      const status = await app.inject({
        method: 'GET',
        url: '/v1/scheduler/status',
        headers: auth(),
      });
      expect(status.json().enabled).toBe(false);
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Fixture content preview                                                   */
/* ========================================================================== */

describe('GET /v1/content/preview', () => {
  it('requires authentication', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/content/preview' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns fixture content with a stable 1-2 image count', async () => {
    const { app } = await createApp();
    try {
      const first = await app.inject({
        method: 'GET',
        url: '/v1/content/preview?slot=2026-10-12%2307',
        headers: auth(),
      });
      expect(first.statusCode).toBe(200);
      const body = first.json();

      expect(body.source).toBe('fixture');
      expect(body.slotKey).toBe('2026-10-12#07');
      expect([1, 2]).toContain(body.imageCount);
      expect(body.imageCountShared).toBe(true);
      expect(body.imageCountStable).toBe(true);
      expect(body.product.affiliateUrl).toContain('https://');
      expect(body.caption.hashtags.length).toBeGreaterThan(0);
      expect(body.validation.passed).toBe(true);
      expect(body.platforms.facebook.status).toBe('not_attempted');
      expect(body.platforms.threads.status).toBe('not_attempted');

      // Stability: refreshing the same slot must not change the payload.
      const second = await app.inject({
        method: 'GET',
        url: '/v1/content/preview?slot=2026-10-12%2307',
        headers: auth(),
      });
      expect(second.json().imageCount).toBe(body.imageCount);
      expect(second.json()).toEqual(body);
    } finally {
      await app.close();
    }
  });

  it('honours the configured image-count policy', async () => {
    const { app } = await createApp();
    try {
      await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: auth(),
        payload: { imageCountPolicy: 'one' },
      });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/content/preview',
        headers: auth(),
      });
      expect(res.json().imageCount).toBe(1);
      expect(res.json().imageCountPolicy).toBe('one');
    } finally {
      await app.close();
    }
  });

  it('falls back to the next scheduled slot when no slot is given', async () => {
    const { app } = await createApp();
    try {
      const status = await app.inject({
        method: 'GET',
        url: '/v1/scheduler/status',
        headers: auth(),
      });
      const expectedKey = status.json().nextSlot.key;

      const res = await app.inject({ method: 'GET', url: '/v1/content/preview', headers: auth() });
      expect(res.json().slotKey).toBe(expectedKey);
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Fixture publishing history                                                */
/* ========================================================================== */

describe('GET /v1/history/publishes', () => {
  it('requires authentication', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/history/publishes' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns fixture records with independent per-platform results', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/history/publishes',
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.source).toBe('fixture');
      expect(body.count).toBe(body.items.length);
      expect(body.items.length).toBeGreaterThan(0);

      for (const item of body.items) {
        expect(item.source).toBe('fixture');
        expect([1, 2]).toContain(item.imageCount);
        expect(item.facebook).toHaveProperty('status');
        expect(item.threads).toHaveProperty('status');
        expect(item.facebook).toHaveProperty('url');
        expect(item.threads).toHaveProperty('error');
      }

      const mixed = body.items.find(
        (i: any) => i.facebook.status === 'published' && i.threads.status === 'failed',
      );
      expect(mixed).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it('honours the limit parameter', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/history/publishes?limit=1',
        headers: auth(),
      });
      expect(res.json().count).toBe(1);
    } finally {
      await app.close();
    }
  });
});

/* ========================================================================== */
/*  Integration health                                                        */
/* ========================================================================== */

describe('GET /v1/meta/integrations', () => {
  it('classifies every service and never claims a live connection', async () => {
    const { app } = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/meta/integrations' });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(Object.keys(body.healthLegend)).toEqual([...INTEGRATION_HEALTH_VALUES]);

      for (const entry of body.integrations) {
        expect(INTEGRATION_HEALTH_VALUES).toContain(entry.health);
        expect(typeof entry.healthDetail).toBe('string');
        expect(entry.health).not.toBe('connected'); // gated build, no credentials
      }

      // No secrets of any kind in the payload.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/EAAB[A-Za-z0-9]{20,}/);
      expect(serialized).not.toMatch(/\d{6,12}:[A-Za-z0-9_-]{25,}/);
      expect(serialized).not.toContain(BASE_ENV.AUTH_JWT_SECRET);
    } finally {
      await app.close();
    }
  });
});
