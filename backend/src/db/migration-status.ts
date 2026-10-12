/**
 * Migration status (Part 5) — "what is applied, what is pending, what drifted".
 *
 * Three layers, deliberately separated so the logic can be tested without a
 * database:
 *
 *   1. `readJournal()` / `readMigrationFiles()` — read `drizzle/meta/_journal.json`
 *      and the SQL files it points at (this is exactly what `drizzle-kit
 *      migrate` and drizzle-orm's runtime migrator read).
 *   2. `computeMigrationStatus()` — PURE: compare journal + files against the
 *      rows the migrator recorded in `drizzle.__drizzle_migrations`.
 *   3. `loadMigrationStatus()` — runs (2) against a live connection.
 *
 * Why the hash check matters: drizzle only compares `created_at` (the journal
 * `when` value) when deciding what to run, so a migration file edited AFTER it
 * was applied would be silently ignored. `computeMigrationStatus` compares the
 * SHA-256 of the file with the recorded hash and reports `diverged` instead.
 *
 * States reported per journal entry:
 *   applied      — recorded in the DB and the file still hashes the same
 *   pending      — in the journal, not yet recorded in the DB
 *   diverged     — recorded in the DB, but the file changed since
 *   missing_file — in the journal, but the .sql file is gone
 *   unknown      — recorded in the DB but no longer in the journal
 *   unreadable   — the file could not be read
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const MIGRATIONS_TABLE_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

export interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

export type MigrationState =
  | 'applied'
  | 'pending'
  | 'diverged'
  | 'missing_file'
  | 'unreadable'
  | 'unknown';

export interface MigrationEntryStatus {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
  readonly state: MigrationState;
  /** SHA-256 of the .sql file (null when unreadable/missing). */
  readonly fileHash: string | null;
  /** Hash recorded by the migrator for this entry (null when not applied). */
  readonly appliedHash: string | null;
  /** `created_at` recorded by the migrator (null when not applied). */
  readonly appliedAt: number | null;
  readonly detail: string;
}

export interface MigrationStatusReport {
  readonly migrationsFolder: string;
  readonly journalEntries: number;
  readonly appliedRows: number;
  /** True when the migrations bookkeeping table exists in the database. */
  readonly tablePresent: boolean;
  readonly entries: readonly MigrationEntryStatus[];
  /** Journal rows recorded in the DB that are no longer in the journal. */
  readonly unknownApplied: readonly { when: number; hash: string }[];
  readonly appliedCount: number;
  readonly pendingCount: number;
  readonly divergedCount: number;
  /** True only when everything is applied and nothing drifted. */
  readonly consistent: boolean;
  /** Secret-free human summary lines. */
  readonly problems: readonly string[];
  /** Informational lines (e.g. "this database has never been migrated"). */
  readonly notes: readonly string[];
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Parse `drizzle/meta/_journal.json` (same file drizzle reads). */
export async function readJournal(migrationsFolder: string): Promise<JournalEntry[]> {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  let raw: string;
  try {
    raw = await readFile(journalPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read the migration journal at ${journalPath}: ${(error as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Migration journal ${journalPath} is not valid JSON: ${(error as Error).message}`);
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(`Migration journal ${journalPath} has no "entries" array`);
  }
  return entries.map((entry, position) => {
    const record = entry as Partial<JournalEntry>;
    if (typeof record.tag !== 'string' || typeof record.when !== 'number') {
      throw new Error(`Migration journal entry #${position} is missing "tag" or "when"`);
    }
    return {
      idx: typeof record.idx === 'number' ? record.idx : position,
      version: typeof record.version === 'string' ? record.version : '7',
      when: record.when,
      tag: record.tag,
      breakpoints: record.breakpoints !== false,
    };
  });
}

export interface AppliedMigrationRow {
  readonly hash: string;
  readonly createdAt: number;
}

/**
 * PURE comparison of journal + file hashes against the recorded rows.
 * No I/O, no database: unit-testable with fixtures.
 */
export function computeMigrationStatus(input: {
  readonly migrationsFolder: string;
  readonly journal: readonly JournalEntry[];
  /** tag -> file content (null when the file is missing/unreadable). */
  readonly files: ReadonlyMap<string, string | null>;
  readonly applied: readonly AppliedMigrationRow[];
  readonly tablePresent: boolean;
  /**
   * Number of application tables already in `public`. Used to tell apart a
   * genuinely EMPTY database (pending -> migrate it) from one that has our
   * tables but no bookkeeping (created outside drizzle -> drift, do NOT run
   * migrations against it).
   */
  readonly existingAppTables?: number;
}): MigrationStatusReport {
  const {
    migrationsFolder,
    journal,
    files,
    applied,
    tablePresent,
    existingAppTables = 0,
  } = input;
  const entries: MigrationEntryStatus[] = [];
  const matchedApplied = new Set<number>();
  const problems: string[] = [];

  for (const entry of journal) {
    const content = files.has(entry.tag) ? files.get(entry.tag) : null;
    const fileHash = content === null || content === undefined ? null : sha256Hex(content);

    if (fileHash === null) {
      entries.push({
        idx: entry.idx,
        tag: entry.tag,
        when: entry.when,
        state: 'missing_file',
        fileHash: null,
        appliedHash: null,
        appliedAt: null,
        detail: `${migrationsFolder}/${entry.tag}.sql is missing`,
      });
      problems.push(`migration file missing: ${entry.tag}.sql`);
      continue;
    }

    const recordIndex = applied.findIndex((row) => row.createdAt === entry.when);
    const record = recordIndex >= 0 ? applied[recordIndex] : undefined;
    if (record) {
      matchedApplied.add(recordIndex);
      const diverged = record.hash !== fileHash;
      entries.push({
        idx: entry.idx,
        tag: entry.tag,
        when: entry.when,
        state: diverged ? 'diverged' : 'applied',
        fileHash,
        appliedHash: record.hash,
        appliedAt: record.createdAt,
        detail: diverged
          ? `${entry.tag}.sql changed after it was applied (recorded hash ${record.hash.slice(0, 12)}…, file hash ${fileHash.slice(0, 12)}…)`
          : `applied at ${new Date(record.createdAt).toISOString()}`,
      });
      if (diverged) {
        problems.push(`${entry.tag}.sql diverged from the applied migration`);
      }
      continue;
    }

    entries.push({
      idx: entry.idx,
      tag: entry.tag,
      when: entry.when,
      state: 'pending',
      fileHash,
      appliedHash: null,
      appliedAt: null,
      detail: 'not yet applied to this database',
    });
  }

  const unknownApplied: { when: number; hash: string }[] = [];
  applied.forEach((row, index) => {
    if (!matchedApplied.has(index)) {
      unknownApplied.push({ when: row.createdAt, hash: row.hash });
      problems.push(`database has a migration record with no journal entry (created_at=${row.createdAt})`);
    }
  });

  const appliedCount = entries.filter((e) => e.state === 'applied').length;
  const pendingCount = entries.filter((e) => e.state === 'pending').length;
  const divergedCount = entries.filter((e) => e.state === 'diverged').length;
  const missingCount = entries.filter(
    (e) => e.state === 'missing_file' || e.state === 'unreadable',
  ).length;

  const notes: string[] = [];
  if (!tablePresent) {
    if (existingAppTables > 0) {
      // Our tables exist but nothing recorded them: somebody created them by
      // hand or restored a dump. Running migrations against this would fail
      // halfway; report it as drift instead of as work to do.
      problems.push(
        `no ${MIGRATIONS_TABLE_SCHEMA}.${MIGRATIONS_TABLE} table although ${existingAppTables} application ` +
          'table(s) already exist — this database was not migrated by this tool',
      );
    } else {
      // A genuinely empty database is PENDING, not drifted: the fix is one
      // command (`npm run db:migrate`), and refusing would block every fresh
      // deployment.
      notes.push(
        'this database has never been migrated — run `npm run db:migrate` (an empty database is pending, not drifted)',
      );
    }
  }

  const consistent =
    tablePresent && pendingCount === 0 && divergedCount === 0 && missingCount === 0 &&
    unknownApplied.length === 0;

  return {
    migrationsFolder,
    journalEntries: journal.length,
    appliedRows: applied.length,
    tablePresent,
    entries,
    unknownApplied,
    appliedCount,
    pendingCount,
    divergedCount,
    consistent,
    problems,
    notes,
  };
}

/** Read the journal + SQL files from disk (no database access). */
export async function readMigrationFiles(
  migrationsFolder: string,
  journal: readonly JournalEntry[],
): Promise<Map<string, string | null>> {
  const files = new Map<string, string | null>();
  for (const entry of journal) {
    const file = path.join(migrationsFolder, `${entry.tag}.sql`);
    try {
      files.set(entry.tag, await readFile(file, 'utf8'));
    } catch {
      files.set(entry.tag, null);
    }
  }
  return files;
}

export interface MigrationStatusQuery {
  /**
   * Parameterised SELECT helper returning rows (Drizzle-backed in the CLI,
   * `pg`-backed in tests). Only used for read-only bookkeeping queries.
   */
  readonly query: <T>(text: string, params?: readonly unknown[]) => Promise<readonly T[]>;
}

/**
 * Load the full status report for a live database.
 *
 * `query` is injected so the CLI and the tests can pass either a Drizzle-backed
 * helper or a plain `pg`-backed one; the SQL is fully parameterised.
 */
export async function loadMigrationStatus(
  migrationsFolder: string,
  query: MigrationStatusQuery['query'],
): Promise<MigrationStatusReport> {
  const journal = await readJournal(migrationsFolder);
  const files = await readMigrationFiles(migrationsFolder, journal);

  let tablePresent = false;
  const applied: AppliedMigrationRow[] = [];

  const tableCheck = await query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = $1 and table_name = $2
     ) as exists`,
    [MIGRATIONS_TABLE_SCHEMA, MIGRATIONS_TABLE],
  );
  tablePresent = Boolean(tableCheck?.[0]?.exists);

  // How many application tables already exist? An empty database is pending;
  // a populated one without bookkeeping is drift.
  const tableCount = await query<{ count: number }>(
    `select count(*)::int as count
     from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  const existingAppTables = Number(tableCount?.[0]?.count ?? 0);

  if (tablePresent) {
    const rows = await query<{ hash: string; created_at: string }>(
      `select hash, created_at from "${MIGRATIONS_TABLE_SCHEMA}"."${MIGRATIONS_TABLE}"
       order by created_at asc`,
    );
    for (const row of rows) {
      applied.push({ hash: row.hash, createdAt: Number(row.created_at) });
    }
  }

  return computeMigrationStatus({
    migrationsFolder,
    journal,
    files,
    applied,
    tablePresent,
    existingAppTables,
  });
}
