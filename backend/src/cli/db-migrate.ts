/**
 * `npm run db:migrate` — THE release migration step (Part 9 §4).
 *
 * Thin CLI over `runReleaseMigration` (src/db/release-migration.ts), which
 * serializes concurrent release steps with a PostgreSQL advisory lock, refuses
 * drifted databases without executing anything, applies the committed journal
 * forward, and requires full consistency before it reports success.
 *
 * Exit codes:
 *   0  schema consistent (applied now, or already current)
 *   1  refused or failed (drift/divergence, apply error, verification failure)
 *   2  configuration error (DATABASE_URL not set, database unreachable)
 *
 * Output is secret-free: connection problems are sanitized (no DSN, no
 * password) by `sanitizeDatabaseError`.
 */
import { loadDotEnv } from '../core/dotenv.js';
import { createDatabaseHandle, sanitizeDatabaseError } from '../db/client.js';
import { MigrationRefusedError, runReleaseMigration } from '../db/release-migration.js';

async function main(): Promise<number> {
  loadDotEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(
      'DATABASE_URL is not set. Set it server-side (backend/.env for local development) and retry.',
    );
    return 2;
  }

  const handle = createDatabaseHandle(url);
  try {
    if (!(await handle.healthy())) {
      console.error(`Could not reach PostgreSQL: ${await handle.statusDetail()}`);
      return 2;
    }
    const raw = handle.raw;
    const db = handle.db;
    if (!raw || !db) {
      console.error('Database handle is not initialised.');
      return 2;
    }

    console.log('Release migration — applying the committed Drizzle journal.');
    console.log('Refuses drifted databases; never drops, resets or recreates tables.');

    const outcome = await runReleaseMigration({ raw, db });
    if (outcome.alreadyCurrent) {
      console.log(
        `RESULT: schema already current — ${outcome.status.appliedCount}/${outcome.status.journalEntries} migrations applied, consistent.`,
      );
    } else {
      console.log(
        `RESULT: applied ${outcome.applied} migration(s) — ${outcome.status.appliedCount}/${outcome.status.journalEntries} applied, consistent.`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof MigrationRefusedError) {
      console.error('RESULT: REFUSED — the database needs a human; no destructive statement exists in this tool.');
      for (const problem of error.problems) {
        console.error(`  - ${problem}`);
      }
      return 1;
    }
    console.error(`db:migrate failed: ${sanitizeDatabaseError(error)}`);
    return 1;
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`db:migrate failed: ${sanitizeDatabaseError(error)}`);
    process.exit(1);
  },
);
