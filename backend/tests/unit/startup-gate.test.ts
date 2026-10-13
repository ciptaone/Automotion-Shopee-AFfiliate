/**
 * PART 9 §4/§5 — the startup gate decides whether a process may serve traffic.
 *
 * Proves every rule that used to live inline in `main.ts`:
 *  - postgres-backed boot requires a reachable database AND a consistent
 *    schema (pending/drift/unknown all refuse, exit 78 in main),
 *  - file/memory boot (development/test) is ready by definition and never
 *    probes a database,
 *  - production warnings (mock generation defaults) are surfaced loudly but
 *    never turn a legal boot into a failure,
 *  - output contains only the injected, already-sanitized strings.
 *
 * Fully deterministic: the database surface is a fake, so this file runs in
 * the unit suite without PostgreSQL.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateStartupGate,
  type StartupGateDatabase,
  type StartupGateEnv,
} from '../../src/app/startup-gate.js';
import type { MigrationStatusReport } from '../../src/db/migration-status.js';

function consistentReport(): MigrationStatusReport {
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
  };
}

function fakeDatabase(
  overrides: Partial<StartupGateDatabase> = {},
): StartupGateDatabase {
  return {
    configured: true,
    healthy: async () => true,
    statusDetail: async () => 'healthy',
    migrationStatus: async () => consistentReport(),
    ...overrides,
  };
}

function env(overrides: Partial<StartupGateEnv> = {}): StartupGateEnv {
  return {
    NODE_ENV: 'development',
    SCHEDULER_ENABLED: 'false',
    SCHEDULER_MODE: 'mock',
    AI_IMAGE_PROVIDER: 'mock',
    AI_TEXT_PROVIDER: 'mock',
    ...overrides,
  };
}

describe('evaluateStartupGate — postgres-backed boot', () => {
  it('is ready when the database is reachable and the schema is consistent', async () => {
    const result = await evaluateStartupGate({
      env: env(),
      persistenceBackend: 'postgres',
      database: fakeDatabase(),
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('refuses when persistence says postgres but no URL is configured', async () => {
    const result = await evaluateStartupGate({
      env: env(),
      persistenceBackend: 'postgres',
      database: fakeDatabase({ configured: false }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('DATABASE_URL');
    // Never probes a database that does not exist.
    expect(result.problems.join(' ')).not.toContain('unreachable');
  });

  it('refuses when the database is unreachable, quoting the sanitized detail', async () => {
    const result = await evaluateStartupGate({
      env: env({ NODE_ENV: 'production' }),
      persistenceBackend: 'postgres',
      database: fakeDatabase({
        healthy: async () => false,
        statusDetail: async () => 'connect timeout (details sanitized)',
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toBe(
      'database unreachable: connect timeout (details sanitized)',
    );
  });

  it('refuses when the migration status cannot be read', async () => {
    const result = await evaluateStartupGate({
      env: env(),
      persistenceBackend: 'postgres',
      database: fakeDatabase({ migrationStatus: async () => null }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('migration status could not be read');
  });

  it('refuses a PENDING schema (migrations never applied)', async () => {
    const pending: MigrationStatusReport = {
      ...consistentReport(),
      appliedCount: 2,
      pendingCount: 3,
      consistent: false,
      problems: ['3 migration(s) pending'],
    };
    const result = await evaluateStartupGate({
      env: env(),
      persistenceBackend: 'postgres',
      database: fakeDatabase({ migrationStatus: async () => pending }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('database schema is not up to date');
    expect(result.problems.join(' ')).toContain('3 migration(s) pending');
  });

  it('refuses DRIFT (tables exist without bookkeeping)', async () => {
    const drifted: MigrationStatusReport = {
      ...consistentReport(),
      tablePresent: false,
      consistent: false,
      problems: ['database has application tables but no migration bookkeeping'],
    };
    const result = await evaluateStartupGate({
      env: env({ NODE_ENV: 'production' }),
      persistenceBackend: 'postgres',
      database: fakeDatabase({ migrationStatus: async () => drifted }),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('no migration bookkeeping');
  });

  it('never prints values — problems are exactly what the database reported', async () => {
    const result = await evaluateStartupGate({
      env: env(),
      persistenceBackend: 'postgres',
      database: fakeDatabase({
        healthy: async () => false,
        statusDetail: async () => 'authentication failed for user "deploy"',
      }),
    });
    expect(JSON.stringify(result)).not.toMatch(/postgres:\/\//);
    expect(JSON.stringify(result)).not.toMatch(/PASSWORD/i);
    expect(result.problems[0]).toContain('authentication failed for user "deploy"');
  });
});

describe('evaluateStartupGate — file/memory boot (development/test)', () => {
  it('is ready without ever probing a database', async () => {
    let probed = false;
    const database = fakeDatabase({
      configured: false,
      healthy: async () => {
        probed = true;
        return false;
      },
    });
    const forFile = await evaluateStartupGate({
      env: env(),
      persistenceBackend: 'file',
      database,
    });
    const forMemory = await evaluateStartupGate({
      env: env({ NODE_ENV: 'test' }),
      persistenceBackend: 'memory',
      database,
    });
    expect(forFile.ok).toBe(true);
    expect(forMemory.ok).toBe(true);
    expect(probed).toBe(false);
  });
});

describe('evaluateStartupGate — production warnings (loud, never fatal)', () => {
  it('warns when production runs the scheduler loop on mock generation defaults', async () => {
    const result = await evaluateStartupGate({
      env: env({
        NODE_ENV: 'production',
        SCHEDULER_ENABLED: 'true',
        AI_IMAGE_PROVIDER: 'mock',
        AI_TEXT_PROVIDER: 'openai',
      }),
      persistenceBackend: 'postgres',
      database: fakeDatabase(),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('MOCK AI generation defaults');
    expect(result.warnings[0]).toContain('image=mock');
    expect(result.warnings[0]).toContain('text=openai');
    expect(result.warnings[0]).toContain('preflight');
  });

  it('does not warn when production has real image AND text defaults', async () => {
    const result = await evaluateStartupGate({
      env: env({
        NODE_ENV: 'production',
        SCHEDULER_ENABLED: 'true',
        AI_IMAGE_PROVIDER: 'openai',
        AI_TEXT_PROVIDER: 'google',
      }),
      persistenceBackend: 'postgres',
      database: fakeDatabase(),
    });
    expect(result.warnings).toEqual([]);
  });

  it('does not warn when the scheduler loop is off or disabled', async () => {
    const off = await evaluateStartupGate({
      env: env({ NODE_ENV: 'production', SCHEDULER_ENABLED: 'false' }),
      persistenceBackend: 'postgres',
      database: fakeDatabase(),
    });
    const disabled = await evaluateStartupGate({
      env: env({ NODE_ENV: 'production', SCHEDULER_ENABLED: 'true', SCHEDULER_MODE: 'disabled' }),
      persistenceBackend: 'postgres',
      database: fakeDatabase(),
    });
    expect(off.warnings).toEqual([]);
    expect(disabled.warnings).toEqual([]);
  });

  it('never warns in development (mock is the expected default there)', async () => {
    const result = await evaluateStartupGate({
      env: env({ NODE_ENV: 'development', SCHEDULER_ENABLED: 'true' }),
      persistenceBackend: 'file',
      database: fakeDatabase(),
    });
    expect(result.warnings).toEqual([]);
  });
});
