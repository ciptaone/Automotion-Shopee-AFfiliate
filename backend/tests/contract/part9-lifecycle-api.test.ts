/**
 * PART 9 §5/§8 — liveness vs readiness across shutdown and database outages.
 *
 * Proves at the HTTP boundary:
 *  - /ready flips to 503 `shutting_down` the moment a shutdown signal begins,
 *    WITHOUT touching the database (drain must stay fast), and returns to 200
 *    when the flag clears — same five-key body as before, status code 503;
 *  - /health (liveness, part: 1) is NOT affected by the shutdown flag;
 *  - a transient database failure degrades /ready to 503 and RECOVERS to 200
 *    once the database answers again (restart/outage drill), and a pending
 *    schema is reported as such.
 *
 * Deterministic: the database handle is an injected fake whose answers the
 * test flips — no PostgreSQL, no timers, no polling.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer, type BuildServerOptions } from '../../src/app/server.js';
import { buildContainer } from '../../src/app/container.js';
import { loadEnv } from '../../src/core/env.js';
import { createNullLogger } from '../../src/core/logger.js';
import type { DatabaseHandle } from '../../src/db/client.js';
import type { MigrationStatusReport } from '../../src/db/migration-status.js';

const TEST_ENV = loadEnv({
  AUTH_JWT_SECRET: 'test-secret-that-is-definitely-long-enough-123456',
  AUTH_JWT_ISSUER: 'test-issuer',
  AUTH_JWT_AUDIENCE: 'test-audience',
  CORS_ORIGINS: 'http://localhost:8080',
  NODE_ENV: 'test',
});

function report(overrides: Partial<MigrationStatusReport> = {}): MigrationStatusReport {
  return {
    migrationsFolder: 'drizzle',
    journalEntries: 5,
    appliedRows: 5,
    tablePresent: true,
    entries: [],
    unknownApplied: [],
    appliedCount: 5,
    pendingCount: 0,
    divergedCount: 0,
    consistent: true,
    problems: [],
    notes: [],
    ...overrides,
  };
}

describe('GET /ready — shutdown flips readiness, liveness stays up', () => {
  let app: FastifyInstance;
  let stopping = false;
  let probes = 0;

  const database: DatabaseHandle = {
    db: null,
    raw: null,
    configured: true,
    healthy: async () => {
      probes += 1;
      return true;
    },
    statusDetail: async () => 'healthy',
    migrationStatus: async () => report(),
    close: async () => undefined,
  };

  beforeAll(async () => {
    const container = buildContainer({
      env: TEST_ENV,
      logger: createNullLogger(),
      overrides: { database },
    });
    const options: BuildServerOptions = { isShuttingDown: () => stopping };
    app = await buildServer(container, options);
    await app.ready();
  });

  it('is 200 ready before shutdown begins', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
    expect(probes).toBeGreaterThan(0);
  });

  it('answers 503 shutting_down while draining, with the same minimal key set', async () => {
    const probesBefore = probes;
    stopping = true;

    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);

    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['checks', 'note', 'reason', 'status', 'timestamp']);
    expect(body.status).toBe('stopping');
    expect(body.reason).toBe('shutting_down');
    expect(body.checks).toEqual({ database: 'not_probed', migrations: 'not_probed' });
    expect(typeof body.timestamp).toBe('string');
    // Shutdown readiness must not issue a database round-trip.
    expect(probes).toBe(probesBefore);

    // No internal detail leaks into the draining response either.
    expect(JSON.stringify(body)).not.toMatch(/postgres:\/\//);
    expect(JSON.stringify(body)).not.toMatch(/password/i);
  });

  it('keeps LIVENESS untouched while readiness is failing', async () => {
    stopping = true;
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.part).toBe(1);
    expect(body.status).toBe('ok');
  });

  it('returns to 200 when the flag clears (signal handled before drain)', async () => {
    stopping = false;
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
  });
});

describe('GET /ready — transient database failure and recovery', () => {
  let app: FastifyInstance;
  let dbUp = true;
  let pendingMigrations = false;

  const database: DatabaseHandle = {
    db: null,
    raw: null,
    configured: true,
    healthy: async () => dbUp,
    statusDetail: async () => (dbUp ? 'healthy' : 'connection refused (simulated outage)'),
    migrationStatus: async () =>
      !dbUp ? null : report({ pendingCount: pendingMigrations ? 2 : 0, consistent: !pendingMigrations }),
    close: async () => undefined,
  };

  beforeAll(async () => {
    const container = buildContainer({
      env: TEST_ENV,
      logger: createNullLogger(),
      overrides: { database },
    });
    app = await buildServer(container);
    await app.ready();
  });

  it('goes 503 during an outage and back to 200 after recovery', async () => {
    const healthy = await app.inject({ method: 'GET', url: '/ready' });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json().checks).toEqual({ database: 'ok', migrations: 'ok' });

    dbUp = false; // simulated transient outage
    const outage = await app.inject({ method: 'GET', url: '/ready' });
    expect(outage.statusCode).toBe(503);
    expect(outage.json().status).toBe('not_ready');
    expect(outage.json().reason).toBe('database_unreachable');
    expect(outage.json().checks.database).toBe('unavailable');

    dbUp = true; // database answers again — no restart required
    const recovered = await app.inject({ method: 'GET', url: '/ready' });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().status).toBe('ready');
  });

  it('reports a pending schema distinctly from an unreachable database', async () => {
    pendingMigrations = true;
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toBe('migration_pending');
    expect(res.json().checks).toEqual({ database: 'ok', migrations: 'pending' });
    pendingMigrations = false;
  });
});
