/**
 * PART 9 §7 — backup/restore drill against REAL scratch databases.
 *
 * The runbook's canonical production path is pg_dump/pg_restore (documented,
 * PART of the runbook). This suite exercises the repo-native fallback
 * (`src/db/backup.ts`) end to end on throwaway databases so the DRILL itself
 * is tested, not just written down:
 *
 *  - SOURCE scratch: migrated by the release runner, then seeded through the
 *    REAL stores — settings document, catalog snapshot, job queue (one running
 *    job with a live lease + one claimable job), ops events, usage ledger;
 *  - backup: read-only export + manifest; the manifest contains the database
 *    NAME only (no host/user/password);
 *  - TARGET scratch: migrated fresh, restored, and verified — row counts per
 *    table, settings/catalog content, the queue is USABLE (the restored
 *    pending job is claimable, the restored lease survives), events and the
 *    usage ledger round-trip;
 *  - refusals: restoring into a NON-EMPTY target is refused (cannot destroy
 *    data), and restoring into a NON-MIGRATED target is refused (schema is
 *    code, never restored).
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/db/client.js';
import {
  createBackup,
  restoreBackup,
  RestoreRefusedError,
  type BackupManifest,
} from '../../src/db/backup.js';
import { runReleaseMigration } from '../../src/db/release-migration.js';
import { PostgresSettingsStore } from '../../src/db/postgres-settings-store.js';
import { PostgresCatalogStore } from '../../src/db/postgres-catalog-store.js';
import { PostgresJobQueue } from '../../src/db/postgres-job-queue.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../src/settings/automation-settings.js';
import type { CatalogSnapshot } from '../../src/catalog/catalog.js';
import { testDatabaseUrl } from './helpers.js';

const dropped: (() => Promise<void>)[] = [];

async function createScratch(label: string): Promise<string> {
  const name = `part9_${label}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const admin = postgres(testDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  dropped.push(async () => {
    const cleanup = postgres(testDatabaseUrl(), { max: 1 });
    try {
      await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
    } finally {
      await cleanup.end({ timeout: 5 });
    }
  });
  return url.toString();
}

async function tableCounts(raw: postgres.Sql): Promise<Record<string, number>> {
  const tables = (await raw.unsafe(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  )) as unknown as { table_name: string }[];
  const counts: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    const rows = (await raw.unsafe(
      `select count(*)::int as count from public."${table}"`,
    )) as unknown as { count: number }[];
    counts[table] = rows[0]?.count ?? -1;
  }
  return counts;
}

function catalogSnapshot(): CatalogSnapshot {
  const now = new Date().toISOString();
  return {
    version: 1,
    updatedAt: now,
    batches: [
      {
        id: randomUUID(),
        filename: 'feed.csv',
        format: 'csv',
        importedAt: now,
        totalRows: 2,
        accepted: 2,
        newProducts: 2,
        updatedProducts: 0,
        rejected: 0,
        duplicatesRemoved: 0,
        urlDuplicatesSkipped: 0,
        categoriesSeen: 1,
        issues: [],
        source: 'feed_import',
      },
    ],
    products: [
      {
        internalId: randomUUID(),
        sourceProductId: 'p-1',
        name: 'Product One',
        marketplace: 'ID',
        productUrl: 'https://shopee.co.id/product-one',
        affiliateUrl: 'https://s.shopee.co.id/one',
        hasAffiliateLink: true,
        productUrlNormalized: 'shopee.co.id/product-one',
        category: 'Electronics',
        categoryId: 'electronics',
        imageUrl: null,
        description: null,
        price: 1000,
        currency: 'IDR',
        commissionRate: 5,
        rating: 4.5,
        soldCount: 10,
        eligible: true,
        eligibilityReasons: [],
        lastImportedAt: now,
        sourceImportId: '',
        extraColumns: {},
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  The drill                                                                 */
/* -------------------------------------------------------------------------- */

const backupDir = path.join(process.cwd(), 'tmp', `backup-drill-${randomUUID()}`);
const PENDING_KEY = `part9-pending-${randomUUID()}`;
const CLAIMED_KEY = `part9-claimed-${randomUUID()}`;
const FINGERPRINT = `scheduler_tick_failed:${randomUUID()}`;

let manifest: BackupManifest;
let sourceUrl: string;
let targetUrl: string;
const closers: postgres.Sql[] = [];

beforeAll(async () => {
  sourceUrl = await createScratch('src');
  targetUrl = await createScratch('dst');

  /* --- SOURCE: migrate + seed through the real stores -------------------- */
  const source = createDatabase(sourceUrl);
  closers.push(source.raw);
  await runReleaseMigration({ raw: source.raw, db: source.db });

  await new PostgresSettingsStore(source.db).save({
    ...DEFAULT_AUTOMATION_SETTINGS,
    intervalMinutes: 90,
  });
  await new PostgresCatalogStore(source.db).save(catalogSnapshot());

  const queue = new PostgresJobQueue({ db: source.db });
  const claimedJob = await queue.enqueue({
    kind: 'content_slot',
    uniqueKey: CLAIMED_KEY,
    scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    payload: { slotKey: CLAIMED_KEY },
    maxAttempts: 3,
  });
  const claimed = await queue.claim('drill-worker');
  expect(claimed?.id).toBe(claimedJob.id);
  expect(claimed?.claimToken).toBeTruthy();
  await queue.enqueue({
    kind: 'content_slot',
    uniqueKey: PENDING_KEY,
    scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    payload: { slotKey: PENDING_KEY },
    maxAttempts: 3,
  });

  await source.raw.unsafe(
    `insert into ops_events (id, fingerprint, kind, severity, title, detail, occurrences)
     values ($1, $2, 'scheduler_tick_failed', 'critical', 'Scheduler tick failed',
             '{"attempts":3}'::text, 3)`,
    [randomUUID(), FINGERPRINT],
  );
  await source.raw.unsafe(
    `insert into generation_usage
       (id, provider_name, model, operation, status, latency_ms, cost_kind, cost_usd)
     values ($1, 'mock-image', 'mock-image-v1', 'image', 'success', 120, 'estimated', 0.001)`,
    [randomUUID()],
  );

  /* --- Backup ------------------------------------------------------------ */
  manifest = await createBackup({ raw: source.raw, outDir: backupDir });

  /* --- TARGET: migrate fresh (schema is code, never restored) ------------ */
  const target = createDatabase(targetUrl);
  closers.push(target.raw);
  await runReleaseMigration({ raw: target.raw, db: target.db });
});

afterAll(async () => {
  for (const raw of closers) {
    try {
      await raw.end({ timeout: 5 });
    } catch {
      /* already closed */
    }
  }
  for (const drop of dropped.splice(0)) await drop();
  await rm(backupDir, { recursive: true, force: true });
});

describe('backup — read-only export with a secret-free manifest', () => {
  it('exports every public table and records counts', () => {
    expect(manifest.format).toBe('autopilot-db-backup/1');
    expect(manifest.schemaConsistent).toBe(true);
    expect(manifest.migrationsApplied).toBe(manifest.journalEntries);
    expect(manifest.tables['app_settings']).toBe(1);
    expect(manifest.tables['products']).toBe(1);
    expect(manifest.tables['import_batches']).toBe(1);
    expect(manifest.tables['jobs']).toBe(2);
    expect(manifest.tables['ops_events']).toBe(1);
    expect(manifest.tables['generation_usage']).toBe(1);
  });

  it('names the database only — never host, user or password', () => {
    expect(manifest.database).toBe(new URL(sourceUrl).pathname.slice(1));
    // `format` is a repo-controlled constant ("autopilot-db-backup/1"); every
    // other field must be free of connection detail.
    const { format, ...rest } = manifest;
    expect(format).toBe('autopilot-db-backup/1');
    const serialized = JSON.stringify(rest);
    const source = new URL(sourceUrl);
    expect(serialized).not.toContain(source.hostname);
    expect(serialized).not.toContain(source.username);
    expect(serialized).not.toContain(source.password);
    expect(serialized).not.toMatch(/postgres:\/\//);
  });
});

describe('restore — isolated target database (the §7 drill)', () => {
  it('loads the backup and verifies every table count', async () => {
    const target = createDatabase(targetUrl);
    const report = await restoreBackup({ raw: target.raw, inDir: backupDir });
    expect(report.rowsInserted).toBe(
      Object.values(manifest.tables).reduce((sum, count) => sum + count, 0),
    );
    expect(report.verified).toEqual(manifest.tables);

    // Independent recount straight from the live catalog.
    expect(await tableCounts(target.raw)).toEqual(manifest.tables);
    await target.raw.end({ timeout: 5 });
  });

  it('settings and catalog content survive the round-trip', async () => {
    const target = createDatabase(targetUrl);
    const settings = await new PostgresSettingsStore(target.db).load();
    expect(settings?.intervalMinutes).toBe(90);

    const catalog = await new PostgresCatalogStore(target.db).load();
    expect(catalog?.products).toHaveLength(1);
    expect(catalog?.products[0]?.sourceProductId).toBe('p-1');
    expect(catalog?.batches).toHaveLength(1);
    await target.raw.end({ timeout: 5 });
  });

  it('the queue is usable: the pending job is claimable, the running lease survived', async () => {
    const target = createDatabase(targetUrl);
    const queue = new PostgresJobQueue({ db: target.db });

    const restored = await queue.claim('post-restore-worker');
    expect(restored?.status).toBe('running');
    expect(restored?.claimedBy).toBe('post-restore-worker');
    expect(restored?.uniqueKey).toBe(PENDING_KEY);

    // The job that was mid-flight at backup time kept its claim and lease —
    // crash recovery (lease expiry), not silent loss.
    const leased = (await target.raw.unsafe(
      `select claimed_by, claim_token, lease_expires_at is not null as has_lease
       from jobs where unique_key = $1`,
      [CLAIMED_KEY],
    )) as unknown as { claimed_by: string; claim_token: string; has_lease: boolean }[];
    expect(leased).toHaveLength(1);
    expect(leased[0]?.claimed_by).toBe('drill-worker');
    expect(leased[0]?.claim_token).toBeTruthy();
    expect(leased[0]?.has_lease).toBe(true);
    await target.raw.end({ timeout: 5 });
  });

  it('ops events and the usage ledger round-trip intact', async () => {
    const target = createDatabase(targetUrl);
    const events = (await target.raw.unsafe(
      `select kind, severity, occurrences, last_delivery_status from ops_events where fingerprint = $1`,
      [FINGERPRINT],
    )) as unknown as { kind: string; severity: string; occurrences: number; last_delivery_status: string }[];
    expect(events).toEqual([
      {
        kind: 'scheduler_tick_failed',
        severity: 'critical',
        occurrences: 3,
        last_delivery_status: 'not_sent',
      },
    ]);

    const usage = (await target.raw.unsafe(
      `select provider_name, model, status, cost_kind, cost_usd from generation_usage`,
    )) as unknown as { provider_name: string; status: string; cost_kind: string; cost_usd: number }[];
    expect(usage).toHaveLength(1);
    expect(usage[0]?.provider_name).toBe('mock-image');
    expect(usage[0]?.status).toBe('success');
    expect(usage[0]?.cost_kind).toBe('estimated');
    expect(usage[0]?.cost_usd).toBeCloseTo(0.001, 9);
    await target.raw.end({ timeout: 5 });
  });

  it('refuses to restore into the now non-empty target (cannot destroy data)', async () => {
    const target = createDatabase(targetUrl);
    try {
      const error = await restoreBackup({ raw: target.raw, inDir: backupDir }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(RestoreRefusedError);
      expect((error as RestoreRefusedError).message).toContain('already contains rows');

      // The restored data is untouched.
      const counts = await tableCounts(target.raw);
      expect(counts['products']).toBe(manifest.tables['products']);
    } finally {
      await target.raw.end({ timeout: 5 });
    }
  });
});

describe('restore — refusals', () => {
  it('refuses a target that was never migrated (schema is code, never restored)', async () => {
    const unmigratedUrl = await createScratch('unmigrated');
    const unmigrated = createDatabase(unmigratedUrl);
    try {
      const error = await restoreBackup({ raw: unmigrated.raw, inDir: backupDir }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(RestoreRefusedError);
      expect((error as RestoreRefusedError).message).toContain('not consistent');
      // Nothing was created by the refused restore.
      expect(await tableCounts(unmigrated.raw)).toEqual({});
    } finally {
      await unmigrated.raw.end({ timeout: 5 });
    }
  });
});
