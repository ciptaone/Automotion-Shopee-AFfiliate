/**
 * Database connection lifecycle.
 *
 * Part 1: connectivity is verified LAZILY. When `DATABASE_URL` is absent the
 * app runs fully functional in in-memory mode (mock storage, in-memory queue),
 * and `/health` reports Postgres as `not_configured`.
 *
 * When a URL IS present, `connectDatabase()` establishes a pooled connection and
 * `checkDatabaseHealth()` performs a real round-trip. Connection failures are
 * surfaced as degraded health, never as a crash, so the APK can still reach the
 * dashboard to see what is wrong.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  loadMigrationStatus,
  type MigrationStatusReport,
} from './migration-status.js';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Repository migrations folder, resolved by walking up from this module until
 * `drizzle/meta/_journal.json` is found. This works in BOTH layouts the repo
 * runs from: `src/db/` under tsx (dev) and `dist/src/db/` under plain node
 * (production), where a naive `../../drizzle` would point inside `dist/`.
 */
function resolveMigrationsFolder(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'drizzle');
    if (existsSync(path.join(candidate, 'meta', '_journal.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort (keeps the historic relative path): callers treat an unreadable
  // folder as "migration status could not be read" and fail closed.
  return fileURLToPath(new URL('../../drizzle', import.meta.url));
}

export const MIGRATIONS_FOLDER = resolveMigrationsFolder();

/**
 * Bounded connection pool: a runaway pool is an outage, so the ceiling is
 * small and explicit. `prepare: false` keeps postgres.js in its safe protocol
 * mode (required behind pgbouncer-style proxies).
 */
export const POOL_OPTIONS = {
  max: 5,
  connect_timeout: 10,
  idle_timeout: 30,
  max_lifetime: 300,
  prepare: false,
} as const;

/** PART 9 §3: operator-tunable pool bounds (validated by env.ts). */
export interface PoolLimits {
  readonly min?: number;
  readonly max?: number;
}

export interface DatabaseHandle {
  readonly db: Database | null;
  /** Raw postgres.js handle (needed for connection-scoped primitives like
   *  advisory locks). Null when no database is configured. */
  readonly raw: ReturnType<typeof postgres> | null;
  readonly configured: boolean;
  /** True after a successful round-trip. */
  healthy(): Promise<boolean>;
  /** Human-readable, secret-free status detail. */
  statusDetail(): Promise<string>;
  /**
   * PART 5: read the migration journal and compare it with what this database
   * actually has applied (null when no database is configured).
   */
  migrationStatus(): Promise<MigrationStatusReport | null>;
  close(): Promise<void>;
}

/**
 * Strip credentials from anything derived from a connection string so an error
 * message can be logged, returned by `/health` and pasted into an issue.
 */
export function sanitizeDatabaseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .split('\n')[0]
    ?.replace(/postgres(ql)?:\/\/[^\s'"]*/gi, 'postgres://[REDACTED]')
    ?.slice(0, 160) ?? 'database error';
}

/** Build a Drizzle client from a postgres.js connection. */
export function createDatabase(
  databaseUrl: string,
  limits?: PoolLimits,
): { db: Database; raw: ReturnType<typeof postgres> } {
  const raw = postgres(databaseUrl, {
    ...POOL_OPTIONS,
    ...(limits?.min !== undefined ? { min: limits.min } : {}),
    ...(limits?.max !== undefined ? { max: limits.max } : {}),
  });
  const db = drizzle(raw, { schema });
  return { db, raw };
}

/**
 * Create a database handle. Returns a null-handle when no URL is configured.
 * Does NOT connect eagerly — call `healthy()` when a round-trip is needed.
 */
export function createDatabaseHandle(
  databaseUrl: string | undefined,
  limits?: PoolLimits,
): DatabaseHandle {
  if (!databaseUrl) {
    return {
      db: null,
      raw: null,
      configured: false,
      async healthy() {
        return false;
      },
      async statusDetail() {
        return 'DATABASE_URL not set — running in in-memory mode.';
      },
      async migrationStatus() {
        return null;
      },
      async close() {
        /* nothing to close */
      },
    };
  }

  let raw: ReturnType<typeof postgres> | null = null;
  let db: Database | null = null;

  try {
    const created = createDatabase(databaseUrl, limits);
    raw = created.raw;
    db = created.db;
  } catch {
    raw = null;
    db = null;
  }

  return {
    db,
    raw,
    configured: true,
    async healthy() {
      if (!raw) {
        return false;
      }
      try {
        await raw`select 1`;
        return true;
      } catch {
        return false;
      }
    },
    async statusDetail() {
      if (!raw) {
        return 'DATABASE_URL set but the client could not be initialized.';
      }
      try {
        await raw`select 1`;
        return 'PostgreSQL reachable.';
      } catch (error) {
        // Connection errors can embed the DSN; keep only the first line, redacted.
        return `PostgreSQL unreachable: ${sanitizeDatabaseError(error)}`;
      }
    },
    async migrationStatus() {
      if (!raw) return null;
      try {
        return await loadMigrationStatus(MIGRATIONS_FOLDER, (text, params) =>
          raw.unsafe(text, (params ?? []) as never[]),
        );
      } catch {
        // Status is diagnostic only; never let it crash a caller.
        return null;
      }
    },
    async close() {
      if (raw) {
        try {
          await raw.end({ timeout: 5 });
        } catch {
          /* ignore shutdown errors */
        }
      }
    },
  };
}
