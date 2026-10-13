/**
 * `npm run db:status` — is this database migrated, and did anything drift?
 *
 * Reads `drizzle/meta/_journal.json` (the same file `drizzle-kit migrate`
 * reads), compares it with the rows recorded in `drizzle.__drizzle_migrations`,
 * and checks that the recorded hash still matches the .sql file on disk.
 *
 * Exit codes (usable from CI / deploy scripts):
 *   0  every journal entry is applied and unmodified
 *   2  DATABASE_URL is not set
 *   3  migrations are pending (run `npm run db:migrate`)
 *   4  drift detected (a migration file changed after it was applied, a file is
 *      missing, the database holds a record with no journal entry, or
 *      application tables exist without any migration bookkeeping)
 *   1  the database could not be reached / unexpected error
 *
 * Never prints credentials: the URL itself is never echoed, and every message
 * goes through `sanitizeDatabaseError`.
 */
import { createDatabaseHandle, sanitizeDatabaseError } from '../db/client.js';
import { loadDotEnv } from '../core/dotenv.js';
import type { MigrationEntryStatus } from '../db/migration-status.js';

const MARK: Record<string, string> = {
  applied: '[applied]',
  pending: '[pending]',
  diverged: '[DRIFTED]',
  missing_file: '[MISSING]',
  unreadable: '[UNREADABLE]',
  unknown: '[UNKNOWN]',
};

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

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
    const healthy = await handle.healthy();
    if (!healthy) {
      console.error(`Could not reach PostgreSQL: ${await handle.statusDetail()}`);
      return 1;
    }

    const status = await handle.migrationStatus();
    if (!status) {
      console.error('Migration status could not be read from the database.');
      return 1;
    }

    console.log(`migrations folder : ${status.migrationsFolder}`);
    console.log(`journal entries   : ${status.journalEntries}`);
    console.log(`applied records   : ${status.appliedRows}`);
    console.log(`bookkeeping table : ${status.tablePresent ? 'present' : 'absent'}\n`);

    const width = Math.max(4, ...status.entries.map((entry: MigrationEntryStatus) => entry.tag.length));
    for (const entry of status.entries) {
      console.log(
        `${MARK[entry.state] ?? entry.state} ${pad(entry.tag, width)}  ${entry.detail}`,
      );
    }

    for (const extra of status.unknownApplied) {
      console.log(`[UNKNOWN]       applied record with no journal entry (created_at=${extra.when})`);
    }

    if (status.notes.length > 0) {
      for (const note of status.notes) console.log(`\nnote: ${note}`);
    }

    if (status.problems.length > 0) {
      console.log('\nproblems:');
      for (const problem of status.problems) console.log(`  - ${problem}`);
    }

    if (status.consistent) {
      console.log('\nRESULT: database schema matches the committed migrations.');
      return 0;
    }
    if (status.divergedCount > 0 || status.unknownApplied.length > 0 || status.problems.length > 0) {
      console.log(
        '\nRESULT: drift detected. Do NOT re-edit an applied migration — add a new one ' +
          '(`npm run db:generate`) and re-run this command.',
      );
      return 4;
    }
    console.log('\nRESULT: migrations are pending — run `npm run db:migrate`.');
    return 3;
  } catch (error) {
    console.error(`db:status failed: ${sanitizeDatabaseError(error)}`);
    return 1;
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`db:status failed: ${sanitizeDatabaseError(error)}`);
    process.exit(1);
  },
);
