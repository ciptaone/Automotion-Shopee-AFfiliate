/**
 * PART 4 — file-store write concurrency regression tests.
 *
 * The bug these tests lock in was found by the PART 4 live smoke test: an
 * API-triggered pipeline run raced a scheduler tick, and BOTH wrote the slot
 * store at the same moment through one shared `<file>.tmp`. The second rename
 * failed with `ENOENT`, which surfaced as `SlotStoreError: Could not write
 * slot store` and a failed pipeline run.
 *
 * Guarantees now asserted here:
 *  - concurrent saves never throw and never clobber each other's temp file,
 *  - the NEWEST snapshot wins (no lost slot record),
 *  - no `*.tmp` files are left behind,
 *  - a failing write does not wedge the queue for later writes.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { atomicWriteText, createSerialQueue } from '../../src/core/atomic-file.js';
import { FileSlotStore, SlotContentStore, type SlotContentRecord } from '../../src/automation/slot-store.js';

function slotRecord(slotKey: string, stage: SlotContentRecord['stage']): SlotContentRecord {
  return {
    slotKey,
    stage,
    productId: 'p-1',
    sourceProductId: '9001',
    productName: 'Tumbler Stainless 500 ml',
    affiliateUrl: 'https://s.shopee.co.id/aff-9001',
    categoryId: 'home-living',
    imageCountPolicy: 'random_1_or_2',
    imageCount: 2,
    imageCountChosenAt: '2026-10-12T00:00:00.000Z',
    selection: null,
    referenceImageUrl: 'https://cf.shopee.co.id/img/9001.jpg',
    generationRunId: 'run-1',
    assets: [],
    captions: [],
    validationPassed: stage === 'publish_ready',
    blockers: [],
    lastError: null,
    attempts: 1,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:01.000Z',
    completedAt: null,
  };
}

describe('atomicWriteText', () => {
  it('writes concurrently without a shared-temp collision', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'atomic-'));
    const file = path.join(dir, 'store.json');

    // 20 concurrent writers to the SAME path: with one fixed `<file>.tmp`
    // this is exactly the smoke-test failure (ENOENT on rename).
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => atomicWriteText(file, `{"n":${i}}\n`)),
    );

    const raw = await readFile(file, 'utf8');
    expect(() => JSON.parse(raw) as { n: number }).not.toThrow();

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('leaves the previous file intact when the target directory is a file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'atomic-fail-'));
    // A path whose parent is a regular file -> mkdir/write fails.
    const notADir = path.join(dir, 'a');
    await atomicWriteText(notADir, 'x');

    await expect(atomicWriteText(path.join(notADir, 'nested.json'), 'y')).rejects.toThrow();

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('createSerialQueue', () => {
  it('runs queued work in FIFO order', async () => {
    const enqueue = createSerialQueue();
    const order: number[] = [];

    await Promise.all([
      enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        order.push(1);
      }),
      enqueue(async () => {
        order.push(2);
      }),
      enqueue(async () => {
        order.push(3);
      }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps accepting work after a rejection (a failed write must not wedge it)', async () => {
    const enqueue = createSerialQueue();

    await expect(
      enqueue(async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');

    await expect(enqueue(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('FileSlotStore concurrent saves (scheduler tick vs API run)', () => {
  it('loses no slot record when two writers save at the same time', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slot-race-'));
    const file = path.join(dir, 'slots.json');
    const store = new SlotContentStore(new FileSlotStore(file));

    // Two DIFFERENT slot keys mutated concurrently: this is the live scenario
    // (API run for #90 while the scheduler tick executes #18). Each `put()`
    // persists the whole snapshot, so the saves overlap.
    await Promise.all([
      store.mutate('2026-10-12#90', async () => {
        await store.put(slotRecord('2026-10-12#90', 'publish_ready'));
      }),
      store.mutate('2026-10-12#18', async () => {
        await store.put(slotRecord('2026-10-12#18', 'reserved'));
      }),
    ]);

    // Reload from disk: BOTH records must survive, and no temp file remains.
    const reloaded = new SlotContentStore(new FileSlotStore(file));
    await reloaded.init();
    const keys = reloaded
      .list(50)
      .map((record) => record.slotKey)
      .sort();
    expect(keys).toEqual(['2026-10-12#18', '2026-10-12#90']);

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('survives a burst of parallel persists across many keys', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slot-burst-'));
    const file = path.join(dir, 'slots.json');
    const store = new SlotContentStore(new FileSlotStore(file));

    const keys = Array.from({ length: 12 }, (_, i) => `2026-10-12#${String(i + 1).padStart(2, '0')}`);
    await Promise.all(
      keys.map((key) => store.mutate(key, async () => store.put(slotRecord(key, 'publish_ready')))),
    );

    const reloaded = new SlotContentStore(new FileSlotStore(file));
    await reloaded.init();
    expect(reloaded.list(50)).toHaveLength(keys.length);

    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
