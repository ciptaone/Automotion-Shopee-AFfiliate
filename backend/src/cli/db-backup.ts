/**
 * `npm run db:backup` — logical, read-only data backup (Part 9 §7).
 *
 * Exports every `public` table as JSON plus `manifest.json` into a target
 * directory. SELECTs only; nothing is written to the database. For the
 * canonical `pg_dump` procedure (recommended when the binary is available),
 * see docs/implementation/part-09-backup-restore-runbook.md.
 *
 * Usage:
 *   npm run db:backup -- --out /path/to/backup-dir
 *   npm run db:backup            (defaults to backend/tmp/backup-<timestamp>)
 *
 * Exit codes:
 *   0  backup written and manifest recorded
 *   1  export failed (message sanitized)
 *   2  configuration error (DATABASE_URL not set, database unreachable)
 *
 * The output directory contains sensitive operational data — store it with
 * 0600 permissions and encrypt it at rest (runbook §Handling).
 */
import path from 'node:path';
import { loadDotEnv } from '../core/dotenv.js';
import { createDatabaseHandle, sanitizeDatabaseError } from '../db/client.js';
import { createBackup, describeManifest } from '../db/backup.js';

function parseOutDir(argv: readonly string[]): string {
  const index = argv.findIndex((arg) => arg === '--out');
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1] as string);
  const inline = argv.find((arg) => arg.startsWith('--out='));
  if (inline) return path.resolve(inline.slice('--out='.length));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(process.cwd(), 'tmp', `backup-${stamp}`);
}

async function main(): Promise<number> {
  loadDotEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error('DATABASE_URL is not set. Set it server-side and retry.');
    return 2;
  }

  const outDir = parseOutDir(process.argv.slice(2));
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
    console.log('Backup (read-only) — exporting public tables as JSON.');
    const manifest = await createBackup({ raw: handle.raw, outDir, log: (line) => console.log(line) });
    console.log(`RESULT: OK — ${describeManifest(manifest)}`);
    console.log(`  written to: ${outDir}`);
    console.log('  treat this directory as sensitive (row data + encrypted secrets).');
    return 0;
  } catch (error) {
    console.error(`db:backup failed: ${sanitizeDatabaseError(error)}`);
    return 1;
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`db:backup failed: ${sanitizeDatabaseError(error)}`);
    process.exit(1);
  },
);
