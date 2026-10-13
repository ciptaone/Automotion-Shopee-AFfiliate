/**
 * `npm run db:restore` — load a logical backup into an EMPTY target database
 * (Part 9 §7).
 *
 * The target (`DATABASE_URL`) must already be migrated (`npm run db:migrate`)
 * and must contain NO rows in any table present in the backup — this tool
 * refuses anything else and can never truncate, drop or overwrite. It inserts
 * parents before children (FK order from the live catalog) and verifies every
 * row count against the manifest before reporting success.
 *
 * NEVER point this at production. The recovery drill targets a disposable,
 * isolated database (runbook §Restore drill).
 *
 * Usage:
 *   npm run db:restore -- --from /path/to/backup-dir
 *
 * Exit codes:
 *   0  restored and verified against the manifest
 *   1  refused or failed (problems listed, no partial "success" claim)
 *   2  configuration error (DATABASE_URL not set, database unreachable)
 */
import path from 'node:path';
import { loadDotEnv } from '../core/dotenv.js';
import { createDatabaseHandle, sanitizeDatabaseError } from '../db/client.js';
import {
  RestoreRefusedError,
  describeManifest,
  restoreBackup,
} from '../db/backup.js';

function parseFromDir(argv: readonly string[]): string | null {
  const index = argv.findIndex((arg) => arg === '--from');
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1] as string);
  const inline = argv.find((arg) => arg.startsWith('--from='));
  if (inline) return path.resolve(inline.slice('--from='.length));
  return null;
}

async function main(): Promise<number> {
  loadDotEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is not set. Point it at the DISPOSABLE restore target, never production.');
    return 2;
  }
  const fromDir = parseFromDir(process.argv.slice(2));
  if (!fromDir) {
    console.error('Usage: npm run db:restore -- --from <backup-directory>');
    return 2;
  }

  const handle = createDatabaseHandle(url);
  try {
    if (!(await handle.healthy())) {
      console.error(`Could not reach PostgreSQL: ${await handle.statusDetail()}`);
      return 2;
    }
    if (!handle.raw) {
      console.error('Database handle is not initialised.');
      return 2;
    }
    console.log('Restore — target must be migrated and empty; nothing will be overwritten.');
    const report = await restoreBackup({
      raw: handle.raw,
      inDir: fromDir,
      log: (line) => console.log(line),
    });
    console.log(
      `RESULT: OK — restored ${report.rowsInserted} row(s) into ${report.tablesLoaded} table(s); verified against manifest.`,
    );
    console.log(`  source: ${describeManifest(report.manifest)}`);
    return 0;
  } catch (error) {
    if (error instanceof RestoreRefusedError) {
      console.error('RESULT: REFUSED — no data was written.');
      for (const problem of error.problems) {
        console.error(`  - ${problem}`);
      }
      return 1;
    }
    console.error(`db:restore failed: ${sanitizeDatabaseError(error)}`);
    return 1;
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`db:restore failed: ${sanitizeDatabaseError(error)}`);
    process.exit(1);
  },
);
