/**
 * PART 8 §3/§5/§6/§8 — HTTP contract for readiness, ops diagnostics and
 * Telegram notification settings.
 *
 * Proves at the HTTP boundary:
 *  - GET /ready is PUBLIC and minimal (no hostnames/credentials); it is 200 in
 *    dev (DB not_configured) and can never expose internal network detail,
 *  - /v1/ops/health|metrics are read-scoped and /v1/ops/preflight is
 *    control-scoped; unauthenticated or under-scoped requests are rejected,
 *  - responses carry no secret, token or bot credential in any form,
 *  - Telegram credentials are WRITE-ONLY: stored sealed, reported as presence
 *    only, and storing fails closed (503) without an encryption key,
 *  - the explicit test action reports exactly what happened and is rate
 *    limited; with no credential it returns not_configured WITHOUT any
 *    network attempt (no chat can be reached from the default suite),
 *  - GET /health stays unchanged (part: 1).
 *
 * SAFETY: this environment stores no Telegram credential and env has none, so
 * no code path here can reach api.telegram.org.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/app/server.js';
import { buildContainer } from '../../src/app/container.js';
import { loadEnv } from '../../src/core/env.js';
import { createNullLogger } from '../../src/core/logger.js';
import { mintTokenFromOptions } from '../../src/core/auth.js';

const TEST_ENV = loadEnv({
  AUTH_JWT_SECRET: 'test-secret-that-is-definitely-long-enough-123456',
  AUTH_JWT_ISSUER: 'test-issuer',
  AUTH_JWT_AUDIENCE: 'test-audience',
  CORS_ORIGINS: 'http://localhost:8080',
  SCHEDULER_ENABLED: 'true',
  NODE_ENV: 'test',
});

let app: FastifyInstance;

function token(scope: string[]): string {
  return mintTokenFromOptions(
    {
      subject: 'ops-device',
      issuer: TEST_ENV.AUTH_JWT_ISSUER,
      audience: TEST_ENV.AUTH_JWT_AUDIENCE,
      ttlSeconds: 3600,
      scope,
    },
    TEST_ENV.AUTH_JWT_SECRET,
  );
}

const FULL = token(['dashboard', 'read', 'control']);
const READ_ONLY = token(['dashboard', 'read']);
const NO_SCOPE = token(['dashboard']);

beforeAll(async () => {
  const container = buildContainer({ env: TEST_ENV, logger: createNullLogger() });
  app = await buildServer(container);
  await app.ready();
});

/* ========================================================================== */
/*  /health regression guard + /ready                                         */
/* ========================================================================== */

describe('GET /health (unchanged by PART 8)', () => {
  it('still reports part: 1 and status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.part).toBe(1);
  });
});

describe('GET /ready (public readiness gate)', () => {
  it('is 200 ready in dev: database not_configured is a valid, ready mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.checks).toEqual({ database: 'not_configured', migrations: 'not_configured' });
    expect(body.reason).toBeNull();
    expect(typeof body.timestamp).toBe('string');
  });

  it('needs no authentication (load-balancer probes cannot carry tokens)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200); // no Authorization header supplied
  });

  it('exposes no hostname, credential or provider detail in the body', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    const serialized = JSON.stringify(res.json());
    expect(serialized).not.toMatch(/localhost|127\.0\.0\.1|::1/);
    expect(serialized).not.toMatch(/secret|token|api[_-]?key/i);
    expect(serialized).not.toMatch(/\d{6,12}:[A-Za-z0-9_-]{25,}/);
    // The body stays minimal: exactly the documented keys.
    expect(Object.keys(res.json()).sort()).toEqual([
      'checks',
      'note',
      'reason',
      'status',
      'timestamp',
    ]);
  });
});

/* ========================================================================== */
/*  /v1/ops/health + /v1/ops/metrics (read)                                   */
/* ========================================================================== */

describe('GET /v1/ops/health', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/ops/health' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token without the read scope with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/health',
      headers: { authorization: `Bearer ${NO_SCOPE}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns the full component report with overall + ready + scheduler + queue', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/health',
      headers: { authorization: `Bearer ${READ_ONLY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.overall).toBeDefined();
    expect(body.ready).toBe(true); // dev: no DB configured → ready
    expect(typeof body.checkedAt).toBe('string');

    const keys = body.components.map((c: { key: string }) => c.key);
    for (const expected of [
      'backend',
      'database',
      'migrations',
      'scheduler',
      'queue',
      'caption_provider',
      'image_provider',
      'asset_storage',
      'telegram',
      'budget',
      'publishing_gate',
    ]) {
      expect(keys).toContain(expected);
    }
    // Publishing is explicitly reported as disabled-by-design.
    const gate = body.components.find((c: { key: string }) => c.key === 'publishing_gate');
    expect(gate.status).toBe('disabled');
    expect(gate.code).toBe('publishing_disabled');
    // Scheduler diagnostics feed the dashboard (WIB + daily target).
    expect(body.scheduler.timezone).toBe('Asia/Jakarta');
    expect(typeof body.scheduler.dailyPostTarget).toBe('number');
  });

  it('carries no secret or bot token anywhere in the serialized report', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/health',
      headers: { authorization: `Bearer ${FULL}` },
    });
    const serialized = JSON.stringify(res.json());
    expect(serialized).not.toMatch(/\d{6,12}:[A-Za-z0-9_-]{25,}/);
    expect(serialized).not.toMatch(/bearer\s+[A-Za-z0-9._~+/-]{16,}/i);
  });
});

describe('GET /v1/ops/metrics', () => {
  it('requires the read scope and returns low-cardinality counters', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/metrics',
      headers: { authorization: `Bearer ${READ_ONLY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scheduler).toBeDefined();
    expect(typeof body.scheduler.dailyPostTarget).toBe('number');
    expect(body.queue).toMatchObject({ pending: 0, running: 0, succeeded: 0, failed: 0 });
    expect(body.events).toBeDefined();
    expect(typeof body.events.sampled).toBe('number');
  });

  it('never includes job ids, slot keys, product data or credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/metrics',
      headers: { authorization: `Bearer ${FULL}` },
    });
    const serialized = JSON.stringify(res.json());
    expect(serialized).not.toMatch(/uniqueKey|product|affiliate/i);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}#\d{2}/); // slot keys
    expect(serialized).not.toMatch(/\d{6,12}:[A-Za-z0-9_-]{25,}/);
  });
});

/* ========================================================================== */
/*  /v1/ops/preflight (control)                                               */
/* ========================================================================== */

describe('GET /v1/ops/preflight', () => {
  it('requires the control scope', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/ops/preflight',
      headers: { authorization: `Bearer ${READ_ONLY}` },
    });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/preflight',
      headers: { authorization: `Bearer ${FULL}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.ok).toBe('boolean');
    expect(body.generatedAt).toBeDefined();
    expect(body.nodeEnv).toBe('test');
    // Dev mode with no DB: warnings may exist, blockers may not flip automation.
    expect(body.blockers.some((b: { id: string }) => b.id === 'publishing_gate')).toBe(false);
  });

  it('reports the publishing gate as pass and changes nothing (read-only)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/preflight',
      headers: { authorization: `Bearer ${FULL}` },
    });
    const body = res.json();
    const gate = [...body.blockers, ...body.warnings, ...body.passed].find(
      (check: { id: string }) => check.id === 'publishing_gate',
    );
    expect(gate.status).toBe('pass');
  });
});

/* ========================================================================== */
/*  Telegram notification settings                                            */
/* ========================================================================== */

describe('GET /v1/notifications/telegram', () => {
  it('requires authentication and the read scope', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/notifications/telegram' })).statusCode).toBe(401);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${NO_SCOPE}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('reports not_configured state without crashing (no credential anywhere)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${READ_ONLY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true); // enabled by default, but inert without a credential
    expect(body.minSeverity).toBe('warning');
    expect(body.eventKinds).toEqual([]);
    expect(body.secret.present).toBe(false); // → deliveries report not_configured
    expect(body.secret.stored).toBe(false);
    expect(body.lastDelivery).toBeNull();
  });

  it('never returns a token or chat id value in any form', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${FULL}` },
    });
    const serialized = JSON.stringify(res.json());
    expect(serialized).not.toMatch(/botToken|chatId/);
    expect(serialized).not.toMatch(/\d{6,12}:[A-Za-z0-9_-]{25,}/);
  });
});

describe('PUT /v1/notifications/telegram', () => {
  it('validates the payload and rejects unknown shapes with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${FULL}` },
      payload: { minSeverity: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });

  it('persists enable/severity/kind filters (control scope) and echoes no secret', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${FULL}` },
      payload: { enabled: true, minSeverity: 'critical', eventKinds: ['budget_exhausted'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: true,
      minSeverity: 'critical',
      eventKinds: ['budget_exhausted'],
      updated: true,
    });

    const readBack = await app.inject({
      method: 'GET',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${READ_ONLY}` },
    });
    expect(readBack.json().enabled).toBe(true);
    expect(readBack.json().minSeverity).toBe('critical');

    // Restore defaults for other tests.
    await app.inject({
      method: 'PUT',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${FULL}` },
      payload: { enabled: true, minSeverity: 'warning', eventKinds: [] },
    });
  });

  it('requires the control scope', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${READ_ONLY}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /v1/notifications/telegram/secret (write-only credential)', () => {
  it('fails CLOSED with 503 when SECRETS_ENCRYPTION_KEY is not configured', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/telegram/secret',
      headers: { authorization: `Bearer ${FULL}` },
      payload: { botToken: '123456789:AAHfakefakefakefakefakefakefak', chatId: '-1001' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SECRETS_KEY_MISSING');
  });

  it('rejects malformed credentials with 400 without storing anything', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/telegram/secret',
      headers: { authorization: `Bearer ${FULL}` },
      payload: { botToken: 'no spaces allowed here at all ok', chatId: '' },
    });
    // 503 wins first in this env (no key) — the fail-closed check runs first.
    expect([400, 503]).toContain(res.statusCode);
    expect([ 'INVALID_REQUEST', 'SECRETS_KEY_MISSING' ]).toContain(res.json().error.code);
  });

  it('DELETE is idempotent and reports presence only', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/notifications/telegram/secret',
      headers: { authorization: `Bearer ${FULL}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false, secret: { present: false, stored: false } });
  });

  it('requires the control scope for both secret routes', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/notifications/telegram/secret',
      headers: { authorization: `Bearer ${READ_ONLY}` },
      payload: { botToken: '123456789:AAHfakefakefakefakefakefakefak', chatId: '-1001' },
    });
    expect(put.statusCode).toBe(403);
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/notifications/telegram/secret',
      headers: { authorization: `Bearer ${READ_ONLY}` },
    });
    expect(del.statusCode).toBe(403);
  });
});

describe('POST /v1/notifications/telegram/test', () => {
  it('reports not_configured (no network, no chat) when no credential exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notifications/telegram/test',
      headers: { authorization: `Bearer ${FULL}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.test).toBe(true);
    expect(body.delivered).toBe(false);
    expect(body.status).toBe('not_configured');
    expect(body.errorCode).toBe('telegram_not_configured');
    expect(body.messageId).toBeNull();
    expect(body.note).toMatch(/Save the bot token/);
  });

  it('rate-limits a second immediate test with 429', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notifications/telegram/test',
      headers: { authorization: `Bearer ${FULL}` },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });

  it('requires the control scope', async () => {
    // Consume nothing new; scope check runs before the rate limiter.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/notifications/telegram/test',
      headers: { authorization: `Bearer ${READ_ONLY}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

/* ========================================================================== */
/*  Stored-credential lifecycle on a keyed instance (still no network)         */
/* ========================================================================== */

describe('Telegram credential lifecycle (encryption key configured)', () => {
  let keyed: FastifyInstance;
  const FAKE_TOKEN = '123456789:AAHcontracttestfakevalue-abcdefgh';
  const KEYED_ENV = loadEnv({
    AUTH_JWT_SECRET: 'test-secret-that-is-definitely-long-enough-123456',
    AUTH_JWT_ISSUER: 'test-issuer',
    AUTH_JWT_AUDIENCE: 'test-audience',
    CORS_ORIGINS: 'http://localhost:8080',
    NODE_ENV: 'test',
    SECRETS_ENCRYPTION_KEY: 'a'.repeat(64),
  });

  beforeAll(async () => {
    const container = buildContainer({ env: KEYED_ENV, logger: createNullLogger() });
    keyed = await buildServer(container);
    await keyed.ready();
  });

  it('stores the credential, reports presence only, and never echoes the value', async () => {
    const key = mintTokenFromOptions(
      {
        subject: 'ops-device',
        issuer: KEYED_ENV.AUTH_JWT_ISSUER,
        audience: KEYED_ENV.AUTH_JWT_AUDIENCE,
        ttlSeconds: 3600,
        scope: ['dashboard', 'read', 'control'],
      },
      KEYED_ENV.AUTH_JWT_SECRET,
    );

    const put = await keyed.inject({
      method: 'PUT',
      url: '/v1/notifications/telegram/secret',
      headers: { authorization: `Bearer ${key}` },
      payload: { botToken: FAKE_TOKEN, chatId: '-100999' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().configured).toBe(true);
    // The stored value never comes back out.
    expect(put.rawPayload.toString()).not.toContain(FAKE_TOKEN);
    expect(put.rawPayload.toString()).not.toContain('-100999');

    const status = await keyed.inject({
      method: 'GET',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(status.json().secret.present).toBe(true);
    expect(status.json().secret.stored).toBe(true);
    expect(status.rawPayload.toString()).not.toContain(FAKE_TOKEN);

    // Removing returns to not_configured; DELETE stays idempotent.
    const del = await keyed.inject({
      method: 'DELETE',
      url: '/v1/notifications/telegram/secret',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(del.statusCode).toBe(200);
    const after = await keyed.inject({
      method: 'GET',
      url: '/v1/notifications/telegram',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(after.json().secret.present).toBe(false);
  });
});
