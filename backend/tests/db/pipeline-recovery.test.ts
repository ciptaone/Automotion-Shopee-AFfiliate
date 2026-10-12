/**
 * Pipeline durability + crash recovery over a REAL PostgreSQL (PART 5).
 *
 * What this proves end-to-end:
 *   - a completed slot's state is in the database, not in a process map;
 *   - a second process (simulating a restart) sees the identical record and
 *     does NOT regenerate anything;
 *   - a retry after a failure preserves the persisted image count and reuses
 *     the already-validated assets (no silent regeneration);
 *   - every persisted caption still ends exactly `#ai #automation`;
 *   - no `publish_runs` row is ever invented — publishing stays disabled.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalog, startTestProcess, type TestProcess } from './harness.js';
import { openTestDatabase, resetDatabase, type TestDatabase } from './helpers.js';

let bootstrap: TestDatabase;
let processA: TestProcess;
/** Started AFTER the seeding run, like a restarted backend would be. */
let restarted: TestProcess;

beforeAll(async () => {
  bootstrap = openTestDatabase();
  await resetDatabase(bootstrap.db);
  processA = await startTestProcess();
  await seedCatalog(processA);
  restarted = await startTestProcess();
});

afterAll(async () => {
  await processA.close();
  await restarted.close();
  await bootstrap.close();
});

describe('content pipeline — durable output', () => {
  it('writes a publish_ready slot to PostgreSQL with captions, assets and checksums', async () => {
    const slotKey = '2026-10-12#R1';
    const result = await processA.pipeline.runSlot(slotKey);

    expect(result.record.stage).toBe('publish_ready');
    expect([1, 2]).toContain(result.record.imageCount);
    expect(result.record.imageCountChosenAt).toBeTruthy();
    expect(result.record.assets.length).toBe(result.record.imageCount);
    expect(result.record.captions).toHaveLength(2);

    for (const caption of result.record.captions) {
      expect(caption.fullText.endsWith('#ai #automation')).toBe(true);
      expect(caption.providerKind).toBe('mock');
    }
    for (const asset of result.record.assets) {
      expect(asset.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.storageKey.startsWith('slots/')).toBe(true);
      expect(asset.publicUrl.startsWith('http')).toBe(true);
    }

    // The row is really in the database (read it back over a fresh pool).
    const rows = await bootstrap.raw.unsafe(
      `select stage, image_count, completed_at is not null as completed, asset_count
       from (
         select stage, image_count, completed_at,
                json_array_length(assets::json) as asset_count
         from slot_contents where slot_key = $1
       ) t`,
      [slotKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stage).toBe('publish_ready');
    expect(Number(rows[0]!.asset_count)).toBe(result.record.imageCount);
    expect(rows[0]!.completed).toBe(true);
  });

  it('never records a publication — publish_ready stays separate from publishing', async () => {
    const runs = await bootstrap.raw.unsafe(`select count(*)::int as count from publish_runs`);
    expect(runs[0]?.count).toBe(0);
  });
});

describe('restart recovery — a second process resumes instead of redoing', () => {
  it('reloads the exact same record and regenerates nothing', async () => {
    const slotKey = '2026-10-12#R1';
    const before = processA.pipeline.get(slotKey);
    expect(before).not.toBeNull();

    const result = await restarted.pipeline.runSlot(slotKey);

    // Identity is unchanged: same generation run, same assets, same checksums.
    expect(result.record.generationRunId).toBe(before?.generationRunId);
    expect(result.record.imageCount).toBe(before?.imageCount);
    expect(result.record.assets.map((a) => a.assetId)).toEqual(
      before?.assets.map((a) => a.assetId),
    );
    expect(result.record.assets.map((a) => a.checksumSha256)).toEqual(
      before?.assets.map((a) => a.checksumSha256),
    );
    expect(result.record.stage).toBe('publish_ready');
  });

  it('a failed slot keeps its persisted image count and valid assets across a retry', async () => {
    const slotKey = '2026-10-12#R2';
    const first = await processA.pipeline.runSlot(slotKey);
    expect(first.record.stage).toBe('publish_ready');

    // Simulate a crash/failure AFTER the assets were durable.
    await bootstrap.raw.unsafe(
      `update slot_contents set stage = 'failed', last_error = $2, completed_at = null
       where slot_key = $1`,
      [slotKey, 'simulated provider timeout'],
    );
    // The restarted process must not believe its stale in-memory copy.
    const freshProcess = await startTestProcess();
    try {
      const retry = await freshProcess.pipeline.runSlot(slotKey);

      expect(retry.record.imageCount).toBe(first.record.imageCount);
      expect(retry.record.assets.map((a) => a.checksumSha256)).toEqual(
        first.record.assets.map((a) => a.checksumSha256),
      );
      expect(retry.record.stage).toBe('publish_ready');
      // Only ONE logical row per slot, ever.
      const rows = await bootstrap.raw.unsafe(
        `select count(*)::int as count from slot_contents where slot_key = $1`,
        [slotKey],
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await freshProcess.close();
    }
  });

  it('holds up under a database round-trip audit of every persisted stage field', async () => {
    const slotKey = '2026-10-12#R3';
    await processA.pipeline.runSlot(slotKey);

    const rows = await bootstrap.raw.unsafe(
      `select stage, attempts, image_count, image_count_chosen_at is not null as chosen,
              validation_passed, blockers, completed_at is not null as completed
       from slot_contents where slot_key = $1`,
      [slotKey],
    );
    const row = rows[0]!;
    expect(row.stage).toBe('publish_ready');
    expect(Number(row.attempts)).toBeGreaterThanOrEqual(1);
    expect(row.chosen).toBe(true);
    expect(row.completed).toBe(true);
    // Blockers are stored as a JSON document in a text column; whatever the
    // pipeline recorded must round-trip as a parseable array.
    expect(Array.isArray(JSON.parse(String(row.blockers)))).toBe(true);
  });
});

describe('database as the single source of truth', () => {
  it('two processes see the same slot through one row, not two copies', async () => {
    const slotKey = '2026-10-12#R4';
    const first = await processA.pipeline.runSlot(slotKey);

    // A process that starts AFTER the row exists (a restart) must load that
    // same record — the database, not this process' history, is the truth.
    const afterRestart = await startTestProcess();
    let fromOtherProcess;
    try {
      fromOtherProcess = afterRestart.pipeline.get(slotKey);
    } finally {
      await afterRestart.close();
    }

    expect(fromOtherProcess?.generationRunId).toBe(first.record.generationRunId);

    const rows = await bootstrap.raw.unsafe(
      `select count(*)::int as count from slot_contents where slot_key = $1`,
      [slotKey],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('keeps the persisted slot row free of image bytes', async () => {
    const rows = (await bootstrap.db.execute(
      sql`select coalesce(sum(length(assets::text)), 0)::int as bytes from slot_contents`,
    )) as unknown as Array<{ bytes: number }>;
    // Metadata only: a real image would be orders of magnitude larger.
    expect(rows[0]!.bytes).toBeLessThan(4096);
  });
});
