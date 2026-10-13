/**
 * PART 9 §4 — release migration runner against REAL scratch databases.
 *
 * The unit suite cannot prove that a PostgreSQL advisory lock serializes two
 * concurrent release steps, so every test here creates its own throwaway
 * database on the test cluster (never the shared autopilot_test schema):
 *
 *  - fresh apply: a brand-new database is migrated by the runner, verified
 *    consistent, bookkeeping recorded exactly once per journal entry, and a
 *    second run reports "already current" (idempotent release step);
 *  - concurrency: two simultaneous release runs on the same fresh database
 *    BOTH succeed, exactly one applies, and the bookkeeping never records a
 *    journal entry twice (advisory lock + in-lock re-check);
 *  - drift refusal: a database with hand-created tables is refused BEFORE any
 *    statement runs — no table is dropped, no journal entry applied;
 *  - the lock name the deployment runbook documents is pinned.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import {
  MIGRATION_LOCK_NAME,
  MigrationRefusedError,
  runReleaseMigration,
} from '../../src/db/release-migration.js';
import { testDatabaseUrl } from './helpers.js';

/* -------------------------------------------------------------------------- */
/*  Scratch databases                                                         */
/* -------------------------------------------------------------------------- */

const dropped: (() => Promise<void>)[] = [];

interface Scratch {
  readonly url: string;
}

async function createScratch(): Promise<Scratch> {
  const name = `part9_mig_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;

  const admin = postgres(testDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  dropped.push(async () => {
    const cleanup = postgres(testDatabaseUrl(), { max: 1 });
    try {
      await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
    } finally {
      await cleanup.end({ timeout: 5 });
    }
  });

  return { url: url.toString() };
}

async function bookkeepingCount(raw: postgres.Sql): Promise<number> {
  const rows = (await raw.unsafe(
    'select count(*)::int as count from drizzle.__drizzle_migrations',
  )) as unknown as { count: number }[];
  return rows[0]?.count ?? -1;
}

afterAll(async () => {
  for (const drop of dropped.splice(0)) await drop();
});

/* -------------------------------------------------------------------------- */
/*  Fresh apply                                                               */
/* -------------------------------------------------------------------------- */

describe('runReleaseMigration — fresh database', () => {
  it('applies the whole chain once and is a no-op on the next run', async () => {
    const scratch = await createScratch();
    const { db, raw } = createDatabase(scratch.url);
    try {
      const outcome = await runReleaseMigration({ raw, db });
      expect(outcome.alreadyCurrent).toBe(false);
      expect(outcome.applied).toBe(outcome.status.journalEntries);
      expect(outcome.applied).toBeGreaterThan(0);
      expect(outcome.status.consistent).toBe(true);
      expect(outcome.status.pendingCount).toBe(0);

      // Exactly one bookkeeping row per journal entry — applied once.
      expect(await bookkeepingCount(raw)).toBe(outcome.applied);

      // The application tables really exist (>= the 13 known base tables).
      const tables = (await raw.unsafe(
        `select count(*)::int as count from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'`,
      )) as unknown as { count: number }[];
      expect(tables[0]?.count).toBeGreaterThanOrEqual(13);

      // Second run (redeploy / repeated release step): idempotent no-op.
      const second = await runReleaseMigration({ raw, db });
      expect(second.applied).toBe(0);
      expect(second.alreadyCurrent).toBe(true);
      expect(second.status.consistent).toBe(true);
      expect(await bookkeepingCount(raw)).toBe(outcome.applied);
    } finally {
      await raw.end({ timeout: 5 });
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Concurrent release steps                                                  */
/* -------------------------------------------------------------------------- */

describe('runReleaseMigration — concurrent release steps', () => {
  it('serializes two simultaneous runs: both succeed, one applies, none twice', async () => {
    const scratch = await createScratch();
    const a = createDatabase(scratch.url);
    const b = createDatabase(scratch.url);
    try {
      const [first, second] = await Promise.all([
        runReleaseMigration({ raw: a.raw, db: a.db }),
        runReleaseMigration({ raw: b.raw, db: b.db }),
      ]);

      // Neither run failed: a late arrival waits for the lock, re-checks and
      // reports "already current" instead of racing or erroring.
      expect(first.status.consistent).toBe(true);
      expect(second.status.consistent).toBe(true);
      expect(first.applied + second.applied).toBe(first.status.journalEntries);

      // Exactly one of the two actually migrated.
      const alreadyCurrent = [first.alreadyCurrent, second.alreadyCurrent];
      expect(alreadyCurrent.filter(Boolean)).toHaveLength(1);

      // No journal entry was recorded twice across both runs.
      expect(await bookkeepingCount(a.raw)).toBe(first.status.journalEntries);
    } finally {
      await Promise.all([a.raw.end({ timeout: 5 }), b.raw.end({ timeout: 5 })]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Drift refusal — never destructive                                         */
/* -------------------------------------------------------------------------- */

describe('runReleaseMigration — drift refusal', () => {
  it('refuses a database with hand-created tables and touches nothing', async () => {
    const scratch = await createScratch();
    const { db, raw } = createDatabase(scratch.url);
    try {
      // Somebody created a table outside the tool (restored dump, manual DDL).
      await raw.unsafe('create table part9_drift_probe (id int primary key, note text)');
      await raw.unsafe(`insert into part9_drift_probe (id, note) values (1, 'keep me')`);

      const error = await runReleaseMigration({ raw, db }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(MigrationRefusedError);
      const refused = error as MigrationRefusedError;
      expect(refused.problems.join(' ')).toContain('__drizzle_migrations');
      expect(refused.message).toContain('Migration refused');

      // NOTHING was applied or destroyed: the bookkeeping table was never
      // created (to_regclass on a missing relation is NULL, not an error).
      const bookkeeping = (await raw.unsafe(
        `select to_regclass('drizzle.__drizzle_migrations') as t`,
      )) as unknown as { t: string | null }[];
      expect(bookkeeping[0]?.t).toBeNull();
      const probe = (await raw.unsafe(
        'select id, note from part9_drift_probe order by id',
      )) as unknown as { id: number; note: string }[];
      expect(probe).toEqual([{ id: 1, note: 'keep me' }]);
    } finally {
      await raw.end({ timeout: 5 });
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Documented contract                                                       */
/* -------------------------------------------------------------------------- */

describe('release migration contract', () => {
  it('pins the advisory lock name used by the deployment runbook', () => {
    expect(MIGRATION_LOCK_NAME).toBe('autopilot_schema_migration');
  });
});
