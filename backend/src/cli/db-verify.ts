/**
 * `npm run db:verify` — does the LIVE database still match `src/db/schema.ts`?
 *
 * `db:status` answers "are the migrations applied?". This command answers the
 * harder question: "is the schema actually what the code expects?". It diffs
 * the Drizzle schema (the source of truth the application queries against) with
 * live catalog metadata:
 *
 *   tables, columns (name + SQL type + nullability), indexes, foreign keys,
 *   check constraints, unique constraints
 *
 * That catches the class of failure a migration log cannot: someone ALTERed a
 * column by hand, dropped an index, or restored an older dump on top.
 *
 * Exit codes:
 *   0  live schema matches the Drizzle schema
 *   2  DATABASE_URL is not set
 *   5  differences found (listed on stdout)
 *   1  unreachable / unexpected error
 *
 * Read-only: it only ever runs SELECTs against the catalog. Objects created
 * automatically by PostgreSQL (primary-key indexes, derived `<table>_<col>_key`
 * unique names) are recognised rather than reported as "extra".
 */
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createDatabaseHandle, sanitizeDatabaseError } from '../db/client.js';
import {
  apiClients,
  appSettings,
  generationUsage,
  importBatches,
  jobs,
  notifications,
  products,
  providerSecrets,
  providerWorkspaces,
  publishRuns,
  schedulerCheckpoints,
  slotContents,
} from '../db/schema.js';

/** Every table the application queries, in alphabetical order. */
const SCHEMA_TABLES = [
  apiClients,
  appSettings,
  generationUsage,
  importBatches,
  jobs,
  notifications,
  products,
  providerSecrets,
  providerWorkspaces,
  publishRuns,
  schedulerCheckpoints,
  slotContents,
];

interface Diff {
  readonly kind: 'missing' | 'extra' | 'mismatch';
  readonly object: string;
  readonly detail: string;
}

type Query = <T>(text: string, params?: readonly unknown[]) => Promise<readonly T[]>;

/**
 * Compare `information_schema.data_type` ("character varying", "timestamp with
 * time zone") with Drizzle's `column.getSQLType()` ("varchar(64)", "timestamp
 * with time zone") on equal terms, so only a real schema change is flagged —
 * not a difference in spelling.
 */
function normaliseSqlType(value: string): string {
  const base = value.replace(/\(.*\)\s*$/, '').trim().toLowerCase();
  const aliases: Record<string, string> = {
    'character varying': 'varchar',
    character: 'char',
    'timestamp with time zone': 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'double precision': 'float8',
    int: 'integer',
    int4: 'integer',
    int8: 'bigint',
    bool: 'boolean',
    decimal: 'numeric',
  };
  return aliases[base] ?? base;
}

interface ColumnExpectation {
  readonly type: string;
  readonly notNull: boolean;
}

export async function verifySchema(query: Query): Promise<Diff[]> {
  const diffs: Diff[] = [];

  /* --- live snapshot (read-only catalog queries) ----------------------- */
  const columnRows = await query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `select table_name, column_name, data_type, is_nullable
     from information_schema.columns
     where table_schema = 'public'`,
  );
  const liveColumns = new Map<string, Map<string, ColumnExpectation>>();
  for (const row of columnRows) {
    const perTable = liveColumns.get(row.table_name) ?? new Map<string, ColumnExpectation>();
    perTable.set(row.column_name, {
      type: normaliseSqlType(row.data_type),
      notNull: row.is_nullable === 'NO',
    });
    liveColumns.set(row.table_name, perTable);
  }

  const indexRows = await query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'public'`,
  );
  const liveIndexes = new Set(indexRows.map((row) => row.indexname));

  const constraintRows = await query<{ constraint_name: string; constraint_type: string }>(
    `select tc.constraint_name, tc.constraint_type
     from information_schema.table_constraints tc
     where tc.table_schema = 'public'
       and tc.constraint_type in ('FOREIGN KEY', 'CHECK', 'UNIQUE')`,
  );
  const liveConstraints = new Map(constraintRows.map((row) => [row.constraint_name, row.constraint_type]));

  /* --- expectations derived from src/db/schema.ts ---------------------- */
  const expectedTables = new Set<string>();
  const expectedIndexes = new Set<string>();
  const expectedConstraints = new Set<string>();
  const expectedColumns = new Map<string, Map<string, ColumnExpectation>>();

  for (const table of SCHEMA_TABLES) {
    const config = getTableConfig(table);
    expectedTables.add(config.name);

    const columns = new Map<string, ColumnExpectation>();
    for (const column of config.columns) {
      columns.set(column.name, {
        type: normaliseSqlType(column.getSQLType()),
        notNull: column.notNull,
      });
    }
    expectedColumns.set(config.name, columns);

    for (const index of config.indexes) {
      if (index.config.name) expectedIndexes.add(index.config.name);
    }
    for (const key of config.foreignKeys) expectedConstraints.add(key.getName());
    for (const check of config.checks) expectedConstraints.add(check.name);
    for (const unique of config.uniqueConstraints) {
      const name = unique.getName();
      if (name) expectedConstraints.add(name);
    }
  }

  /* --- tables and columns --------------------------------------------- */
  for (const [tableName, expected] of expectedColumns) {
    const live = liveColumns.get(tableName);
    if (!live) {
      diffs.push({ kind: 'missing', object: tableName, detail: 'table is missing from the database' });
      continue;
    }
    for (const [columnName, expectation] of expected) {
      const actual = live.get(columnName);
      if (!actual) {
        diffs.push({
          kind: 'missing',
          object: `${tableName}.${columnName}`,
          detail: 'column is missing from the database',
        });
        continue;
      }
      if (actual.type !== expectation.type) {
        diffs.push({
          kind: 'mismatch',
          object: `${tableName}.${columnName}`,
          detail: `expected type ${expectation.type}, database has ${actual.type}`,
        });
      }
      if (actual.notNull !== expectation.notNull) {
        diffs.push({
          kind: 'mismatch',
          object: `${tableName}.${columnName}`,
          detail: expectation.notNull
            ? 'expected NOT NULL, database allows NULL'
            : 'expected NULLable, database is NOT NULL',
        });
      }
    }
    for (const columnName of live.keys()) {
      if (!expected.has(columnName)) {
        diffs.push({
          kind: 'extra',
          object: `${tableName}.${columnName}`,
          detail: 'column exists in the database but not in the schema',
        });
      }
    }
  }
  for (const tableName of liveColumns.keys()) {
    if (!expectedTables.has(tableName)) {
      diffs.push({
        kind: 'extra',
        object: tableName,
        detail: 'table exists in the database but not in the schema',
      });
    }
  }

  /* --- indexes ---------------------------------------------------------- */
  // A UNIQUE constraint also materialises as an index, so its name is valid.
  const allowedIndexes = new Set([...expectedIndexes, ...expectedConstraints]);
  for (const name of expectedIndexes) {
    if (!liveIndexes.has(name)) {
      diffs.push({ kind: 'missing', object: name, detail: 'index is missing from the database' });
    }
  }
  for (const name of liveIndexes) {
    // PostgreSQL-created names: primary keys and derived unique names.
    if (name.endsWith('_pkey') || name.endsWith('_key')) continue;
    if (!allowedIndexes.has(name)) {
      diffs.push({
        kind: 'extra',
        object: name,
        detail: 'index exists but is not declared in the schema',
      });
    }
  }

  /* --- foreign keys, checks and unique constraints ---------------------- */
  for (const name of expectedConstraints) {
    if (!liveConstraints.has(name)) {
      diffs.push({ kind: 'missing', object: name, detail: 'constraint is missing from the database' });
    }
  }

  return diffs;
}

async function main(): Promise<number> {
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
      return 1;
    }
    const raw = handle.raw;
    if (!raw) {
      console.error('Database handle is not initialised.');
      return 1;
    }

    const diffs = await verifySchema((text, params) => raw.unsafe(text, (params ?? []) as never[]));
    if (diffs.length === 0) {
      console.log('RESULT: live schema matches src/db/schema.ts.');
      return 0;
    }
    console.log(`RESULT: ${diffs.length} difference(s) between the schema and the live database:\n`);
    for (const diff of diffs) {
      console.log(`  ${diff.kind.padEnd(8)} ${diff.object.padEnd(44)} ${diff.detail}`);
    }
    return 5;
  } catch (error) {
    console.error(`db:verify failed: ${sanitizeDatabaseError(error)}`);
    return 1;
  } finally {
    await handle.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`db:verify failed: ${sanitizeDatabaseError(error)}`);
    process.exit(1);
  },
);
