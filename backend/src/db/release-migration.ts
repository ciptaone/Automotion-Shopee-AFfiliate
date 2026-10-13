/**
 * Release migration runner (Part 9 §4).
 *
 * Production schema changes happen HERE, once per release, never implicitly at
 * application boot:
 *
 *   1. pre-check the migration status WITHOUT the lock (fast refusal);
 *   2. take a dedicated PostgreSQL advisory lock (`autopilot_schema_migration`)
 *      so concurrent release steps serialize — two instances can never race to
 *      execute the same journal entry (a late arrival waits, re-checks, and
 *      reports "already current");
 *   3. REFUSE to touch a database that is drifted (application tables without
 *      bookkeeping), diverged, has unknown applied records, or is missing
 *      journal files — this path never drops, resets or recreates anything;
 *      forward-fix migrations only;
 *   4. apply pending journal entries with the drizzle-orm runtime migrator;
 *   5. re-read the status and REQUIRE full consistency before releasing the
 *      lock.
 *
 * Exported from `src/db/` (not the CLI) so the PostgreSQL test suite can
 * exercise the real flow against scratch databases: fresh apply, concurrent
 * serialization and drift refusal.
 */
import type postgres from 'postgres';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { MIGRATIONS_FOLDER, sanitizeDatabaseError, type Database } from './client.js';
import { loadMigrationStatus, type MigrationStatusReport } from './migration-status.js';

export const MIGRATION_LOCK_NAME = 'autopilot_schema_migration';
const DEFAULT_LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 300;

export class MigrationRefusedError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Migration refused: ${problems.join('; ')}`);
    this.name = 'MigrationRefusedError';
    this.problems = problems;
  }
}

export interface ReleaseMigrationOptions {
  readonly raw: postgres.Sql;
  readonly db: Database;
  readonly migrationsFolder?: string;
  readonly lockName?: string;
  /** How long to wait for a concurrent release step (default 60 s). */
  readonly lockWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ReleaseMigrationOutcome {
  /** Journal entries applied by THIS run. */
  readonly applied: number;
  /** True when the schema was already current (nothing to do). */
  readonly alreadyCurrent: boolean;
  /** Post-verification status (always `consistent` when this resolves). */
  readonly status: MigrationStatusReport;
}

type Query = <T>(text: string, params?: readonly unknown[]) => Promise<readonly T[]>;

function queryFrom(raw: postgres.Sql): Query {
  return async <T>(text: string, params: readonly unknown[] = []): Promise<readonly T[]> =>
    (await raw.unsafe(text, params as never[])) as unknown as readonly T[];
}

/**
 * Refusal conditions: anything that needs a human, not a migration.
 * The status engine records drift/divergence/unknown/missing-file in
 * `problems`; a merely PENDING (fresh) database produces notes instead, so it
 * is never refused.
 */
function refusalProblems(report: MigrationStatusReport): string[] {
  return [...report.problems];
}

async function acquireLock(
  raw: postgres.Sql,
  lockName: string,
  waitMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<(() => Promise<void>) | null> {
  const connection = (await raw.reserve()) as postgres.Sql & { release(): void };
  const deadline = Date.now() + waitMs;
  let held = false;
  try {
    for (;;) {
      const rows = (await connection`select pg_try_advisory_lock(hashtext(${lockName})) as locked`) as unknown as {
        locked: boolean;
      }[];
      if (rows[0]?.locked === true) {
        held = true;
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(LOCK_POLL_MS);
    }
  } catch (error) {
    connection.release();
    throw new Error(`migration lock could not be taken: ${sanitizeDatabaseError(error)}`);
  }

  if (!held) {
    connection.release();
    return null;
  }

  return async () => {
    try {
      await connection`select pg_advisory_unlock(hashtext(${lockName}))`;
    } catch {
      /* the session is going away anyway */
    } finally {
      try {
        connection.release();
      } catch {
        /* ignore */
      }
    }
  };
}

/**
 * Apply pending migrations under the release lock and verify consistency.
 * Throws `MigrationRefusedError` (nothing executed) on drift/divergence or
 * when verification fails; any other error is an apply failure.
 */
export async function runReleaseMigration(
  options: ReleaseMigrationOptions,
): Promise<ReleaseMigrationOutcome> {
  const {
    raw,
    db,
    migrationsFolder = MIGRATIONS_FOLDER,
    lockName = MIGRATION_LOCK_NAME,
    lockWaitMs = DEFAULT_LOCK_WAIT_MS,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;
  const query = queryFrom(raw);

  // Pre-check WITHOUT the lock (fast refusal for drifted databases).
  const before = await loadMigrationStatus(migrationsFolder, query);
  const preProblems = refusalProblems(before);
  if (preProblems.length > 0) {
    throw new MigrationRefusedError(preProblems);
  }

  const release = await acquireLock(raw, lockName, lockWaitMs, sleep);
  if (!release) {
    throw new MigrationRefusedError([
      `another migration holds the "${lockName}" lock for longer than ${lockWaitMs}ms`,
    ]);
  }

  let applied = 0;
  try {
    // Re-read INSIDE the lock: a concurrent release step may have finished
    // while we waited, in which case there is nothing to do.
    const current = await loadMigrationStatus(migrationsFolder, query);
    const problems = refusalProblems(current);
    if (problems.length > 0) {
      throw new MigrationRefusedError(problems);
    }

    if (!current.consistent) {
      const pending = current.pendingCount;
      await migrate(db, { migrationsFolder });
      applied = pending;
    }

    const after = await loadMigrationStatus(migrationsFolder, query);
    if (!after.consistent) {
      throw new MigrationRefusedError([
        `post-migration verification failed: ${after.problems.join('; ') || 'schema still not consistent'}`,
      ]);
    }

    return { applied, alreadyCurrent: applied === 0, status: after };
  } finally {
    await release();
  }
}
