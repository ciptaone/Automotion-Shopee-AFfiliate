/**
 * Logical backup + restore of application DATA (Part 9 §7).
 *
 * Why this exists alongside `pg_dump`: this environment (like some
 * locked-down hosts) has no `pg_dump` binary, while the repository's actual
 * tooling is Node + PostgreSQL. The runbook documents `pg_dump` as the
 * canonical procedure; this module is the repo-native path that CAN be drilled
 * end-to-end here:
 *
 *   - schema is CODE (the committed Drizzle journal) — the restore target is
 *     migrated with `runReleaseMigration` first, never by the backup;
 *   - backup  = read-only JSON export of every `public` base table plus a
 *     manifest (row counts, journal state, PostgreSQL version);
 *   - restore = INSERTs into a freshly migrated, EMPTY database, parents
 *     before children (FK order read from the live catalog), followed by a
 *     row-count verification against the manifest.
 *
 * Safety properties (tested):
 *   - `createBackup` only ever runs SELECTs;
 *   - `restoreBackup` REFUSES a target that is not schema-consistent or that
 *     already contains rows in a table present in the backup — it never
 *     truncates, drops or overwrites;
 *   - a row-count mismatch after load fails the restore loudly;
 *   - output never contains connection strings or credential values (the
 *     manifest records the database NAME and version only).
 *
 * `provider_secrets` rows are AES-256-GCM ciphertext whose key lives in
 * `SECRETS_ENCRYPTION_KEY` — the runbook requires backing that key up
 * SEPARATELY, because a database backup without the key cannot decrypt it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';
import { MIGRATIONS_FOLDER, sanitizeDatabaseError } from './client.js';
import { loadMigrationStatus, type MigrationStatusReport } from './migration-status.js';

export const BACKUP_FORMAT = 'autopilot-db-backup/1';

export interface BackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly createdAt: string;
  /** Database NAME only — never a host, user or password. */
  readonly database: string;
  readonly postgresVersion: string;
  readonly schemaConsistent: boolean;
  readonly journalEntries: number;
  readonly migrationsApplied: number;
  /** table -> exported row count. */
  readonly tables: Readonly<Record<string, number>>;
}

type Query = <T>(text: string, params?: readonly unknown[]) => Promise<readonly T[]>;

function queryFrom(raw: postgres.Sql): Query {
  return async <T>(text: string, params: readonly unknown[] = []): Promise<readonly T[]> =>
    (await raw.unsafe(text, params as never[])) as unknown as readonly T[];
}

/** Every base table in `public`, alphabetical. */
export async function listPublicTables(query: Query): Promise<string[]> {
  const rows = await query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function readRows(query: Query, table: string): Promise<Record<string, unknown>[]> {
  const rows = await query<{ rows: Record<string, unknown>[] | null }>(
    `select coalesce(json_agg(t), '[]'::json) as rows from public."${table}" t`,
  );
  return rows[0]?.rows ?? [];
}

/* -------------------------------------------------------------------------- */
/*  Backup                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateBackupOptions {
  readonly raw: postgres.Sql;
  readonly outDir: string;
  readonly migrationsFolder?: string;
  readonly log?: (line: string) => void;
}

/**
 * Export every `public` table to `<outDir>/{manifest.json,<table>.json}`.
 * Read-only: SELECTs only. Throws when the directory cannot be written.
 */
export async function createBackup(options: CreateBackupOptions): Promise<BackupManifest> {
  const { raw, outDir, migrationsFolder = MIGRATIONS_FOLDER, log } = options;
  const query = queryFrom(raw);

  const status: MigrationStatusReport = await loadMigrationStatus(migrationsFolder, query);
  const meta = await query<{ version: string; current_database: string }>(
    `select version() as version, current_database() as current_database`,
  );
  const versionLine = meta[0]?.version ?? 'unknown';
  const serverVersion = versionLine.split(' ').slice(0, 2).join(' ') || 'unknown';

  const tables = await listPublicTables(query);
  const counts: Record<string, number> = {};
  await mkdir(outDir, { recursive: true });

  for (const table of tables) {
    const rows = await readRows(query, table);
    counts[table] = rows.length;
    await writeFile(path.join(outDir, `${table}.json`), JSON.stringify(rows), 'utf8');
    log?.(`  exported ${table}: ${rows.length} row(s)`);
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    database: meta[0]?.current_database ?? 'unknown',
    postgresVersion: serverVersion,
    schemaConsistent: status.consistent,
    journalEntries: status.journalEntries,
    migrationsApplied: status.appliedCount,
    tables: counts,
  };
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  log?.(`  manifest written: ${tables.length} table(s), ${total} row(s) total`);
  return manifest;
}

/* -------------------------------------------------------------------------- */
/*  Restore                                                                   */
/* -------------------------------------------------------------------------- */

export class RestoreRefusedError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Restore refused: ${problems.join('; ')}`);
    this.name = 'RestoreRefusedError';
    this.problems = problems;
  }
}

export interface RestoreBackupOptions {
  readonly raw: postgres.Sql;
  readonly inDir: string;
  readonly migrationsFolder?: string;
  readonly log?: (line: string) => void;
  /** Rows per INSERT statement (bounded memory). */
  readonly chunkSize?: number;
}

export interface RestoreReport {
  readonly tablesLoaded: number;
  readonly rowsInserted: number;
  readonly emptyTablesSkipped: number;
  readonly manifest: BackupManifest;
  /** Verified row counts after load (equal to the manifest on success). */
  readonly verified: Readonly<Record<string, number>>;
}

/** Parent-first ordering derived from the live FK catalog (handles cycles). */
export async function fkDependencyOrder(query: Query, tables: readonly string[]): Promise<string[]> {
  const rows = await query<{ child: string; parent: string }>(
    `select tc.table_name as child, ccu.table_name as parent
     from information_schema.table_constraints tc
     join information_schema.constraint_column_usage ccu
       on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
     where tc.constraint_type = 'FOREIGN KEY'
       and tc.table_schema = 'public'
       and tc.table_name <> ccu.table_name`,
  );
  const deps = new Map<string, Set<string>>();
  for (const table of tables) deps.set(table, new Set());
  for (const row of rows) {
    if (deps.has(row.child) && deps.has(row.parent)) deps.get(row.child)?.add(row.parent);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (table: string): void => {
    if (placed.has(table)) return;
    if (visiting.has(table)) return; // cycle: break it, catalog order decides
    visiting.add(table);
    for (const parent of deps.get(table) ?? []) visit(parent);
    visiting.delete(table);
    placed.add(table);
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
}

async function tableRowCount(query: Query, table: string): Promise<number> {
  const rows = await query<{ count: number }>(`select count(*)::int as count from public."${table}"`);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Load a backup into the CURRENT database. Refuses unless the schema is
 * consistent and every overlapping table is empty — this function cannot
 * destroy data.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreReport> {
  const {
    raw,
    inDir,
    migrationsFolder = MIGRATIONS_FOLDER,
    log,
    chunkSize = 200,
  } = options;
  const query = queryFrom(raw);

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(path.join(inDir, 'manifest.json'), 'utf8')) as BackupManifest;
  } catch (error) {
    throw new RestoreRefusedError([
      `manifest.json unreadable at ${inDir}: ${sanitizeDatabaseError(error)}`,
    ]);
  }
  if (manifest.format !== BACKUP_FORMAT) {
    throw new RestoreRefusedError([`unsupported backup format "${String(manifest.format)}"`]);
  }

  // The target must already be migrated (schema is code, never restored).
  const status = await loadMigrationStatus(migrationsFolder, query);
  if (!status.consistent) {
    throw new RestoreRefusedError([
      'target schema is not consistent — run `npm run db:migrate` first',
      ...status.problems,
    ]);
  }

  const targetTables = await listPublicTables(query);
  const manifestTables = Object.keys(manifest.tables);

  // Never overwrite: any non-empty overlapping table refuses the restore.
  const nonEmpty: string[] = [];
  for (const table of manifestTables) {
    if (!targetTables.includes(table)) {
      throw new RestoreRefusedError([`target schema is missing table "${table}" (backup is from a different schema)`]);
    }
    if ((await tableRowCount(query, table)) > 0) nonEmpty.push(table);
  }
  if (nonEmpty.length > 0) {
    throw new RestoreRefusedError([
      `target already contains rows in: ${nonEmpty.join(', ')} — restore only into an empty database`,
    ]);
  }

  const order = await fkDependencyOrder(query, manifestTables);
  let rowsInserted = 0;
  let tablesLoaded = 0;
  let emptySkipped = 0;

  for (const table of order) {
    const rows = JSON.parse(
      await readFile(path.join(inDir, `${table}.json`), 'utf8'),
    ) as Record<string, unknown>[];
    if (rows.length === 0) {
      emptySkipped += 1;
      continue;
    }
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const columnList = columns.map((column) => `"${column}"`).join(', ');
    for (let offset = 0; offset < rows.length; offset += chunkSize) {
      const chunk = rows.slice(offset, offset + chunkSize);
      const values: unknown[] = [];
      const tuples = chunk
        .map((row) => {
          const placeholders = columns.map((column) => {
            values.push(row[column] ?? null);
            return `$${values.length}`;
          });
          return `(${placeholders.join(', ')})`;
        })
        .join(', ');
      await raw.unsafe(
        `insert into public."${table}" (${columnList}) values ${tuples}`,
        values as never[],
      );
    }
    rowsInserted += rows.length;
    tablesLoaded += 1;
    log?.(`  restored ${table}: ${rows.length} row(s)`);
  }

  // Verify: counts must match the manifest exactly.
  const verified: Record<string, number> = {};
  const mismatches: string[] = [];
  for (const table of manifestTables) {
    const count = await tableRowCount(query, table);
    verified[table] = count;
    if (count !== manifest.tables[table]) {
      mismatches.push(`${table}: expected ${manifest.tables[table]}, found ${count}`);
    }
  }
  if (mismatches.length > 0) {
    throw new RestoreRefusedError([`post-restore verification failed — ${mismatches.join('; ')}`]);
  }

  log?.(`  verification OK: ${manifestTables.length} table(s), ${rowsInserted} row(s)`);
  return { tablesLoaded, rowsInserted, emptyTablesSkipped: emptySkipped, manifest, verified };
}

/** Secret-free summary for CLI output. */
export function describeManifest(manifest: BackupManifest): string {
  const total = Object.values(manifest.tables).reduce((sum, count) => sum + count, 0);
  return (
    `${manifest.createdAt} · db=${manifest.database} · ${manifest.postgresVersion} · ` +
    `${manifest.migrationsApplied}/${manifest.journalEntries} migrations` +
    `${manifest.schemaConsistent ? '' : ' (SCHEMA INCONSISTENT)'} · ` +
    `${Object.keys(manifest.tables).length} table(s), ${total} row(s)`
  );
}
