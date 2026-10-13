/**
 * Shared plumbing for the PostgreSQL integration suite (PART 5).
 *
 * Every helper here talks to the ISOLATED local cluster started by
 * `npm run test:db`. There are no production credentials anywhere in this
 * suite, and no helper ever calls an external API.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDatabase, type Database } from '../../src/db/client.js';

/** Connection string for the throwaway test cluster. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Run this suite with `npm run test:db` ' +
        '(it boots an isolated PostgreSQL and sets the variable).',
    );
  }
  return url;
}

export interface TestDatabase {
  readonly db: Database;
  /** Raw handle, for arbitrary parameterised catalog queries in assertions. */
  readonly raw: postgres.Sql;
  close(): Promise<void>;
}

/** A fresh connection pool against the test cluster. */
export function openTestDatabase(): TestDatabase {
  const { db, raw } = createDatabase(testDatabaseUrl());
  return {
    db,
    raw,
    async close() {
      await raw.end({ timeout: 5 });
    },
  };
}

/**
 * Wipe every application table between tests.
 *
 * `restart identity` keeps sequence values predictable; `cascade` is safe here
 * because the whole schema belongs to the test.
 */
export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(sql`
    truncate table
      jobs, slot_contents, publish_runs, products, import_batches,
      app_settings, scheduler_checkpoints, notifications, api_clients,
      provider_workspaces, provider_secrets, generation_usage
    restart identity cascade`);
}

/** Random unique key so parallel-agnostic tests never collide on a retry. */
export function uniqueKey(prefix = 'test'): string {
  return `${prefix}-${randomUUID()}`;
}

/** Wait until `predicate` is true or the timeout elapses (lease expiry tests). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(options.message ?? `condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Minimal ISO timestamp helper (UTC, as at every persistence boundary). */
export function isoNow(): string {
  return new Date().toISOString();
}
