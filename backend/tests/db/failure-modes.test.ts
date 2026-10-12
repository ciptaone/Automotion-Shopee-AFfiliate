/**
 * Failure modes: the database must never be silently replaced (PART 5).
 *
 * The dangerous failure of a "production-ready" backend is not a crash — it is
 * a process that keeps answering 200s while writing into a file or a map that
 * a restart will throw away. These tests pin down that it cannot happen:
 *
 *   - production configuration without DATABASE_URL is rejected at startup;
 *   - the container refuses to build when PostgreSQL was required but no
 *     connection exists (no file-store fallback, no in-memory shim);
 *   - an unreachable database is reported WITHOUT leaking credentials;
 *   - losing the database mid-run makes writes fail loudly instead of
 *     disappearing into another backend.
 *
 * No credentials, no network: the only TCP target is 127.0.0.1 with a port
 * nothing listens on.
 */
import { describe, expect, it } from 'vitest';
import { EnvironmentError } from '../../src/core/errors.js';
import { loadEnv, resetEnvCache } from '../../src/core/env.js';
import {
  derivePersistenceBackend,
  resolvePersistenceBackend,
} from '../../src/core/persistence.js';
import { createDatabaseHandle } from '../../src/db/client.js';
import { PostgresJobQueue } from '../../src/db/postgres-job-queue.js';
import { PostgresSlotStore } from '../../src/db/postgres-slot-store.js';
import { openTestDatabase, resetDatabase } from './helpers.js';

describe('persistence backend resolution fails closed', () => {
  it('refuses a production deployment that is not database-backed', () => {
    for (const backend of ['file', 'memory'] as const) {
      const decision = resolvePersistenceBackend({
        nodeEnv: 'production',
        persistenceBackend: backend,
        databaseUrl: 'postgres://user:pass@127.0.0.1:5432/app',
      });
      expect(decision.backend).toBe(backend);
      expect(decision.errors.join(' ')).toMatch(/production requires "postgres"/);
    }
  });

  it('refuses postgres without a DATABASE_URL (in production and in development)', () => {
    for (const nodeEnv of ['production', 'development'] as const) {
      const decision = resolvePersistenceBackend({ nodeEnv, persistenceBackend: 'postgres' });
      expect(decision.backend).toBe('postgres');
      expect(decision.errors.join(' ')).toMatch(/DATABASE_URL is required/);
      // The message must be safe to print: it never echoes a URL.
      expect(decision.errors.join(' ')).not.toMatch(/postgres:\/\//);
    }
  });

  it('derives postgres for production and memory for tests', () => {
    expect(derivePersistenceBackend('production')).toBe('postgres');
    expect(derivePersistenceBackend('test')).toBe('memory');
    expect(derivePersistenceBackend('development')).toBe('file');
  });

  it('the decision explains itself without secrets', () => {
    const decision = resolvePersistenceBackend({
      nodeEnv: 'production',
      persistenceBackend: 'postgres',
      databaseUrl: 'postgres://someone:s3cr3t@127.0.0.1:5432/app',
    });
    expect(decision.errors).toHaveLength(0);
    expect(decision.hasDatabaseUrl).toBe(true);
    expect(JSON.stringify(decision)).not.toContain('s3cr3t');
    expect(JSON.stringify(decision)).not.toContain('someone');
  });
});

describe('environment validation refuses an unusable production database config', () => {
  it('reports DATABASE_URL as a missing key when NODE_ENV=production', () => {
    resetEnvCache();
    let thrown: unknown;
    try {
      loadEnv({
        NODE_ENV: 'production',
        // Both keys are otherwise valid (the secret meets the 32-char minimum),
        // so DATABASE_URL is the ONLY thing wrong with this configuration.
        AUTH_JWT_SECRET: 'x'.repeat(48),
        CORS_ORIGINS: 'https://app.example.com',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvironmentError);
    const error = thrown as EnvironmentError;
    expect(error.missingKeys).toContain('DATABASE_URL');
    expect(error.message).not.toMatch(/postgres:\/\//);
  });
});

describe('connection diagnostics are credential-free', () => {
  it('reports an unreachable database without echoing the password', async () => {
    // Port 1: nothing listens on it, so this fails immediately.
    const handle = createDatabaseHandle(
      'postgres://appuser:super-secret-password@127.0.0.1:1/autopilot?connect_timeout=1',
    );
    try {
      expect(await handle.healthy()).toBe(false);
      const detail = await handle.statusDetail();
      expect(detail).toMatch(/unreachable/);
      expect(detail).not.toContain('super-secret-password');
      expect(detail).not.toContain('appuser');
      expect(detail).not.toContain('postgres://');
      // Migration status degrades to null rather than throwing.
      expect(await handle.migrationStatus()).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it('reports an unconfigured database honestly instead of pretending to be healthy', async () => {
    const handle = createDatabaseHandle(undefined);
    expect(handle.configured).toBe(false);
    expect(handle.db).toBeNull();
    expect(await handle.healthy()).toBe(false);
    expect(await handle.statusDetail()).toMatch(/DATABASE_URL not set/);
    expect(await handle.migrationStatus()).toBeNull();
  });
});

describe('losing the database mid-run fails loudly (no mock fallback)', () => {
  it('rejects queue and slot writes once the connection is gone', async () => {
    const database = openTestDatabase();
    await resetDatabase(database.db);

    const queue = new PostgresJobQueue({ db: database.db });
    const slots = new PostgresSlotStore(database.db);

    // Before: everything works.
    await queue.enqueue({
      kind: 'content_slot',
      uniqueKey: 'content:2099-01-01#01',
      scheduledFor: new Date().toISOString(),
      payload: { slotKey: '2099-01-01#01' },
    });
    expect(await slots.refresh('content:2099-01-01#01')).toBeNull(); // row absent, but the READ worked

    // After: the connection is torn down under the process.
    await database.close();

    const afterClose = new PostgresJobQueue({ db: database.db });
    await expect(
      afterClose.enqueue({
        kind: 'content_slot',
        uniqueKey: 'content:2099-01-01#02',
        scheduledFor: new Date().toISOString(),
        payload: {},
      }),
    ).rejects.toThrow();

    const slotsAfterClose = new PostgresSlotStore(database.db);
    await expect(slotsAfterClose.refresh('content:2099-01-01#01')).rejects.toThrow();

    // And the stores are still PostgreSQL-backed: nothing silently became an
    // in-memory or file-backed implementation that would "work" without a DB.
    expect(slotsAfterClose.kind).toBe('postgres');
  });
});
