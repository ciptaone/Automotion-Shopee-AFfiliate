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

function validToken(overrides: Record<string, unknown> = {}): string {
  return mintTokenFromOptions(
    {
      subject: 'test-device',
      issuer: TEST_ENV.AUTH_JWT_ISSUER,
      audience: TEST_ENV.AUTH_JWT_AUDIENCE,
      ttlSeconds: 3600,
      scope: ['dashboard', 'read', 'control'],
      ...overrides,
    },
    TEST_ENV.AUTH_JWT_SECRET,
  );
}

beforeAll(async () => {
  const container = buildContainer({ env: TEST_ENV, logger: createNullLogger() });
  app = await buildServer(container);
  await app.ready();
});

/* ========================================================================== */
/*  Health                                                                    */
/* ========================================================================== */

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.part).toBe(1);
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('reports database as not configured in the default test env', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.database.configured).toBe(false);
    expect(body.database.healthy).toBe(false);
  });

  it('reports scheduler status with the Jakarta default', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.scheduler.timezone).toBe('Asia/Jakarta');
    expect(body.scheduler.intervalMinutes).toBe(60);
    expect(body.scheduler.maxSlotsPerDay).toBe(24);
  });

  it('lists every integration without leaking secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(Array.isArray(body.integrations)).toBe(true);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/EAAB[A-Za-z0-9]{20,}/);
    expect(serialized).not.toMatch(/\d{6,12}:[A-Za-z0-9_-]{25,}/);
  });
});

/* ========================================================================== */
/*  Integrations metadata                                                     */
/* ========================================================================== */

describe('GET /v1/meta/integrations', () => {
  it('returns 200 with an integrations list', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/meta/integrations' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.integrations)).toBe(true);
    expect(body.integrations.map((i: any) => i.service)).toContain('facebook_page');
    expect(body.integrations.map((i: any) => i.service)).toContain('threads');
    expect(body.integrations.map((i: any) => i.service)).toContain('telegram');
  });

  it('requires no authentication (readiness surface for the APK login screen)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/meta/integrations' });
    expect(res.statusCode).toBe(200);
  });
});

/* ========================================================================== */
/*  Auth token issuance                                                       */
/* ========================================================================== */

describe('POST /v1/auth/token', () => {
  it('rejects a request with no body', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/token', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });

  it('rejects an invalid install key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { installKey: 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_INSTALL_KEY');
  });

  it('issues a JWT for the correct install key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { installKey: TEST_ENV.AUTH_JWT_SECRET, deviceLabel: 'Pixel 8' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokenType).toBe('Bearer');
    expect(typeof body.accessToken).toBe('string');
    expect(body.accessToken.split('.')).toHaveLength(3);
    expect(body.scope).toContain('read');
  });

  it('never returns the signing secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      payload: { installKey: TEST_ENV.AUTH_JWT_SECRET },
    });
    expect(res.body).not.toContain(TEST_ENV.AUTH_JWT_SECRET);
  });
});

/* ========================================================================== */
/*  Authenticated routes                                                      */
/* ========================================================================== */

describe('authenticated endpoints', () => {
  it('GET /v1/me returns 401 without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/me returns 401 with a malformed Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Basic abc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/me returns 401 with a tampered token', async () => {
    const token = validToken();
    const [h, _p] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ iss: 'x', aud: 'y', sub: 'hacker', iat: 1, exp: 9999999999 }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${h}.${tamperedPayload}.${token.split('.')[2]}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/me returns the subject with a valid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${validToken()}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subject).toBe('test-device');
    expect(body.scopes).toContain('read');
  });

  it('GET /v1/me returns 401 for a token with the wrong audience', async () => {
    const token = mintTokenFromOptions(
      {
        subject: 'x',
        issuer: TEST_ENV.AUTH_JWT_ISSUER,
        audience: 'wrong-audience',
        ttlSeconds: 3600,
        scope: ['read'],
      },
      TEST_ENV.AUTH_JWT_SECRET,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/me returns 401 for an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintTokenFromOptions(
      {
        subject: 'x',
        issuer: TEST_ENV.AUTH_JWT_ISSUER,
        audience: TEST_ENV.AUTH_JWT_AUDIENCE,
        ttlSeconds: 10,
        nowSeconds: now - 3600,
      },
      TEST_ENV.AUTH_JWT_SECRET,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/scheduler/status requires auth and returns slots', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/scheduler/status' });
    expect(anon.statusCode).toBe(401);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/scheduler/status',
      headers: { authorization: `Bearer ${validToken()}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slotsToday).toBe(24);
    expect(body.timezone).toBe('Asia/Jakarta');
  });

  it('GET /v1/queue/jobs requires auth and returns a list', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/queue/jobs' });
    expect(anon.statusCode).toBe(401);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/queue/jobs',
      headers: { authorization: `Bearer ${validToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().jobs)).toBe(true);
  });

  it('enforces scope requirements', async () => {
    const noScope = mintTokenFromOptions(
      {
        subject: 'x',
        issuer: TEST_ENV.AUTH_JWT_ISSUER,
        audience: TEST_ENV.AUTH_JWT_AUDIENCE,
        ttlSeconds: 3600,
        scope: [],
      },
      TEST_ENV.AUTH_JWT_SECRET,
    );
    const res = await app.inject({
      method: 'GET',
      url: '/v1/scheduler/status',
      headers: { authorization: `Bearer ${noScope}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

/* ========================================================================== */
/*  404                                                                       */
/* ========================================================================== */

describe('unknown routes', () => {
  it('returns a JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/does/not/exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

/* ========================================================================== */
/*  Secret leakage canary                                                     */
/* ========================================================================== */

describe('secret-leak canary', () => {
  it('no response body contains the JWT signing secret', async () => {
    const urls = ['/health', '/v1/meta/integrations', '/v1/queue/jobs', '/v1/scheduler/status'];
    for (const url of urls) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${validToken()}` },
      });
      expect(res.body).not.toContain(TEST_ENV.AUTH_JWT_SECRET);
    }
  });
});
