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
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly db: Database | null;
  readonly configured: boolean;
  /** True after a successful round-trip. */
  healthy(): Promise<boolean>;
  /** Human-readable, secret-free status detail. */
  statusDetail(): Promise<string>;
  close(): Promise<void>;
}

/** Build a Drizzle client from a postgres.js connection. */
export function createDatabase(databaseUrl: string): { db: Database; raw: ReturnType<typeof postgres> } {
  const raw = postgres(databaseUrl, { max: 5, prepare: false });
  const db = drizzle(raw, { schema });
  return { db, raw };
}

/**
 * Create a database handle. Returns a null-handle when no URL is configured.
 * Does NOT connect eagerly — call `healthy()` when a round-trip is needed.
 */
export function createDatabaseHandle(databaseUrl: string | undefined): DatabaseHandle {
  if (!databaseUrl) {
    return {
      db: null,
      configured: false,
      async healthy() {
        return false;
      },
      async statusDetail() {
        return 'DATABASE_URL not set — running in in-memory mode.';
      },
      async close() {
        /* nothing to close */
      },
    };
  }

  let raw: ReturnType<typeof postgres> | null = null;
  let db: Database | null = null;

  try {
    const created = createDatabase(databaseUrl);
    raw = created.raw;
    db = created.db;
  } catch {
    raw = null;
    db = null;
  }

  return {
    db,
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
        const message = error instanceof Error ? error.message : 'unknown error';
        // Connection errors can embed the DSN; keep only the first line, redacted.
        return `PostgreSQL unreachable: ${message.split('\n')[0]?.slice(0, 120) ?? 'error'}`;
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
