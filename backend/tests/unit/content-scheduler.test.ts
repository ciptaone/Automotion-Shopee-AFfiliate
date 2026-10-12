/**
 * PART 4 — scheduler → queue → pipeline integration.
 *
 * Covers: due-slot planning (60-minute interval, ≤24 slots/day), the paused
 * gate, bounded catch-up after downtime (NO posting burst), persistent and
 * idempotent job identities (no duplicate slots), terminal slots never being
 * re-run (no republish), skip-with-reason when no product is eligible,
 * precise failure reasons, continuing after recoverable failures, resuming an
 * interrupted job (same product, same image count, same asset identity),
 * stage progression, tick serialization, and the publisher boundary.
 *
 * Credential-free and deterministic: in-memory queue, injected clock, mock AI,
 * memory storage. No network, no paid call, NO publication — the pipeline has
 * no publisher dependency at all.
 */
import { describe, it, expect } from 'vitest';
import { ContentPipeline } from '../../src/automation/pipeline.js';
import { InMemorySlotStore, SlotContentStore } from '../../src/automation/slot-store.js';
import {
  InMemoryCatalogStore,
  ProductCatalog,
} from '../../src/catalog/catalog.js';
import { ShopeeFeedCsvImporter } from '../../src/integrations/feed/shopee-feed-importer.js';
import { MockCaptionGenerator, MockImageGenerator } from '../../src/integrations/ai/mock-ai.js';
import { MemoryObjectStorage } from '../../src/integrations/storage/object-storage.js';
import { SettingsService } from '../../src/settings/automation-settings.js';
import { InMemoryJobQueue } from '../../src/queue/job-queue.js';
import {
  CONTENT_JOB_KIND,
  CONTENT_WORKER_ID,
  ContentScheduler,
  contentJobKey,
  dueSlotsFor,
} from '../../src/scheduler/content-scheduler.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../../src/scheduler/slots.js';
import type { GeneratedImage, ImageGenerator } from '../../src/contracts/index.js';

/* -------------------------------------------------------------------------- */
/*  Synthetic feed fixtures (documented, synthetic test data only)            */
/* -------------------------------------------------------------------------- */

const importer = new ShopeeFeedCsvImporter();

const HEADERS = [
  'Item ID',
  'Name',
  'Product URL',
  'Affiliate Link',
  'Image URL',
  'Category',
  'Price',
  'Commission Rate',
  'Rating',
  'Sold',
];

function row(id: string, category: string, imageUrl = `https://cf.shopee.co.id/img/${id}.jpg`): string[] {
  return [
    id,
    `Synthetic Product ${id}`,
    `https://shopee.co.id/product/${id}`,
    `https://s.shopee.co.id/aff-${id}`,
    imageUrl,
    category,
    '100000',
    '10',
    '4.8',
    '500',
  ];
}

function csv(rows: string[][]): Uint8Array {
  return new TextEncoder().encode(rows.map((r) => r.join(',')).join('\n'));
}

async function buildCatalog(rows: string[][]): Promise<ProductCatalog> {
  const catalog = new ProductCatalog(new InMemoryCatalogStore());
  const parsed = await importer.parse({ filename: 'feed.csv', content: csv([HEADERS, ...rows]) });
  await catalog.importFeed(parsed, { filename: 'feed.csv', format: 'csv' });
  return catalog;
}

/* -------------------------------------------------------------------------- */
/*  Deterministic clock                                                       */
/* -------------------------------------------------------------------------- */

interface TestClock {
  now: () => Date;
  advanceMs: (ms: number) => void;
  set: (iso: string) => void;
}

function clockAt(iso: string): TestClock {
  let ms = Date.parse(iso);
  return {
    now: () => new Date(ms),
    advanceMs: (by) => {
      ms += by;
    },
    set: (next) => {
      ms = Date.parse(next);
    },
  };
}

/** 10:30 Asia/Jakarta on 2026-10-12 → slots #01..#11 (hours 0..10) are due. */
const START_ISO = '2026-10-12T10:30:00+07:00';
const DUE_SLOT_KEY = '2026-10-12#11';

/* -------------------------------------------------------------------------- */
/*  Test doubles                                                              */
/* -------------------------------------------------------------------------- */

/** Fails while `fail` is true; passes through to a real mock afterwards. */
class SwitchableImageGenerator implements ImageGenerator {
  readonly info = {
    name: 'switchable_image',
    kind: 'mock' as const,
    model: 'switchable-v1',
    ready: true,
    detail: 'Fails while the `fail` flag is set; mock otherwise.',
  };
  fail = true;
  constructor(private readonly inner: ImageGenerator = new MockImageGenerator()) {}
  async generate(request: Parameters<ImageGenerator['generate']>[0]): Promise<GeneratedImage> {
    if (this.fail) {
      throw new Error('simulated upstream provider outage');
    }
    return this.inner.generate(request);
  }
}

/** Fails only on the Nth generate() call (1-based), to force a partial run. */
class FailNthCallImageGenerator implements ImageGenerator {
  readonly info = {
    name: 'fail_nth_image',
    kind: 'mock' as const,
    model: 'fail-nth-v1',
    ready: true,
    detail: 'Fails on configured call numbers; mock otherwise.',
  };
  calls = 0;
  constructor(
    private readonly failAt: readonly number[],
    private readonly inner: ImageGenerator = new MockImageGenerator(),
  ) {}
  async generate(request: Parameters<ImageGenerator['generate']>[0]): Promise<GeneratedImage> {
    this.calls += 1;
    if (this.failAt.includes(this.calls)) {
      throw new Error('simulated upstream provider failure');
    }
    return this.inner.generate(request);
  }
}

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly scheduler: ContentScheduler;
  readonly queue: InMemoryJobQueue;
  readonly pipeline: ContentPipeline;
  readonly slots: SlotContentStore;
  readonly settings: SettingsService;
  readonly catalog: ProductCatalog;
  readonly clock: TestClock;
}

async function harness(
  options: {
    rows?: string[][];
    imagePolicy?: 'random_1_or_2' | 'one' | 'two';
    imageGenerator?: ImageGenerator;
    startIso?: string;
    maxCatchUpPerTick?: number;
    /** Leave automation paused (the default). */
    keepPaused?: boolean;
  } = {},
): Promise<Harness> {
  const rows = options.rows ?? [row('1', 'Health & Beauty'), row('2', 'Home & Living')];
  const catalog = await buildCatalog(rows);
  const slots = new SlotContentStore(new InMemorySlotStore());
  const settings = new SettingsService();
  await settings.update({ imageCountPolicy: options.imagePolicy ?? 'one' });
  if (!options.keepPaused) {
    await settings.control('start');
  }
  const clock = clockAt(options.startIso ?? START_ISO);
  // The queue MUST share the scheduler clock: claim() only returns jobs whose
  // scheduledFor has passed on the queue's own clock.
  const queue = new InMemoryJobQueue(clock.now);
  const pipeline = new ContentPipeline({
    catalog,
    slots,
    settings,
    imageGenerator: options.imageGenerator ?? new MockImageGenerator(),
    captionGenerator: new MockCaptionGenerator(),
    storage: new MemoryObjectStorage(),
  });
  const scheduler = new ContentScheduler({
    queue,
    pipeline,
    settings,
    schedulerConfig: () => DEFAULT_SCHEDULER_CONFIG,
    now: clock.now,
    ...(options.maxCatchUpPerTick !== undefined
      ? { maxCatchUpPerTick: options.maxCatchUpPerTick }
      : {}),
  });
  return { scheduler, queue, pipeline, slots, settings, catalog, clock };
}

/* ========================================================================== */
/*  Slot planning (pure)                                                      */
/* ========================================================================== */

describe('dueSlotsFor — due-slot planning', () => {
  it('returns today\'s slots whose instant has passed, oldest first', () => {
    const { due, today } = dueSlotsFor(DEFAULT_SCHEDULER_CONFIG, new Date(START_ISO));
    expect(today).toBe('2026-10-12');
    // Hours 0..10 inclusive are due at 10:30 local.
    expect(due).toHaveLength(11);
    expect(due[0]?.slot.key).toBe('2026-10-12#01');
    expect(due[10]?.slot.key).toBe(DUE_SLOT_KEY);
    for (let i = 1; i < due.length; i += 1) {
      expect(due[i]!.instantMs).toBeGreaterThan(due[i - 1]!.instantMs);
    }
  });

  it('honors the 60-minute interval exactly', () => {
    const { due } = dueSlotsFor(DEFAULT_SCHEDULER_CONFIG, new Date(START_ISO));
    const HOUR = 60 * 60 * 1000;
    for (let i = 1; i < due.length; i += 1) {
      expect(due[i]!.instantMs - due[i - 1]!.instantMs).toBe(HOUR);
    }
  });

  it('caps a day at 24 slots even when the clock is at 23:59', () => {
    const { due } = dueSlotsFor(
      DEFAULT_SCHEDULER_CONFIG,
      new Date('2026-10-12T23:59:00+07:00'),
    );
    expect(due).toHaveLength(24);
    expect(due[23]?.slot.key).toBe('2026-10-12#24');
  });

  it('never yields more than maxSlotsPerDay for a tighter config', () => {
    const config = { ...DEFAULT_SCHEDULER_CONFIG, maxSlotsPerDay: 6 };
    const { due } = dueSlotsFor(config, new Date('2026-10-12T23:59:00+07:00'));
    expect(due).toHaveLength(6);
  });

  it('is due only at or after the slot instant (never early)', () => {
    // 09:59 → hour 10 slot (#11) is not yet due.
    const { due } = dueSlotsFor(
      DEFAULT_SCHEDULER_CONFIG,
      new Date('2026-10-12T09:59:59+07:00'),
    );
    expect(due).toHaveLength(10);
    expect(due.some((d) => d.slot.key === DUE_SLOT_KEY)).toBe(false);
    // Exactly 10:00 → due.
    const at = dueSlotsFor(DEFAULT_SCHEDULER_CONFIG, new Date('2026-10-12T10:00:00+07:00'));
    expect(at.due.some((d) => d.slot.key === DUE_SLOT_KEY)).toBe(true);
  });
});

/* ========================================================================== */
/*  Job identity                                                              */
/* ========================================================================== */

describe('content scheduler — persistent job identity', () => {
  it('derives the uniqueKey as "content:<slotKey>" with the locked kind', () => {
    expect(contentJobKey('2026-10-12#11')).toBe('content:2026-10-12#11');
    expect(CONTENT_JOB_KIND).toBe('content_slot');
  });

  it('enqueues exactly one job per due slot under that identity', async () => {
    const h = await harness();
    const result = await h.scheduler.tick();
    expect(result.enqueued).toEqual([DUE_SLOT_KEY]);

    const job = await h.queue.getByUniqueKey(contentJobKey(DUE_SLOT_KEY));
    expect(job).not.toBeNull();
    expect(job?.kind).toBe(CONTENT_JOB_KIND);
    expect(await h.queue.list(50)).toHaveLength(1);
  });

  it('a second tick does NOT duplicate the job (queue uniqueness)', async () => {
    const h = await harness();
    await h.scheduler.tick();
    const first = await h.queue.getByUniqueKey(contentJobKey(DUE_SLOT_KEY));

    const second = await h.scheduler.tick();
    const again = await h.queue.getByUniqueKey(contentJobKey(DUE_SLOT_KEY));

    expect(second.enqueued).toEqual([]);
    expect(again?.id).toBe(first?.id);
    expect(await h.queue.list(50)).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  Gates                                                                     */
/* ========================================================================== */

describe('content scheduler — automation gate', () => {
  it('does nothing at all while automation is paused', async () => {
    const h = await harness({ keepPaused: true });
    const result = await h.scheduler.tick();

    expect(result.message).toMatch(/paused/i);
    expect(result.enqueued).toEqual([]);
    expect(result.executed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(await h.queue.list(50)).toHaveLength(0);
    expect(h.pipeline.get(DUE_SLOT_KEY)).toBeNull();
  });

  it('executes once automation is started', async () => {
    const h = await harness({ keepPaused: true });
    expect((await h.scheduler.tick()).executed).toEqual([]);
    await h.settings.control('start');
    const result = await h.scheduler.tick();
    expect(result.executed).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  Catch-up bounding after downtime                                          */
/* ========================================================================== */

describe('content scheduler — bounded catch-up (no posting burst)', () => {
  it('runs ONLY the most recent due slot and records the rest as skipped', async () => {
    // Clock far ahead: all 24 slots of the day are overdue.
    const h = await harness({ startIso: '2026-10-12T23:30:00+07:00' });
    const result = await h.scheduler.tick();

    expect(result.executed).toHaveLength(1);
    expect(result.enqueued).toEqual(['2026-10-12#24']);
    expect(result.skipped).toHaveLength(23);
    expect(result.skipped.every((s) => s.reason === 'catch_up_limited')).toBe(true);
    // The skipped slots were never enqueued: no back-fill flood.
    expect(await h.queue.list(50)).toHaveLength(1);
  });

  it('honors an explicit maxCatchUpPerTick > 1', async () => {
    const h = await harness({
      startIso: '2026-10-12T23:30:00+07:00',
      maxCatchUpPerTick: 2,
    });
    const result = await h.scheduler.tick();
    expect(result.executed).toHaveLength(2);
    expect(result.skipped).toHaveLength(22);
    expect(result.enqueued).toEqual(['2026-10-12#23', '2026-10-12#24']);
  });

  it('keeps at least one slot per tick even with a nonsensical bound', async () => {
    const h = await harness({ maxCatchUpPerTick: 0 });
    const result = await h.scheduler.tick();
    expect(result.executed).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  Execution → pipeline                                                      */
/* ========================================================================== */

describe('content scheduler — scheduler → pipeline execution', () => {
  it('drives a due slot all the way to publish_ready', async () => {
    const h = await harness();
    const result = await h.scheduler.tick();

    expect(result.executed).toHaveLength(1);
    expect(result.executed[0]).toMatchObject({
      slotKey: DUE_SLOT_KEY,
      stage: 'publish_ready',
      attempts: 1,
    });
    expect(result.executed[0]?.productId).not.toBeNull();
    expect(result.failed).toEqual([]);
    expect(result.pendingJobs).toBe(0);

    const job = await h.queue.getByUniqueKey(contentJobKey(DUE_SLOT_KEY));
    expect(job?.status).toBe('succeeded');

    const record = h.pipeline.get(DUE_SLOT_KEY);
    expect(record?.stage).toBe('publish_ready');
    expect(record?.validationPassed).toBe(true);
    expect(record?.referenceImageUrl).not.toBeNull();
    expect(record?.imageCount).toBeGreaterThanOrEqual(1);
    expect(record?.assets).toHaveLength(record?.imageCount ?? -1);
    expect(record?.captions.length).toBeGreaterThan(0);
  });

  it('advances reserved → generating_images → generating_captions → publish_ready', async () => {
    const stages: { where: string; stage: string | undefined }[] = [];
    const innerImage = new MockImageGenerator();
    const slots = new SlotContentStore(new InMemorySlotStore());
    const catalog = await buildCatalog([row('1', 'Health & Beauty')]);
    const settings = new SettingsService();
    await settings.update({ imageCountPolicy: 'one' });
    await settings.control('start');
    const clock = clockAt(START_ISO);

    const recordStage = (): string | undefined => slots.list(1)[0]?.stage;

    const imageGenerator: ImageGenerator = {
      info: innerImage.info,
      async generate(request) {
        stages.push({ where: 'image', stage: recordStage() });
        return innerImage.generate(request);
      },
    };
    const innerCaption = new MockCaptionGenerator();
    const pipeline = new ContentPipeline({
      catalog,
      slots,
      settings,
      imageGenerator,
      captionGenerator: {
        info: innerCaption.info,
        async generate(request) {
          stages.push({ where: 'caption', stage: recordStage() });
          return innerCaption.generate(request);
        },
      },
      storage: new MemoryObjectStorage(),
    });
    const queue = new InMemoryJobQueue(clock.now);
    const scheduler = new ContentScheduler({
      queue,
      pipeline,
      settings,
      schedulerConfig: () => DEFAULT_SCHEDULER_CONFIG,
      now: clock.now,
    });

    await scheduler.tick();

    expect(stages[0]).toEqual({ where: 'image', stage: 'generating_images' });
    expect(stages[1]).toEqual({ where: 'caption', stage: 'generating_captions' });
    expect(slots.list(1)[0]?.stage).toBe('publish_ready');
  });

  it('stops at publish_ready and NEVER publishes (no publisher is invoked)', async () => {
    const h = await harness();
    const result = await h.scheduler.tick();
    const allowed = new Set(['publish_ready', 'blocked', 'failed']);
    for (const outcome of result.executed) {
      expect(allowed.has(outcome.stage)).toBe(true);
    }
    expect(result.executed[0]?.stage).toBe('publish_ready');
    // Nothing in the job result claims a publication happened.
    const job = await h.queue.getByUniqueKey(contentJobKey(DUE_SLOT_KEY));
    expect(job?.status).toBe('succeeded');
  });

  it('an already publish_ready slot is skipped, never regenerated or republished', async () => {
    const h = await harness();
    await h.scheduler.tick();
    const before = h.pipeline.get(DUE_SLOT_KEY);
    expect(before?.stage).toBe('publish_ready');

    const second = await h.scheduler.tick();

    expect(second.executed).toEqual([]);
    expect(second.enqueued).toEqual([]);
    expect(second.skipped.some((s) => s.slotKey === DUE_SLOT_KEY)).toBe(true);

    const after = h.pipeline.get(DUE_SLOT_KEY);
    expect(after?.completedAt).toBe(before?.completedAt);
    expect(after?.attempts).toBe(before?.attempts);
    expect(after?.assets).toHaveLength(before?.assets.length ?? -1);
    expect(after?.generationRunId).toBe(before?.generationRunId);
  });

  it('skips the slot with an explicit reason when no product is eligible', async () => {
    // Every product lacks a reference image → nothing is selectable.
    const h = await harness({
      rows: [row('1', 'Health & Beauty', ''), row('2', 'Home & Living', '')],
    });
    const result = await h.scheduler.tick();

    expect(result.executed).toHaveLength(1);
    expect(result.executed[0]?.stage).toBe('blocked');
    expect(result.failed).toEqual([]);

    const record = h.pipeline.get(DUE_SLOT_KEY);
    expect(record?.stage).toBe('blocked');
    expect(record?.blockers[0]?.code).toMatch(/no_eligible_products/);
    expect(record?.assets).toHaveLength(0);
    expect(record?.captions).toHaveLength(0);

    // A blocked slot is terminal: its job completes rather than retrying.
    const job = await h.queue.getByUniqueKey(contentJobKey(DUE_SLOT_KEY));
    expect(job?.status).toBe('succeeded');
    expect(result.pendingJobs).toBe(0);
  });
});

/* ========================================================================== */
/*  Failure handling                                                          */
/* ========================================================================== */

describe('content scheduler — recoverable failures', () => {
  it('records a precise failure reason and reschedules with backoff', async () => {
    const h = await harness({ imageGenerator: new SwitchableImageGenerator() });
    const result = await h.scheduler.tick();

    expect(result.executed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.slotKey).toBe(DUE_SLOT_KEY);
    expect(result.failed[0]?.stage).toBe('failed');
    expect(result.pendingJobs).toBe(1);

    const record = h.pipeline.get(DUE_SLOT_KEY);
    expect(record?.stage).toBe('failed');
    expect(record?.lastError).toMatch(/Image generation failed at position 1/);

    const job = await h.queue.getByUniqueKey(contentJobKey(DUE_SLOT_KEY));
    expect(job?.status).toBe('pending'); // retryable → backoff, not terminal
    expect(job?.lastError).toMatch(/Image generation failed at position 1/);
  });

  it('keeps scheduling FUTURE slots after a failure (does not stop the loop)', async () => {
    // Fails ONLY its first call: slot #11 fails, everything after recovers.
    const h = await harness({ imageGenerator: new FailNthCallImageGenerator([1]) });
    const first = await h.scheduler.tick();
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]?.slotKey).toBe(DUE_SLOT_KEY);

    // Next hour: the backoff has elapsed, so the failed slot is retried AND a
    // brand-new slot is planned — the loop keeps going after a failure.
    h.clock.set('2026-10-12T11:30:00+07:00');
    const second = await h.scheduler.tick();

    expect(second.enqueued).toContain('2026-10-12#12');
    expect(second.failed).toEqual([]);
    expect(second.executed.map((e) => e.slotKey)).toEqual([
      DUE_SLOT_KEY,
      '2026-10-12#12',
    ]);
    expect(second.executed.every((e) => e.stage === 'publish_ready')).toBe(true);
    expect(second.pendingJobs).toBe(0);
  });

  it('resumes the interrupted job and reuses the SAME product and image count', async () => {
    const generator = new SwitchableImageGenerator();
    const h = await harness({ imageGenerator: generator, imagePolicy: 'two' });

    const first = await h.scheduler.tick();
    expect(first.failed).toHaveLength(1);
    const failedRecord = h.pipeline.get(DUE_SLOT_KEY);
    expect(failedRecord?.stage).toBe('failed');
    expect(failedRecord?.productId).not.toBeNull();
    expect(failedRecord?.imageCount).toBe(2);
    expect(failedRecord?.assets).toHaveLength(0);

    // Provider recovers; backoff (30s) has elapsed.
    generator.fail = false;
    h.clock.advanceMs(60_000);
    const second = await h.scheduler.tick();

    expect(second.failed).toEqual([]);
    expect(second.executed).toHaveLength(1);
    expect(second.executed[0]?.stage).toBe('publish_ready');
    expect(second.executed[0]?.productId).toBe(failedRecord?.productId);

    const resumed = h.pipeline.get(DUE_SLOT_KEY);
    expect(resumed?.imageCount).toBe(2); // never re-chosen on retry
    expect(resumed?.assets).toHaveLength(2);
    expect(resumed?.attempts).toBeGreaterThan(1);
    expect(second.pendingJobs).toBe(0);
  });

  it('reuses already-valid assets on retry (stable identity, no regeneration)', async () => {
    // Image 1 succeeds, image 2 fails → a partial slot.
    const generator = new FailNthCallImageGenerator([2]);
    const h = await harness({ imageGenerator: generator, imagePolicy: 'two' });

    const first = await h.scheduler.tick();
    expect(first.failed).toHaveLength(1);

    const partial = h.pipeline.get(DUE_SLOT_KEY);
    expect(partial?.assets).toHaveLength(1);
    const keptAssetId = partial?.assets[0]?.assetId;
    const keptChecksum = partial?.assets[0]?.checksumSha256;
    expect(keptAssetId).toBeDefined();
    expect(keptChecksum).toBeDefined();

    // Retry: only the SECOND image is generated; the first is reused as-is.
    h.clock.advanceMs(60_000);
    const second = await h.scheduler.tick();

    expect(second.executed[0]?.stage).toBe('publish_ready');
    const done = h.pipeline.get(DUE_SLOT_KEY);
    expect(done?.assets).toHaveLength(2);
    expect(done?.assets[0]?.assetId).toBe(keptAssetId);
    expect(done?.assets[0]?.checksumSha256).toBe(keptChecksum);
    expect(done?.assets[1]?.checksumSha256).not.toBe(keptChecksum);
  });

  it('a slot that throws inside the pipeline is failed, not lost', async () => {
    const h = await harness();
    // Force runSlot to throw by pointing the queue at a non-existent kind.
    const originalRunSlot = h.pipeline.runSlot.bind(h.pipeline);
    h.pipeline.runSlot = (async () => {
      throw new Error('boom inside pipeline');
    }) as typeof h.pipeline.runSlot;

    const result = await h.scheduler.tick();
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.stage).toBe('failed');
    expect(result.failed[0]?.productId).toBeNull();

    const job = await h.queue.getByUniqueKey(contentJobKey(DUE_SLOT_KEY));
    expect(job?.status).toBe('pending');
    expect(job?.lastError).toMatch(/boom inside pipeline/);

    h.pipeline.runSlot = originalRunSlot;
  });
});

/* ========================================================================== */
/*  Interrupted job recovery across a scheduler restart                       */
/* ========================================================================== */

describe('content scheduler — interrupted job recovery', () => {
  it('a job enqueued by a previous (interrupted) run is picked up and executed', async () => {
    const h = await harness();
    // Simulate a crash AFTER enqueue but BEFORE execution.
    await h.queue.enqueue({
      kind: CONTENT_JOB_KIND,
      uniqueKey: contentJobKey(DUE_SLOT_KEY),
      scheduledFor: new Date('2026-10-12T10:00:00+07:00').toISOString(),
      payload: { slotKey: DUE_SLOT_KEY },
      maxAttempts: 3,
    });
    expect(h.pipeline.get(DUE_SLOT_KEY)).toBeNull();

    // A fresh scheduler over the same queue completes the work exactly once.
    const result = await h.scheduler.tick();
    expect(result.executed).toEqual([
      expect.objectContaining({ slotKey: DUE_SLOT_KEY, stage: 'publish_ready' }),
    ]);
    // Enqueue is idempotent: the key is re-confirmed, but no second job exists.
    expect(result.enqueued).toEqual([DUE_SLOT_KEY]);
    expect(await h.queue.list(50)).toHaveLength(1);
    expect(h.pipeline.get(DUE_SLOT_KEY)?.stage).toBe('publish_ready');
  });
});

/* ========================================================================== */
/*  Tick serialization                                                        */
/* ========================================================================== */

describe('content scheduler — tick serialization', () => {
  it('an overlapping tick is a no-op instead of racing the first', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = new MockImageGenerator();
    const slow: ImageGenerator = {
      info: inner.info,
      async generate(request) {
        await gate;
        return inner.generate(request);
      },
    };
    const h = await harness({ imageGenerator: slow });

    const first = h.scheduler.tick();
    const overlapping = await h.scheduler.tick();

    expect(overlapping.message).toMatch(/already in progress/i);
    expect(overlapping.executed).toEqual([]);
    expect(overlapping.enqueued).toEqual([]);

    release?.();
    const completed = await first;
    expect(completed.executed).toHaveLength(1);
    expect(h.pipeline.get(DUE_SLOT_KEY)?.stage).toBe('publish_ready');
  });
});

/* ========================================================================== */
/*  Introspection used by the status endpoint                                 */
/* ========================================================================== */

describe('content scheduler — introspection', () => {
  it('exposes the last tick and the catch-up bound', async () => {
    const h = await harness({ maxCatchUpPerTick: 3 });
    expect(h.scheduler.peekLastTick()).toBeNull();
    expect(h.scheduler.catchUpLimit).toBe(3);

    const result = await h.scheduler.tick();
    expect(h.scheduler.peekLastTick()).toEqual(result);
  });

  it('reports the worker id used for atomic claims', () => {
    expect(CONTENT_WORKER_ID).toBe('content-scheduler');
  });
});
