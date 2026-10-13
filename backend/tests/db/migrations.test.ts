/**
 * Migrations + document stores against a REAL PostgreSQL (PART 5).
 *
 * The migration chain (0000 -> 0001 -> 0002 -> 0003) is applied by the suite's
 * global setup with `drizzle-kit migrate`; this file asserts the resulting
 * database is actually the one the code expects, and that the single-document
 * stores (settings, scheduler checkpoints, catalog) honour their constraints.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../../src/db/client.js';
import { loadMigrationStatus } from '../../src/db/migration-status.js';
import { PostgresSchedulerCheckpointStore, PostgresSettingsStore } from '../../src/db/postgres-settings-store.js';
import { PostgresCatalogStore } from '../../src/db/postgres-catalog-store.js';
import { DEFAULT_AUTOMATION_SETTINGS } from '../../src/settings/automation-settings.js';
import type { CatalogSnapshot } from '../../src/catalog/catalog.js';
import { openTestDatabase, resetDatabase, type TestDatabase } from './helpers.js';

let primary: TestDatabase;

beforeAll(async () => {
  primary = openTestDatabase();
});

afterAll(async () => {
  await primary.close();
});

beforeEach(async () => {
  await resetDatabase(primary.db);
});

async function query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
  return (await primary.raw.unsafe(text, params as never[])) as unknown as T[];
}

describe('migrations — the committed chain applies to a fresh database', () => {
  it('reports every journal entry as applied, with no drift', async () => {
    const status = await loadMigrationStatus(MIGRATIONS_FOLDER, query);
    expect(status.tablePresent).toBe(true);
    expect(status.journalEntries).toBe(4);
    expect(status.appliedRows).toBe(4);
    expect(status.pendingCount).toBe(0);
    expect(status.divergedCount).toBe(0);
    expect(status.unknownApplied).toHaveLength(0);
    expect(status.consistent).toBe(true);
    expect(status.entries.map((entry) => entry.tag)).toEqual([
      '0000_init',
      '0001_part3_catalog',
      '0002_part5_persistence',
      '0003_part6_providers',
    ]);
  });

  it('creates every table the application queries', async () => {
    const rows = await query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'api_clients',
      'app_settings',
      'generation_usage',
      'import_batches',
      'jobs',
      'notifications',
      'products',
      'provider_secrets',
      'provider_workspaces',
      'publish_runs',
      'scheduler_checkpoints',
      'slot_contents',
    ]);
  });

  it('enforces the concurrency-critical unique indexes', async () => {
    const rows = await query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'public'
       and indexname in ('jobs_unique_key_idx', 'slot_contents_slot_key_idx',
                         'products_feed_id_marketplace_idx', 'publish_runs_slot_provider_idx')`,
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.indexdef).toContain('UNIQUE');
    }
  });

  it('keeps the lease and version guard columns and their indexes', async () => {
    const columns = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'jobs'
         and column_name in ('claim_token', 'claimed_by', 'claimed_at', 'lease_expires_at', 'result')`,
    );
    expect(columns).toHaveLength(5);

    const indexes = await query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'
       and indexname in ('jobs_lease_idx', 'slot_contents_lock_idx', 'slot_contents_completed_idx')`,
    );
    expect(indexes).toHaveLength(3);
  });

  it('enforces the single-row settings invariant and the new foreign keys', async () => {
    const checks = await query<{ constraint_name: string }>(
      `select tc.constraint_name from information_schema.check_constraints cc
       join information_schema.table_constraints tc
         on tc.constraint_name = cc.constraint_name and tc.constraint_schema = cc.constraint_schema
       where tc.table_schema = 'public' and tc.constraint_name = 'app_settings_single_row'`,
    );
    expect(checks).toHaveLength(1);

    await primary.raw.unsafe(`insert into app_settings (id, doc) values (1, '{}'::jsonb)`);
    // Go through the driver (not the ORM wrapper) so the PostgreSQL message —
    // including the constraint name — is what the assertion sees.
    await expect(
      primary.raw.unsafe(`insert into app_settings (id, doc) values (2, '{}'::jsonb)`),
    ).rejects.toThrow(/app_settings_single_row/);

    const fks = await query<{ constraint_name: string; delete_rule: string }>(
      `select tc.constraint_name, rc.delete_rule
       from information_schema.table_constraints tc
       join information_schema.referential_constraints rc
         on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.constraint_schema
       where tc.table_schema = 'public' and tc.constraint_type = 'FOREIGN KEY'
         and tc.constraint_name = 'products_import_batch_id_import_batches_id_fk'`,
    );
    expect(fks).toHaveLength(1);
    expect(fks[0]?.delete_rule.toLowerCase()).toBe('set null');
  });
});

describe('PostgresSettingsStore', () => {
  it('round-trips the settings document and bumps the version on every write', async () => {
    const store = new PostgresSettingsStore(primary.db);
    expect(await store.load()).toBeNull();

    const settings = { ...DEFAULT_AUTOMATION_SETTINGS, intervalMinutes: 90, automationState: 'running' as const };
    await store.save(settings);
    expect((await store.load())?.intervalMinutes).toBe(90);

    await store.save({ ...settings, intervalMinutes: 120 });
    expect((await store.load())?.intervalMinutes).toBe(120);

    const rows = await query<{ count: number; version: number }>(
      `select count(*)::int as count, max(version)::int as version from app_settings`,
    );
    expect(rows[0]?.count).toBe(1);
    expect(rows[0]?.version).toBe(2);
  });

  it('concurrent writers cannot create two settings rows', async () => {
    const storeA = new PostgresSettingsStore(primary.db);
    const storeB = new PostgresSettingsStore(primary.db);
    const settings = DEFAULT_AUTOMATION_SETTINGS;
    await Promise.all([storeA.save(settings), storeB.save(settings)]);

    const rows = await query<{ count: number }>(`select count(*)::int as count from app_settings`);
    expect(rows[0]?.count).toBe(1);
  });
});

describe('PostgresSchedulerCheckpointStore', () => {
  it('stores and overwrites a checkpoint document per key', async () => {
    const store = new PostgresSchedulerCheckpointStore(primary.db);
    expect(await store.read('content_scheduler')).toBeNull();

    await store.write('content_scheduler', { at: '2026-10-12T00:00:00.000Z', executed: 2 });
    const first = await store.read('content_scheduler');
    expect(first?.doc.executed).toBe(2);

    await store.write('content_scheduler', { at: '2026-10-12T01:00:00.000Z', executed: 3 });
    const second = await store.read('content_scheduler');
    expect(second?.doc.executed).toBe(3);
    expect(second?.updatedAt).not.toBe(first?.updatedAt);

    const rows = await query<{ count: number }>(`select count(*)::int as count from scheduler_checkpoints`);
    expect(rows[0]?.count).toBe(1);
  });
});

describe('PostgresCatalogStore', () => {
  const snapshot: CatalogSnapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    batches: [
      {
        id: randomUUID(),
        filename: 'feed.csv',
        format: 'csv',
        importedAt: new Date().toISOString(),
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
        lastImportedAt: new Date().toISOString(),
        sourceImportId: '',
        extraColumns: {},
      },
      {
        internalId: randomUUID(),
        sourceProductId: 'p-2',
        name: 'Product Two',
        marketplace: 'ID',
        productUrl: 'https://shopee.co.id/product-two',
        affiliateUrl: 'https://s.shopee.co.id/two',
        hasAffiliateLink: true,
        productUrlNormalized: 'shopee.co.id/product-two',
        category: 'Electronics',
        categoryId: 'electronics',
        imageUrl: null,
        description: null,
        price: 2000,
        currency: 'IDR',
        commissionRate: 5,
        rating: 4.2,
        soldCount: 5,
        eligible: true,
        eligibilityReasons: [],
        lastImportedAt: new Date().toISOString(),
        sourceImportId: '',
        extraColumns: { mystery: 'kept' },
      },
    ],
  };

  it('persists products and batches and reads them back', async () => {
    const store = new PostgresCatalogStore(primary.db);
    await store.save(snapshot);

    const loaded = await store.load();
    expect(loaded?.products).toHaveLength(2);
    expect(loaded?.batches).toHaveLength(1);
    expect(loaded?.products[0]?.productUrlNormalized).toBe('shopee.co.id/product-one');
    expect(loaded?.products[1]?.extraColumns).toEqual({ mystery: 'kept' });
    expect(loaded?.products[0]?.eligible).toBe(true);
  });

  it('re-importing the same snapshot upserts instead of duplicating', async () => {
    const store = new PostgresCatalogStore(primary.db);
    await store.save(snapshot);
    await store.save(snapshot);

    const rows = await query<{ products: number; batches: number }>(
      `select (select count(*)::int from products) as products,
              (select count(*)::int from import_batches) as batches`,
    );
    expect(rows[0]?.products).toBe(2);
    expect(rows[0]?.batches).toBe(1);
    expect((await store.load())?.products).toHaveLength(2);
  });

  it('keeps the catalog internal id stable when a product is re-imported', async () => {
    const store = new PostgresCatalogStore(primary.db);
    await store.save(snapshot);
    const first = (await store.load())?.products.find((p) => p.sourceProductId === 'p-1');

    const changed = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
      products: snapshot.products.map((product) =>
        product.sourceProductId === 'p-1' ? { ...product, name: 'Product One (renamed)' } : product,
      ),
    };
    await store.save(changed);

    const second = (await store.load())?.products.find((p) => p.sourceProductId === 'p-1');
    expect(second?.internalId).toBe(first?.internalId);
    expect(second?.name).toBe('Product One (renamed)');
  });
});
