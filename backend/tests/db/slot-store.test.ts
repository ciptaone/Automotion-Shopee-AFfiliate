/**
 * PostgreSQL slot store — reservation atomicity, optimistic writes, recovery (PART 5).
 *
 * Proves against a REAL database what the in-process promise chain only
 * approximates: exactly one writer can reserve a slot, a stale writer is
 * rejected instead of overwriting, and every field the pipeline needs to
 * resume (image count, asset references, captions) survives a restart intact.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SlotContentStore,
  SlotWriteConflictError,
  type SlotContentRecord,
} from '../../src/automation/slot-store.js';
import { PostgresSlotStore } from '../../src/db/postgres-slot-store.js';
import { recoverOnStartup } from '../../src/db/recovery.js';
import { PostgresJobQueue } from '../../src/db/postgres-job-queue.js';
import { openTestDatabase, resetDatabase, type TestDatabase } from './helpers.js';

let primary: TestDatabase;
/** Row id of the product each record references (FK `slot_contents.product_id`). */
let productId: string;

beforeAll(async () => {
  primary = openTestDatabase();
});

afterAll(async () => {
  await primary.close();
});

beforeEach(async () => {
  await resetDatabase(primary.db);
  // `slot_contents.product_id` is a REAL foreign key: a slot cannot reference a
  // product that does not exist, so the fixture creates one first.
  productId = randomUUID();
  await primary.raw.unsafe(
    `insert into products (id, feed_id, name, marketplace, product_url, affiliate_url, has_affiliate_link, eligible)
     values ($1, $2, $3, $4, $5, $5, true, true)`,
    [productId, '123456789', 'Test Product', 'shopee', 'https://s.shopee.co.id/test'],
  );
});

function makeRecord(slotKey: string, overrides: Partial<SlotContentRecord> = {}): SlotContentRecord {
  const now = new Date().toISOString();
  return {
    slotKey,
    stage: 'publish_ready',
    productId,
    sourceProductId: '123456789',
    productName: 'Test Product',
    affiliateUrl: 'https://s.shopee.co.id/test',
    categoryId: 'electronics',
    imageCountPolicy: 'random_1_or_2',
    imageCount: 2,
    imageCountChosenAt: now,
    selection: {
      mode: 'auto',
      selectedCategoryIds: ['electronics'],
      score: 0.8,
      signals: { price: 1 },
      considered: 3,
    },
    referenceImageUrl: 'https://cdn.example/ref.png',
    generationRunId: randomUUID(),
    // One shared image set; both platforms use these SAME assets (there is no
    // per-platform regeneration anywhere in the pipeline).
    assets: [
      {
        assetId: 'asset-1',
        position: 1,
        view: 'main_closeup_pov',
        storageKey: 'slots/abc/image-1.png',
        publicUrl: 'https://cdn.example/image-1.png',
        checksumSha256: 'a'.repeat(64),
        mimeType: 'image/png',
        width: 1024,
        height: 1024,
        sizeBytes: 1234,
        provider: 'mock',
        providerKind: 'mock',
        model: 'mock-image-v1',
        promptVersion: 'v1',
        seed: 42,
        referenceImageUrl: null,
        validationPassed: true,
        validationIssues: [],
        generatedAt: now,
      },
    ],
    captions: [
      {
        platform: 'facebook_page',
        fullText: 'Great product https://s.shopee.co.id/test\n\n#ai #automation',
        hashtags: ['#ai', '#automation'],
        provider: 'mock',
        providerKind: 'mock',
        model: 'mock-text-v1',
        validationPassed: true,
        blocking: [],
        warnings: [],
        generatedAt: now,
      },
    ],
    validationPassed: true,
    blockers: [],
    lastError: null,
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

describe('PostgresSlotStore — reservation is a database invariant', () => {
  it('exactly one of two concurrent writers reserves the same slot', async () => {
    const storeA = new PostgresSlotStore(openTestDatabase().db);
    const storeB = new PostgresSlotStore(openTestDatabase().db);
    const slotKey = '2026-10-12#03';

    const results = await Promise.all([
      storeA.write(makeRecord(slotKey)),
      storeB.write(makeRecord(slotKey)),
    ]);

    const winners = results.filter((outcome) => outcome.ok);
    expect(winners).toHaveLength(1);

    const rows = (await primary.db.execute(
      sql`select count(*)::int as count from slot_contents where slot_key = ${slotKey}`,
    )) as unknown as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(1);
  });

  it('two independent slot repositories cannot both reserve one slot', async () => {
    // Two processes, each with its own store + its own in-process lock.
    const repoA = new SlotContentStore(new PostgresSlotStore(openTestDatabase().db));
    const repoB = new SlotContentStore(new PostgresSlotStore(openTestDatabase().db));
    await Promise.all([repoA.init(), repoB.init()]);

    const slotKey = '2026-10-12#04';
    const reserve = (repo: SlotContentStore) =>
      repo.mutate(slotKey, async (current) => {
        if (current) return 'existing';
        await repo.put(makeRecord(slotKey));
        return 'reserved';
      });

    const settled = await Promise.allSettled([reserve(repoA), reserve(repoB)]);
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SlotWriteConflictError);
    expect(repoA.get(slotKey)?.stage).toBe('publish_ready');
  });

  it('rejects a write based on a stale version instead of overwriting newer state', async () => {
    const storeA = new PostgresSlotStore(primary.db);
    const storeB = new PostgresSlotStore(primary.db);
    const slotKey = '2026-10-12#05';

    // A loads first (version 0 = no row), then B inserts the row.
    expect(await storeA.refresh(slotKey)).toBeNull();
    expect((await storeB.write(makeRecord(slotKey))).ok).toBe(true);

    // A now tries to write with no knowledge of B's row.
    const outcome = await storeA.write(
      makeRecord(slotKey, { stage: 'failed', lastError: 'stale writer' }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.current?.stage).toBe('publish_ready');

    const stored = await new PostgresSlotStore(primary.db).refresh(slotKey);
    expect(stored?.stage).toBe('publish_ready');
    expect(stored?.lastError).toBeNull();
  });

  it('the second write after a refresh succeeds (conflict is recoverable)', async () => {
    const storeA = new PostgresSlotStore(primary.db);
    const storeB = new PostgresSlotStore(primary.db);
    const slotKey = '2026-10-12#06';

    await storeA.write(makeRecord(slotKey));
    await storeB.refresh(slotKey);
    const outcome = await storeB.write(makeRecord(slotKey, { stage: 'publish_ready', attempts: 2 }));
    expect(outcome.ok).toBe(true);
    expect((await storeA.refresh(slotKey))?.attempts).toBe(2);
  });
});

describe('PostgresSlotStore — durability across restarts', () => {
  it('reloads every field the pipeline needs to resume', async () => {
    const slotKey = '2026-10-12#07';
    const record = makeRecord(slotKey);
    await new PostgresSlotStore(primary.db).write(record);

    // A brand new process: fresh store, nothing in memory.
    const restarted = new SlotContentStore(new PostgresSlotStore(openTestDatabase().db));
    await restarted.init();

    const loaded = restarted.get(slotKey);
    expect(loaded).not.toBeNull();
    expect(loaded?.imageCount).toBe(2);
    expect(loaded?.assets).toHaveLength(1);
    expect(loaded?.assets[0]?.checksumSha256).toBe('a'.repeat(64));
    expect(loaded?.assets[0]?.storageKey).toBe('slots/abc/image-1.png');
    expect(loaded?.captions[0]?.fullText).toContain('#ai #automation');
    expect(loaded?.validationPassed).toBe(true);
    expect(loaded?.stage).toBe('publish_ready');
    expect(loaded?.productId).toBe(record.productId);
  });

  it('stores only references and metadata — never image bytes', async () => {
    const slotKey = '2026-10-12#08';
    await new PostgresSlotStore(primary.db).write(makeRecord(slotKey));

    const rows = (await primary.db.execute(
      sql`select assets::text as assets from slot_contents where slot_key = ${slotKey}`,
    )) as unknown as Array<{ assets: string }>;
    expect(rows[0]?.assets).toContain('storageKey');
    expect(rows[0]?.assets).not.toContain('base64');
  });
});

describe('startup recovery — expired locks, untouched completed work', () => {
  it('releases an expired slot lock and bumps the version so a late writer is rejected', async () => {
    const slotKey = '2026-10-12#09';
    const store = new PostgresSlotStore(primary.db);
    await store.write(makeRecord(slotKey, { stage: 'generating_images' }));
    await primary.db.execute(
      sql`update slot_contents
          set lock_owner = 'worker-that-died',
              lock_expires_at = now() - interval '1 second'
          where slot_key = ${slotKey}`,
    );

    const readLockRow = async () =>
      (await primary.raw.unsafe(`select version, lock_owner from slot_contents where slot_key = $1`, [
        slotKey,
      ])) as unknown as { version: number; lock_owner: string | null }[];

    const before = (await readLockRow())[0]!;
    const report = await recoverOnStartup({ db: primary.db, queue: new PostgresJobQueue({ db: primary.db }) });
    expect(report.releasedSlotLocks).toBe(1);

    // The lock columns are not part of the pipeline record — read them from
    // the row itself so the assertion is about what the DATABASE holds.
    const after = (await readLockRow())[0]!;
    expect(after.lock_owner).toBeNull();
    expect(after.version).toBeGreaterThan(before.version);
  });

  it('never touches completed rows and never clears their error history', async () => {
    const slotKey = '2026-10-12#10';
    await new PostgresSlotStore(primary.db).write(
      makeRecord(slotKey, { stage: 'publish_ready', lastError: 'previous transient failure' }),
    );

    await recoverOnStartup({ db: primary.db, queue: new PostgresJobQueue({ db: primary.db }) });

    const stored = await new PostgresSlotStore(primary.db).refresh(slotKey);
    expect(stored?.stage).toBe('publish_ready');
    expect(stored?.lastError).toBe('previous transient failure');
    expect(stored?.completedAt).toBeTruthy();
  });

  it('is idempotent: running recovery twice changes nothing the second time', async () => {
    const slotKey = '2026-10-12#11';
    await new PostgresSlotStore(primary.db).write(makeRecord(slotKey, { stage: 'generating_images' }));
    await primary.db.execute(
      sql`update slot_contents set lock_owner = 'w', lock_expires_at = now() - interval '1 second'
          where slot_key = ${slotKey}`,
    );

    const first = await recoverOnStartup({ db: primary.db, queue: new PostgresJobQueue({ db: primary.db }) });
    const second = await recoverOnStartup({ db: primary.db, queue: new PostgresJobQueue({ db: primary.db }) });
    expect(first.releasedSlotLocks).toBe(1);
    expect(second.releasedSlotLocks).toBe(0);
    expect(second.requeuedJobs).toBe(0);
  });
});
